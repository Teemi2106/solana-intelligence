import process from "node:process";
import { HeliusBlockchainProvider, HeliusRpcClient } from "@swi/blockchain";
import { createDatabase } from "@swi/db";
import { createHistoricalPriceProvider } from "../apps/worker/src/price-provider.js";
import { processWalletAccounting } from "../apps/worker/src/wallet-accounting.js";
import { ensureTokenLaunchFacts, updateWalletIntelligence } from "../apps/worker/src/wallet-intelligence.js";
import { ingestWalletHistoryPage } from "@swi/ingestion";

const address = process.argv[2];
const databaseUrl = process.env.DATABASE_URL;
const apiKey = process.env.HELIUS_API_KEY;
if (!address) throw new Error("Usage: npm run wallet:reprocess -- <wallet-address>");
if (!databaseUrl || !apiKey) throw new Error("DATABASE_URL and HELIUS_API_KEY are required");

const database = createDatabase(databaseUrl);
try {
  const [wallet] = await database.sql`select id from tracked_wallets where address = ${address} limit 1`;
  if (!wallet) throw new Error("Tracked wallet was not found");
  const [run] = await database.sql`select id from wallet_ingestion_runs where wallet_id = ${wallet.id} order by created_at desc limit 1`;
  if (!run) throw new Error("Wallet ingestion run was not found");

  await database.sql.begin(async (sql) => {
    await sql`delete from wallet_classification_evidence where transaction_id in (select id from wallet_transactions where wallet_id = ${wallet.id})`;
    await sql`delete from wallet_realizations where wallet_id = ${wallet.id}`;
    await sql`delete from wallet_inventory_lots where wallet_id = ${wallet.id}`;
    await sql`delete from wallet_positions where wallet_id = ${wallet.id}`;
    await sql`delete from wallet_performance_snapshots where wallet_id = ${wallet.id}`;
    await sql`delete from wallet_scores where wallet_id = ${wallet.id}`;
    await sql`delete from wallet_classifications where wallet_id = ${wallet.id}`;
    await sql`delete from wallet_transactions where wallet_id = ${wallet.id}`;
    await sql`delete from provider_events where external_event_id like ${`history:${wallet.id}:%`}`;
    await sql`update wallet_ingestion_runs set status = 'PENDING', cursor = null, pages_processed = 0, transactions_seen = 0, transactions_stored = 0, started_at = null, completed_at = null, heartbeat_at = null, last_error_code = null, updated_at = now() where id = ${run.id}`;
    await sql`update wallet_ingestion_checkpoints set cursor = null, oldest_slot = null, newest_slot = null, completed = false, updated_at = now() where wallet_id = ${wallet.id}`;
  });

  const provider = new HeliusBlockchainProvider({ apiKey, timeoutMs: 30_000 });
  let completed = false;
  let pages = 0;
  while (!completed) {
    const result = await ingestWalletHistoryPage({ database, provider }, { walletId: wallet.id, runId: run.id });
    completed = result.completed;
    pages += 1;
    console.log(JSON.stringify({ page: pages, completed }));
  }
  const asOf = new Date();
  const report = await processWalletAccounting({ database, prices: createHistoricalPriceProvider(database) }, wallet.id, asOf);
  const enrichment = await ensureTokenLaunchFacts({ database, provider: new HeliusRpcClient({ apiKey }) }, report.accounting.evidenceInputs.tokenMints, { limit: 1_000 });
  const intelligence = await updateWalletIntelligence({ database }, { walletId: wallet.id, address, windows: report.accounting.windows, evidenceInputs: report.accounting.evidenceInputs, asOf });
  const accounting = { ...report.accounting, evidenceInputs: undefined };
  console.log(JSON.stringify({ pricing: report.pricing, accounting, enrichment, intelligence }, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Wallet reprocessing failed");
  process.exitCode = 1;
} finally {
  await database.close();
}

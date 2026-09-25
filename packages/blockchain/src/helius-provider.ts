import { jitoTipAccounts, WRAPPED_SOL_MINT, type BlockchainProvider, type HistoricalSettlementFacts, type HistoricalTokenFlow, type HistoricalWalletTransaction, type HealthCheck, type TokenMint, type TransactionSignature, type WalletAddress } from "@swi/domain";
import { ProviderRequestError } from "./errors";
import { heliusHistoryResponse, type HeliusTransaction } from "./helius-schemas";

export interface HeliusProviderOptions {
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly baseUrl?: string;
}

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export class HeliusBlockchainProvider implements BlockchainProvider {
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(private readonly options: HeliusProviderOptions) {
    this.request = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.baseUrl = options.baseUrl ?? "https://api.helius.xyz";
  }

  async getWalletHistory(address: WalletAddress, options: { cursor?: string; limit?: number } = {}): Promise<{ transactions: readonly HistoricalWalletTransaction[]; nextCursor?: string }> {
    const limit = Math.min(options.limit ?? 100, 100);
    const url = new URL(`/v0/addresses/${encodeURIComponent(address)}/transactions`, this.baseUrl);
    url.searchParams.set("api-key", this.options.apiKey);
    url.searchParams.set("limit", String(limit));
    if (options.cursor) url.searchParams.set("before", options.cursor);
    const response = await this.fetchWithRetry(url);
    const parsed = heliusHistoryResponse.safeParse(await response.json());
    if (!parsed.success) throw new ProviderRequestError("Helius returned an invalid transaction page", "INVALID_RESPONSE", false);
    const transactions = parsed.data.map((transaction) => normalizeHeliusTransaction(address, transaction));
    const last = parsed.data.at(-1);
    return { transactions, ...(parsed.data.length === limit && last ? { nextCursor: last.signature } : {}) };
  }

  async checkHealth(): Promise<HealthCheck> {
    const started = performance.now();
    try {
      const response = await this.request(`${this.baseUrl}/?api-key=${encodeURIComponent(this.options.apiKey)}`, { method: "HEAD", signal: AbortSignal.timeout(this.timeoutMs) });
      return { name: "helius", status: response.ok ? "up" : "down", latencyMs: Math.round(performance.now() - started) };
    } catch {
      return { name: "helius", status: "down", latencyMs: Math.round(performance.now() - started) };
    }
  }

  private async fetchWithRetry(url: URL): Promise<Response> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.request(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(this.timeoutMs) });
        if (response.ok) return response;
        if (response.status === 401 || response.status === 403) throw new ProviderRequestError("Helius authentication failed", "UNAUTHORIZED", false);
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        if (response.status !== 429 && response.status < 500) throw new ProviderRequestError(`Helius request failed with ${String(response.status)}`, "INVALID_RESPONSE", false);
        if (attempt === 2) throw new ProviderRequestError("Helius is temporarily unavailable", response.status === 429 ? "RATE_LIMITED" : "UNAVAILABLE", true, retryAfter);
        await sleep(retryAfter ?? (2 ** attempt) * 250);
      } catch (error) {
        if (error instanceof ProviderRequestError) throw error;
        if (attempt === 2) throw new ProviderRequestError("Helius request timed out", "TIMEOUT", true, undefined);
      }
    }
    throw new ProviderRequestError("Helius request failed", "UNAVAILABLE", true);
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export function normalizeHeliusTransaction(wallet: WalletAddress, transaction: HeliusTransaction): HistoricalWalletTransaction {
  const issues: string[] = [];
  const tokenFlows: HistoricalTokenFlow[] = [];
  for (const account of transaction.accountData) {
    for (const change of account.tokenBalanceChanges) {
      if (change.userAccount !== wallet) continue;
      const amount = BigInt(change.rawTokenAmount.tokenAmount);
      if (amount === 0n) continue;
      tokenFlows.push({
        mint: change.mint as TokenMint,
        direction: amount > 0n ? "IN" : "OUT",
        rawAmount: amount > 0n ? amount : -amount,
        decimals: change.rawTokenAmount.decimals,
        account: change.tokenAccount,
        counterparty: null,
      });
    }
  }
  // Older Enhanced Transaction fixtures may contain precise raw transfer values
  // without account balance changes. Never derive ledger amounts from tokenAmount,
  // because that field has already passed through a JavaScript number.
  if (tokenFlows.length === 0) for (const transfer of transaction.tokenTransfers) {
    if (!transfer.rawTokenAmount) continue;
    const inbound = transfer.toUserAccount === wallet;
    const outbound = transfer.fromUserAccount === wallet;
    if (inbound === outbound) continue;
    tokenFlows.push({
      mint: transfer.mint as TokenMint,
      direction: inbound ? "IN" : "OUT",
      rawAmount: BigInt(transfer.rawTokenAmount.tokenAmount),
      decimals: transfer.rawTokenAmount.decimals,
      account: (inbound ? transfer.toTokenAccount : transfer.fromTokenAccount) ?? null,
      counterparty: (inbound ? transfer.fromUserAccount : transfer.toUserAccount) ?? null,
    });
  }
  // Fill in who the other side of a token movement was, when exactly one provider transfer matches it.
  for (const [index, flow] of tokenFlows.entries()) {
    if (flow.counterparty !== null) continue;
    const matches = transaction.tokenTransfers.filter((transfer) => transfer.mint === flow.mint && (flow.direction === "IN" ? transfer.toUserAccount === wallet : transfer.fromUserAccount === wallet));
    const [only] = matches;
    const counterparty = only ? (flow.direction === "IN" ? only.fromUserAccount : only.toUserAccount) ?? null : null;
    if (matches.length === 1 && counterparty) tokenFlows[index] = { ...flow, counterparty };
  }
  const walletAccount = transaction.accountData.find((account) => account.account === wallet);
  const nativeSolDeltaLamports = walletAccount
    ? BigInt(walletAccount.nativeBalanceChange)
    : transaction.nativeTransfers.reduce((sum, transfer) => sum + BigInt(transfer.toUserAccount === wallet ? transfer.amount : 0) - BigInt(transfer.fromUserAccount === wallet ? transfer.amount : 0), 0n);
  if (transaction.type === "SWAP" && tokenFlows.length === 0) issues.push("NO_WALLET_TOKEN_FLOW");
  const settlement = extractSettlementFacts(wallet, transaction);
  return {
    signature: transaction.signature as TransactionSignature,
    slot: BigInt(transaction.slot),
    occurredAt: new Date(transaction.timestamp * 1000),
    succeeded: transaction.transactionError == null,
    providerType: transaction.type,
    feeLamports: BigInt(transaction.fee),
    feePayerIsWallet: transaction.feePayer === wallet,
    tokenFlows,
    nativeSolDeltaLamports,
    source: "helius-enhanced-transactions",
    settlement,
    quality: issues.length === 0 ? "HIGH" : "LOW",
    issues,
  };
}

/**
 * Separates swap consideration from rent, tips and counterparty ledgers using exact integer balance changes.
 * - Rent: native lamports of wallet-owned token accounts (minus any wSOL principal they hold).
 * - wSOL rail: what non-wallet accounts gained/lost in wSOL, an exact mirror of the wallet's wSOL exposure
 *   even when the wallet's temporary wSOL account is created and closed inside the transaction.
 * - Tips: native transfers from the wallet to known bundle-tip accounts.
 */
export function extractSettlementFacts(wallet: WalletAddress, transaction: HeliusTransaction): HistoricalSettlementFacts {
  let walletTokenAccountRentLamports = 0n;
  let counterpartyWsolDeltaLamports: bigint | null = null;
  const movedMints = new Set<string>();
  for (const account of transaction.accountData) {
    let walletOwned = false;
    let walletWsol = 0n;
    for (const change of account.tokenBalanceChanges) {
      movedMints.add(change.mint);
      const amount = BigInt(change.rawTokenAmount.tokenAmount);
      if (change.userAccount === wallet) {
        walletOwned = true;
        if (change.mint === WRAPPED_SOL_MINT) walletWsol += amount;
      } else if (change.mint === WRAPPED_SOL_MINT) {
        counterpartyWsolDeltaLamports = (counterpartyWsolDeltaLamports ?? 0n) + amount;
      }
    }
    if (walletOwned && account.account !== wallet) walletTokenAccountRentLamports += BigInt(account.nativeBalanceChange) - walletWsol;
  }
  for (const transfer of transaction.tokenTransfers) movedMints.add(transfer.mint);
  const tipLamports = transaction.nativeTransfers.reduce((sum, transfer) => (transfer.fromUserAccount === wallet && transfer.toUserAccount && jitoTipAccounts.has(transfer.toUserAccount) ? sum + BigInt(transfer.amount) : sum), 0n);
  return { venue: transaction.source ?? null, walletTokenAccountRentLamports, counterpartyWsolDeltaLamports, tipLamports, movedMints: [...movedMints].sort() };
}

/** Every address that appears as a party to the transaction; used to find which tracked wallets it concerns. */
export function involvedAddresses(transaction: HeliusTransaction): Set<string> {
  const addresses = new Set<string>();
  for (const account of transaction.accountData) {
    addresses.add(account.account);
    for (const change of account.tokenBalanceChanges) if (change.userAccount) addresses.add(change.userAccount);
  }
  for (const transfer of transaction.nativeTransfers) {
    if (transfer.fromUserAccount) addresses.add(transfer.fromUserAccount);
    if (transfer.toUserAccount) addresses.add(transfer.toUserAccount);
  }
  for (const transfer of transaction.tokenTransfers) {
    if (transfer.fromUserAccount) addresses.add(transfer.fromUserAccount);
    if (transfer.toUserAccount) addresses.add(transfer.toUserAccount);
  }
  if (transaction.feePayer) addresses.add(transaction.feePayer);
  return addresses;
}

import { listTrackedWallets } from "@swi/db";
import { getDatabase } from "../../../lib/database";
import { WalletForm } from "./wallet-form";
import { WalletManager } from "./wallet-manager";

export const dynamic = "force-dynamic";

export default async function WalletsPage() {
  const trackedWallets = await listTrackedWallets(getDatabase());
  const wallets = trackedWallets.filter(
    (wallet): wallet is (typeof trackedWallets)[number] & { status: "ACTIVE" | "PAUSED" } =>
      wallet.status !== "ARCHIVED",
  );
  return <section className="grid gap-6">
    <header>
      <p className="font-mono text-xs uppercase tracking-widest text-[var(--accent)]">Wallet intelligence</p>
      <h1 className="mt-1 text-2xl font-semibold">Tracked wallets</h1>
      <p className="mt-2 text-sm text-[var(--muted)]">Scores rank evidence quality and repeatability; they are not probabilities.</p>
    </header>
    <WalletForm />
    {wallets.length === 0
      ? <p className="rounded border border-[var(--border)] bg-[var(--panel)] p-8 text-center text-sm text-[var(--muted)]">No wallets are tracked. Add a public address to begin historical ingestion.</p>
      : <WalletManager wallets={wallets.map((wallet) => ({ id: wallet.id, address: wallet.address, displayName: wallet.displayName, status: wallet.status, labels: wallet.labels.map((item) => item.label), ingestionStatus: wallet.ingestion?.status ?? null, transactionsStored: wallet.ingestion?.transactionsStored ?? null, score: wallet.score?.value ?? null, classification: wallet.classification?.classification ?? null }))} />}
  </section>;
}

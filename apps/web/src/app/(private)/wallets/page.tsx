import Link from "next/link";
import type { Route } from "next";
import { listTrackedWallets } from "@swi/db";
import { getDatabase } from "../../../lib/database";
import { WalletForm } from "./wallet-form";

export const dynamic = "force-dynamic";

export default async function WalletsPage() {
  const wallets = await listTrackedWallets(getDatabase());
  return (
    <section className="grid gap-6">
      <header>
        <p className="font-mono text-xs uppercase tracking-widest text-[var(--accent)]">
          Wallet intelligence
        </p>
        <h1 className="mt-1 text-2xl font-semibold">Tracked wallets</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Scores rank evidence quality and repeatability; they are not
          probabilities.
        </p>
      </header>
      <WalletForm />
      <div className="overflow-hidden rounded border border-[var(--border)] bg-[var(--panel)]">
        {wallets.length === 0 ? (
          <p className="p-8 text-center text-sm text-[var(--muted)]">
            No wallets are tracked. Add a public address to begin historical
            ingestion.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-[var(--muted)]">
              <tr>
                <th className="p-3">Wallet</th>
                <th>Status</th>
                <th>Ingestion</th>
                <th>Score</th>
                <th>Classification</th>
              </tr>
            </thead>
            <tbody>
              {wallets.map((wallet) => (
                <tr key={wallet.id} className="border-t border-[var(--border)]">
                  <td className="p-3">
                    <Link
                      href={`/wallets/${wallet.address}` as Route}
                      className="font-mono text-[var(--accent)]"
                    >
                      {wallet.displayName ??
                        `${wallet.address.slice(0, 8)}…${wallet.address.slice(-6)}`}
                    </Link>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      {wallet.labels.map((item) => item.label).join(" · ") ||
                        "No labels"}
                    </p>
                  </td>
                  <td>{wallet.status}</td>
                  <td>
                    {wallet.ingestion?.status ?? "NOT STARTED"}
                    {wallet.ingestion ? (
                      <p className="text-xs text-[var(--muted)]">
                        {wallet.ingestion.transactionsStored} stored
                      </p>
                    ) : null}
                  </td>
                  <td>
                    {wallet.score ? `${String(wallet.score.value)}/100` : "—"}
                  </td>
                  <td className="text-xs">
                    {wallet.classification?.classification.replaceAll(
                      "_",
                      " ",
                    ) ?? "INSUFFICIENT EVIDENCE"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

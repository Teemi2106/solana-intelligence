import { notFound } from "next/navigation";
import { getWalletActivity, getWalletDetail, getWalletLiveState } from "@swi/db";
import { getDatabase } from "../../../../lib/database";
import { explorerTransactionUrl, formatUnits, formatUsd } from "../../../../lib/format";
import { getServerConfig } from "../../../../lib/server-config";

export const dynamic = "force-dynamic";

export default async function WalletDetailPage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  const detail = await getWalletDetail(getDatabase(), address);
  if (!detail) notFound();
  const [activity, liveState] = await Promise.all([getWalletActivity(getDatabase(), detail.wallet.id, 25), getWalletLiveState(getDatabase(), detail.wallet.id)]);
  const liveEnabled = getServerConfig().ENABLE_LIVE_INGESTION;
  const currentScore = detail.scores[0];
  const currentClass = detail.classifications[0];
  return (
    <section className="grid gap-6">
      <header>
        <p className="font-mono text-xs uppercase tracking-widest text-[var(--accent)]">
          {detail.wallet.status} ·{" "}
          {detail.labels.map((label) => label.label).join(" · ") || "UNLABELED"}
        </p>
        <h1 className="mt-1 text-xl font-semibold">
          {detail.wallet.displayName ?? "Tracked wallet"}
        </h1>
        <p className="mt-2 break-all font-mono text-sm text-[var(--muted)]">
          {detail.wallet.address}
        </p>
      </header>
      <div className="grid gap-px overflow-hidden rounded border border-[var(--border)] bg-[var(--border)] md:grid-cols-4">
        {[
          ["Score", currentScore ? `${String(currentScore.score.value)}/100` : "—"],
          [
            "Classification",
            currentClass?.classification.replaceAll("_", " ") ??
              "INSUFFICIENT EVIDENCE",
          ],
          ["Data quality", currentScore?.score.quality ?? "INSUFFICIENT"],
          ["Ingestion", detail.runs[0]?.status ?? "NOT STARTED"],
        ].map(([label, value]) => (
          <article key={label} className="bg-[var(--panel)] p-4">
            <p className="text-xs uppercase text-[var(--muted)]">{label}</p>
            <p className="mt-2 text-sm font-semibold">{value}</p>
          </article>
        ))}
      </div>
      <Panel title="Live activity">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-[var(--border)] px-4 py-3 text-xs text-[var(--muted)]">
          <span>Live ingestion: <strong className="text-[var(--foreground)]">{liveEnabled ? "enabled" : "disabled"}</strong></span>
          <span>Provider watching: {liveState?.providerConfirmedAt ? "confirmed " + liveState.providerConfirmedAt.toISOString() : "not confirmed"}</span>
          <span>Last live event: {liveState?.lastEventAt ? liveState.lastEventAt.toISOString() : "none"}</span>
          <span>Last gap check: {liveState?.lastBackfillAt ? liveState.lastBackfillAt.toISOString() + " (" + (liveState.lastBackfillStatus ?? "?") + ")" : "never"}</span>
        </div>
        {activity.length === 0 ? (
          <Empty text="No activity has been observed for this wallet yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-[var(--muted)]">
                <tr><th className="p-3">Time (UTC)</th><th>Type</th><th>Token</th><th>Amount</th><th>Consideration</th><th>Pricing</th><th>Finality</th><th>Source</th><th>Processing</th><th /></tr>
              </thead>
              <tbody>
                {activity.map((row) => (
                  <tr key={row.transactionId} className="border-t border-[var(--border)]">
                    <td className="p-3 font-mono text-xs">{row.occurredAt.toISOString().replace("T", " ").slice(0, 19)}</td>
                    <td>{row.side ?? (row.kind === "TRANSFER" ? "TRANSFER" : "UNKNOWN")}{row.routed ? " · routed" : ""}</td>
                    <td className="font-mono">{row.tokenSymbol ?? (row.tokenMint ? row.tokenMint.slice(0, 6) + "…" : "—")}</td>
                    <td className="font-mono">{formatUnits(row.rawTokenAmount, row.tokenDecimals)}</td>
                    <td className="font-mono">{row.rawQuoteAmount ? formatUnits(row.rawQuoteAmount, row.quoteDecimals) + (row.quoteMint?.startsWith("So1111") ? " SOL" : "") : "—"} <span className="text-[var(--muted)]">{row.considerationUsd ? formatUsd(row.considerationUsd) : ""}</span></td>
                    <td className="text-xs">{row.pricingState ? row.pricingState.replaceAll("_", " ") : "—"}{row.pricingConfidenceBps !== null ? " · " + String(row.pricingConfidenceBps / 100) + "%" : ""}</td>
                    <td><span className={row.finality === "finalized" ? "" : "text-[var(--accent)]"}>{row.finality}</span></td>
                    <td className="text-xs text-[var(--muted)]">{row.ingestionSource.replace("helius-", "")}</td>
                    <td className="text-xs">{row.processingState ?? "—"}</td>
                    <td className="pr-3"><a className="text-xs underline" href={explorerTransactionUrl(row.signature)} target="_blank" rel="noreferrer noopener">explorer</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-[var(--border)] px-4 py-2 text-xs text-[var(--muted)]">Confirmed activity is shown immediately but only finalized transactions feed accounting, evidence and scores.</p>
      </Panel>
      <Panel title="Ingestion and reconstruction quality">
        {detail.diagnostics ? (
          <div className="p-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["Transactions", detail.diagnostics.transactionsIngested],
                ["Successful", detail.diagnostics.successful],
                ["Token-flow candidates", detail.diagnostics.tokenFlowTransactions],
                ["Token flows", detail.diagnostics.tokenFlows],
                ["Swap candidates", detail.diagnostics.providerSwapCandidates],
                ["Trades reconstructed", detail.diagnostics.reconstructedTrades],
                ["Priced trades", detail.diagnostics.pricedTrades],
                ["Rejected candidates", detail.diagnostics.rejectedCandidates],
              ].map(([label, value]) => (
                <div key={label} className="rounded bg-[var(--panel-muted)] p-3">
                  <p className="text-xs uppercase text-[var(--muted)]">{label}</p>
                  <p className="mt-1 font-mono text-lg">{value}</p>
                </div>
              ))}
            </div>
            {detail.diagnostics.rejectionReasons.length > 0 ? (
              <div className="mt-4 border-t border-[var(--border)] pt-4">
                <p className="text-xs uppercase text-[var(--muted)]">Candidate rejection reasons</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {detail.diagnostics.rejectionReasons.map(({ reason, count }) => (
                    <span key={reason} className="rounded border border-[var(--border)] px-2 py-1 font-mono text-xs">
                      {reason}: {count}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <Empty text="No ingestion diagnostics are available yet." />
        )}
      </Panel>
      <Panel title="7D / 30D / 90D performance">
        {detail.performance.length === 0 ? (
          <Empty text="No trustworthy performance snapshot is available yet." />
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {detail.performance.map((snapshot) => (
                <tr
                  key={snapshot.id}
                  className="border-t border-[var(--border)]"
                >
                  <td className="p-3">{snapshot.windowDays}D</td>
                  <td>Realized: {snapshot.realizedPnlUsd ?? "unknown"}</td>
                  <td>Unrealized: {snapshot.unrealizedPnlUsd ?? "unknown"}</td>
                  <td>{snapshot.completedTrades} completed trades</td>
                  <td>{snapshot.quality}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <Panel title="Open token exposure">
        {detail.positions.length === 0 ? (
          <Empty text="No open positions reconstructed." />
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {detail.positions.map(({ position, token }) => (
                <tr key={token.id} className="border-t border-[var(--border)]">
                  <td className="p-3 font-mono">
                    {token.symbol ?? token.mint.slice(0, 8)}
                  </td>
                  <td>{position.rawAmount} base units</td>
                  <td>Basis: {position.knownCostBasisUsd ?? "unknown"}</td>
                  <td>Unrealized: {position.unrealizedPnlUsd ?? "unknown"}</td>
                  <td>{position.quality}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <Panel title="Recent reconstructed trades">
        {detail.trades.length === 0 ? (
          <Empty text="No unambiguous swaps have been reconstructed." />
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {detail.trades.map(({ trade, token }) => (
                <tr key={trade.id} className="border-t border-[var(--border)]">
                  <td className="p-3">{trade.occurredAt.toISOString()}</td>
                  <td>{trade.side}</td>
                  <td className="font-mono">
                    {token.symbol ?? token.mint.slice(0, 8)}
                  </td>
                  <td>{trade.rawTokenAmount} base units</td>
                  <td>{trade.estimatedUsdValue ?? trade.pricingStatus.replaceAll("_", " ")}</td>
                  <td>{trade.quality}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <Panel title="Score history and explanation">
        {detail.scores.length === 0 ? (
          <Empty text="A score requires sufficient completed, priced trades." />
        ) : (
          <pre className="overflow-auto p-4 text-xs text-[var(--muted)]">
            {JSON.stringify(detail.scores, null, 2)}
          </pre>
        )}
      </Panel>
    </section>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded border border-[var(--border)] bg-[var(--panel)]">
      <h2 className="border-b border-[var(--border)] px-4 py-3 font-medium">
        {title}
      </h2>
      {children}
    </section>
  );
}
function Empty({ text }: { text: string }) {
  return <p className="p-6 text-sm text-[var(--muted)]">{text}</p>;
}

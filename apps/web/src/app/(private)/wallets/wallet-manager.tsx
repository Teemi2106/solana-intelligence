"use client";

import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode, type SyntheticEvent } from "react";

type Status = "ACTIVE" | "PAUSED";
export interface ManagedWallet { id: string; address: string; displayName: string | null; status: Status; labels: string[]; ingestionStatus: string | null; transactionsStored: number | null; score: number | null; classification: string | null }

export function WalletManager({ wallets }: { wallets: ManagedWallet[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [labels, setLabels] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = useMemo(() => wallets.filter((wallet) => selected.has(wallet.id)), [selected, wallets]);
  const allSelected = wallets.length > 0 && chosen.length === wallets.length;

  function toggle(id: string) { setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  async function send(url: string, init: RequestInit, failure: string) {
    setPending(true); setError(null);
    try { const response = await fetch(url, init); if (!response.ok) throw new Error(failure); router.refresh(); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : failure); return false; }
    finally { setPending(false); }
  }
  async function bulk(status: "ACTIVE" | "PAUSED" | "ARCHIVED", ids: string[]) {
    if (!ids.length) return;
    if (status === "ARCHIVED" && !window.confirm(`Remove ${String(ids.length)} wallet${ids.length === 1 ? "" : "s"} from tracking? Historical data will be preserved.`)) return;
    const ok = await send("/api/wallets/bulk", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ walletIds: ids, status }) }, "The wallets could not be updated.");
    if (ok) setSelected(new Set());
  }
  function beginEdit(wallet: ManagedWallet) { setEditing(wallet.id); setName(wallet.displayName ?? ""); setLabels(wallet.labels.join(", ")); setError(null); }
  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault(); if (!editing) return;
    const ok = await send(`/api/wallets/${editing}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: name.trim() || null, labels: [...new Set(labels.split(",").map((label) => label.trim()).filter(Boolean))] }) }, "The wallet details could not be saved.");
    if (ok) setEditing(null);
  }

  return <div className="grid gap-3">
    <div className="flex flex-wrap items-center gap-2 rounded border border-[var(--border)] bg-[var(--panel)] p-3">
      <span className="mr-auto text-sm text-[var(--muted)]">{selected.size ? `${String(selected.size)} selected` : `${String(wallets.length)} watched wallets`}</span>
      <Action disabled={pending || !selected.size} onClick={() => void bulk("PAUSED", chosen.map((wallet) => wallet.id))}>Pause selected</Action>
      <Action disabled={pending || !selected.size} onClick={() => void bulk("ACTIVE", chosen.map((wallet) => wallet.id))}>Resume selected</Action>
      <Action disabled={pending || !wallets.some((wallet) => wallet.status === "ACTIVE")} onClick={() => void bulk("PAUSED", wallets.filter((wallet) => wallet.status === "ACTIVE").map((wallet) => wallet.id))}>Pause all</Action>
      <Action disabled={pending || !wallets.some((wallet) => wallet.status === "PAUSED")} onClick={() => void bulk("ACTIVE", wallets.filter((wallet) => wallet.status === "PAUSED").map((wallet) => wallet.id))}>Resume all</Action>
      <Action danger disabled={pending || !selected.size} onClick={() => void bulk("ARCHIVED", chosen.map((wallet) => wallet.id))}>Delete selected</Action>
    </div>
    {error ? <p role="alert" className="rounded border border-[var(--danger)] p-3 text-sm text-[var(--danger)]">{error}</p> : null}
    <div className="overflow-x-auto rounded border border-[var(--border)] bg-[var(--panel)]"><table className="w-full min-w-[900px] text-left text-sm">
      <thead className="text-xs uppercase text-[var(--muted)]"><tr><th className="p-3"><input type="checkbox" aria-label="Select all wallets" checked={allSelected} onChange={() => { setSelected(allSelected ? new Set() : new Set(wallets.map((wallet) => wallet.id))); }} /></th><th>Wallet</th><th>Status</th><th>Ingestion</th><th>Score</th><th>Classification</th><th className="pr-3 text-right">Actions</th></tr></thead>
      <tbody>{wallets.map((wallet) => <tr key={wallet.id} className="border-t border-[var(--border)] align-top">
        <td className="p-3"><input type="checkbox" aria-label={`Select ${wallet.displayName ?? wallet.address}`} checked={selected.has(wallet.id)} onChange={() => { toggle(wallet.id); }} /></td>
        <td className="py-3"><Link href={`/wallets/${wallet.address}` as Route} className="font-mono text-[var(--accent)]">{wallet.displayName ?? `${wallet.address.slice(0, 8)}…${wallet.address.slice(-6)}`}</Link><p className="mt-1 text-xs text-[var(--muted)]">{wallet.labels.join(" · ") || "No labels"}</p></td>
        <td className="py-3"><span className={wallet.status === "ACTIVE" ? "text-[var(--success)]" : "text-[var(--muted)]"}>{wallet.status}</span></td>
        <td className="py-3">{wallet.ingestionStatus ?? "NOT STARTED"}{wallet.transactionsStored === null ? null : <p className="text-xs text-[var(--muted)]">{wallet.transactionsStored} stored</p>}</td>
        <td className="py-3">{wallet.score === null ? "—" : `${String(wallet.score)}/100`}</td><td className="py-3 text-xs">{wallet.classification?.replaceAll("_", " ") ?? "INSUFFICIENT EVIDENCE"}</td>
        <td className="p-3"><div className="flex justify-end gap-2"><button type="button" disabled={pending} onClick={() => { beginEdit(wallet); }} className="text-xs text-[var(--accent)] disabled:opacity-40">Edit</button><button type="button" disabled={pending} onClick={() => void bulk(wallet.status === "ACTIVE" ? "PAUSED" : "ACTIVE", [wallet.id])} className="text-xs disabled:opacity-40">{wallet.status === "ACTIVE" ? "Pause" : "Resume"}</button><button type="button" disabled={pending} onClick={() => void bulk("ARCHIVED", [wallet.id])} className="text-xs text-[var(--danger)] disabled:opacity-40">Delete</button></div></td>
      </tr>)}</tbody>
    </table></div>
    {editing ? <form onSubmit={(event) => void save(event)} className="rounded border border-[var(--accent)] bg-[var(--panel)] p-4"><h2 className="font-semibold">Edit wallet</h2><div className="mt-3 grid gap-3 md:grid-cols-2"><label className="grid gap-1 text-xs text-[var(--muted)]">Display name<input value={name} onChange={(event) => { setName(event.target.value); }} maxLength={100} className="rounded border border-[var(--border)] bg-[var(--panel-muted)] px-3 py-2 text-sm text-[var(--foreground)]" /></label><label className="grid gap-1 text-xs text-[var(--muted)]">Labels (comma separated)<input value={labels} onChange={(event) => { setLabels(event.target.value); }} className="rounded border border-[var(--border)] bg-[var(--panel-muted)] px-3 py-2 text-sm text-[var(--foreground)]" /></label></div><div className="mt-3 flex justify-end gap-2"><Action disabled={pending} onClick={() => { setEditing(null); }}>Cancel</Action><button disabled={pending} className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#07130f]">{pending ? "Saving…" : "Save changes"}</button></div></form> : null}
  </div>;
}

function Action({ children, danger = false, disabled, onClick }: { children: ReactNode; danger?: boolean; disabled: boolean; onClick: () => void }) {
  return <button type="button" disabled={disabled} onClick={onClick} className={`rounded border px-3 py-2 text-xs font-semibold disabled:opacity-40 ${danger ? "border-[var(--danger)] text-[var(--danger)]" : "border-[var(--border)]"}`}>{children}</button>;
}

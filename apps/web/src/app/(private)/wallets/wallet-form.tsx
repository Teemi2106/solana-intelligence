"use client";

import { useState, type SyntheticEvent } from "react";
import { useRouter } from "next/navigation";

export function WalletForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true);
    setError(null);
    const data = new FormData(form);
    const address = data.get("address");
    const displayName = data.get("displayName");
    const labelsValue = data.get("labels");
    const labels =
      typeof labelsValue === "string"
        ? labelsValue
            .split(",")
            .map((label) => label.trim())
            .filter(Boolean)
        : [];
    try {
      const response = await fetch("/api/wallets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          address,
          displayName:
            typeof displayName === "string" && displayName.length > 0
              ? displayName
              : undefined,
          labels,
        }),
      });
      if (!response.ok) {
        setError(
          "Wallet could not be added. Check the address and system readiness.",
        );
        return;
      }
      form.reset();
      router.refresh();
    } catch {
      setError(
        "Wallet could not be added because the server could not be reached.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="grid gap-3 rounded border border-[var(--border)] bg-[var(--panel)] p-4 lg:grid-cols-[2fr_1fr_1fr_auto]"
    >
      <input
        required
        name="address"
        placeholder="Solana wallet address"
        className="rounded border border-[var(--border)] bg-[var(--panel-muted)] px-3 py-2 font-mono text-sm"
      />
      <input
        name="displayName"
        placeholder="Display name"
        className="rounded border border-[var(--border)] bg-[var(--panel-muted)] px-3 py-2 text-sm"
      />
      <input
        name="labels"
        placeholder="labels, comma separated"
        className="rounded border border-[var(--border)] bg-[var(--panel-muted)] px-3 py-2 text-sm"
      />
      <button
        disabled={pending}
        className="rounded bg-[var(--accent)] px-4 py-2 font-semibold text-[#07130f] disabled:opacity-60"
      >
        {pending ? "Adding…" : "Track wallet"}
      </button>
      {error ? (
        <p role="alert" className="text-sm text-[var(--danger)] lg:col-span-4">
          {error}
        </p>
      ) : null}
    </form>
  );
}

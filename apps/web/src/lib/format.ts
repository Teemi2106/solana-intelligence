/** Exact decimal formatting of an integer base-unit amount; never goes through floating point. */
export function formatUnits(raw: string | null, decimals: number | null, maxFraction = 4): string {
  if (raw === null || decimals === null) return "—";
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = digits.slice(digits.length - decimals, digits.length - decimals + maxFraction).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export const explorerTransactionUrl = (signature: string) => `https://solscan.io/tx/${signature}`;

export function formatUsd(value: string | null): string {
  if (value === null) return "unknown";
  const [whole = "0", fraction = ""] = value.split(".");
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction.padEnd(2, "0").slice(0, 2)}`;
}

export function ageSeconds(date: Date | null, now: Date = new Date()): number | null {
  return date === null ? null : Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
}

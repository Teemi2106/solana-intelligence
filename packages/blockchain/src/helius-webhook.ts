import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { heliusTransaction, type HeliusTransaction } from "./helius-schemas";

/** Hard cap on transactions per delivery. Helius batches; anything larger is not a legitimate delivery. */
export const MAX_WEBHOOK_TRANSACTIONS = 100;
/** Hard cap on request body bytes, enforced before parsing. */
export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

export const heliusWebhookPayload = z.array(heliusTransaction).min(1).max(MAX_WEBHOOK_TRANSACTIONS);

/**
 * Helius authenticates deliveries by echoing the `authHeader` configured on the webhook in the
 * `Authorization` header. It is a shared secret, not a signature, so verification is a constant-time compare.
 * The header value this system configures is derived from the secret in exactly one place.
 */
export function heliusAuthHeaderValue(secret: string): string {
  return `Bearer ${secret}`;
}

export function verifyHeliusAuthorization(received: string | null, secret: string): boolean {
  if (received === null) return false;
  // Hash both sides so the comparison is constant-time regardless of length.
  const left = createHash("sha256").update(received).digest();
  const right = createHash("sha256").update(heliusAuthHeaderValue(secret)).digest();
  return timingSafeEqual(left, right);
}

/** Deterministic, provider-scoped identity of one delivered transaction. One row per signature. */
export function heliusLiveEventId(signature: string): string {
  return `helius:live:${signature}`;
}

export function payloadHash(transaction: HeliusTransaction): string {
  return createHash("sha256").update(JSON.stringify(transaction)).digest("hex");
}

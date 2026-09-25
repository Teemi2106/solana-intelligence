import { z } from "zod";

const base58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

export const solanaAddressSchema = z.string().min(32).max(44).regex(base58, "invalid base58 address");
export const transactionSignatureSchema = z.string().min(80).max(90).regex(base58, "invalid signature");

export const paginationSchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function parseJsonObject(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(value);
}

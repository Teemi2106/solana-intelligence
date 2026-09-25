import { z } from "zod";

const rawTokenAmount = z.object({ tokenAmount: z.string().regex(/^-?\d+$/), decimals: z.number().int().min(0).max(30) });
const tokenTransfer = z.object({
  mint: z.string().min(32).max(44),
  fromUserAccount: z.string().nullable().optional(),
  toUserAccount: z.string().nullable().optional(),
  fromTokenAccount: z.string().nullable().optional(),
  toTokenAccount: z.string().nullable().optional(),
  rawTokenAmount: rawTokenAmount.optional(),
  tokenAmount: z.number().nonnegative().optional(),
});

const nativeTransfer = z.object({ fromUserAccount: z.string().nullable(), toUserAccount: z.string().nullable(), amount: z.number().int().nonnegative() });
const tokenBalanceChange = z.object({
  userAccount: z.string().nullable().optional(),
  tokenAccount: z.string(),
  rawTokenAmount,
  mint: z.string().min(32).max(44),
});
const accountData = z.object({
  account: z.string(),
  nativeBalanceChange: z.number().int().default(0),
  tokenBalanceChanges: z.array(tokenBalanceChange).default([]),
});

export const heliusTransaction = z.object({
  signature: z.string().min(80).max(90),
  slot: z.number().int().nonnegative(),
  timestamp: z.number().int().nonnegative(),
  type: z.string(),
  source: z.string().nullable().optional(),
  fee: z.number().int().nonnegative().default(0),
  feePayer: z.string().nullable().optional(),
  transactionError: z.unknown().nullable().optional(),
  tokenTransfers: z.array(tokenTransfer).default([]),
  nativeTransfers: z.array(nativeTransfer).default([]),
  accountData: z.array(accountData).default([]),
});

export const heliusHistoryResponse = z.array(heliusTransaction).max(100);
export type HeliusTransaction = z.infer<typeof heliusTransaction>;

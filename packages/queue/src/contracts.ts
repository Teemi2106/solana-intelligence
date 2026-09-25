import { z } from "zod";

export const queueNames = {
  transactionIngestion: "transaction-ingestion",
  analysis: "analysis",
  liveMaintenance: "live-maintenance",
  notificationDelivery: "notification-delivery",
  outcomeTracking: "outcome-tracking",
} as const;

export const ingestWalletHistoryJob = z.object({
  walletId: z.uuid(),
  runId: z.uuid(),
  correlationId: z.string().min(1).max(128),
});
export type IngestWalletHistoryJob = z.infer<typeof ingestWalletHistoryJob>;

export const ingestProviderEventJob = z.object({
  providerEventId: z.uuid(),
  correlationId: z.string().min(1).max(128),
});

export type IngestProviderEventJob = z.infer<typeof ingestProviderEventJob>;

/** Live path: a persisted webhook event that must be normalized into canonical transactions/trades. */
export const normalizeLiveEventJob = z.object({ providerEventId: z.uuid() });
export type NormalizeLiveEventJob = z.infer<typeof normalizeLiveEventJob>;

/** `price-only` prices new (possibly still confirmed) trades; `full` also rebuilds accounting, evidence and score from finalized trades. */
export const walletRecomputeJob = z.object({ walletId: z.uuid(), mode: z.enum(["price-only", "full"]) });
export type WalletRecomputeJob = z.infer<typeof walletRecomputeJob>;

export const finalityCheckJob = z.object({ signature: z.string().min(80).max(90), attempt: z.number().int().min(0).max(1_000) });
export type FinalityCheckJob = z.infer<typeof finalityCheckJob>;

export const gapBackfillJob = z.object({ walletId: z.uuid() });
export const reconcileSubscriptionsJob = z.object({ reason: z.string().max(64).default("scheduled") });
export const tokenLaunchEnrichmentJob = z.object({ walletId: z.uuid() });

export const deliverNotificationJob = z.object({
  deliveryId: z.uuid(),
  correlationId: z.string().min(1).max(128),
});

export const measureOutcomeJob = z.object({
  outcomeId: z.uuid(),
  correlationId: z.string().min(1).max(128),
});

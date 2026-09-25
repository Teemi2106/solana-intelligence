import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  ALLOCATION_PATTERN_MIN_SHARE_BPS, assessScoreEligibility, buildEntryEvidence, decideWalletClassification, deriveScoreInputs, scoreWallet, summarizeAllocation, summarizeCopyability, walletScoreVersion,
  type ClassificationEvidence, type EntryEvidence, type LaunchFactInput, type PerformanceEligibility, type TokenLaunchProvider, type WalletScoreResult,
} from "@swi/domain";
import type { Database } from "@swi/db";
import { schema } from "@swi/db";
import type { AccountingReport } from "./wallet-accounting.js";

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export interface LaunchEnrichmentResult {
  readonly requested: number;
  readonly found: number;
  readonly unavailable: number;
  /** Provider failures (timeouts, rate limits). Not persisted, so they are retried on the next run. */
  readonly errors: number;
  readonly remaining: number;
}

/**
 * Fetches each token's first on-chain activity once. Sequential and spaced out to respect provider limits;
 * definitive "unavailable" answers are retried only after `retryUnavailableAfterMs`.
 */
export async function ensureTokenLaunchFacts(dependencies: { database: Database; provider: TokenLaunchProvider; now?: () => Date; delayMs?: number }, mints: readonly string[], options: { limit?: number; retryUnavailableAfterMs?: number } = {}): Promise<LaunchEnrichmentResult> {
  const { database } = dependencies;
  const now = (dependencies.now ?? (() => new Date()))();
  if (mints.length === 0) return { requested: 0, found: 0, unavailable: 0, errors: 0, remaining: 0 };
  const tokens = await database.query.select({ id: schema.tokens.id, mint: schema.tokens.mint }).from(schema.tokens).where(inArray(schema.tokens.mint, [...mints]));
  const facts = await database.query.select().from(schema.tokenLaunchFacts).where(inArray(schema.tokenLaunchFacts.tokenId, tokens.map((token) => token.id)));
  const factById = new Map(facts.map((fact) => [fact.tokenId, fact]));
  const retryAfter = options.retryUnavailableAfterMs ?? 6 * 3_600_000;
  const pending = tokens.filter((token) => {
    const fact = factById.get(token.id);
    return !fact || (fact.status !== "FOUND" && now.getTime() - fact.fetchedAt.getTime() >= retryAfter);
  }).sort((a, b) => a.mint.localeCompare(b.mint));
  const batch = pending.slice(0, options.limit ?? 50);
  let found = 0;
  let unavailable = 0;
  let errors = 0;
  for (const token of batch) {
    let result;
    try {
      result = await dependencies.provider.getFirstActivity(token.mint);
    } catch {
      errors += 1;
      continue;
    }
    const row = result.status === "FOUND"
      ? { tokenId: token.id, status: "FOUND", firstActivityAt: result.firstActivityAt, firstActivitySlot: result.firstActivitySlot, firstSignature: result.firstSignature, firstSigner: result.firstSigner, source: "helius-getTransactionsForAddress", errorCode: null, fetchedAt: now }
      : { tokenId: token.id, status: "UNAVAILABLE", firstActivityAt: null, firstActivitySlot: null, firstSignature: null, firstSigner: null, source: "helius-getTransactionsForAddress", errorCode: result.reason, fetchedAt: now };
    await database.query.insert(schema.tokenLaunchFacts).values(row).onConflictDoUpdate({ target: schema.tokenLaunchFacts.tokenId, set: row });
    if (result.status === "FOUND") found += 1;
    else unavailable += 1;
    await sleep(dependencies.delayMs ?? 150);
  }
  return { requested: batch.length, found, unavailable, errors, remaining: pending.length - batch.length + errors };
}

export interface IntelligenceResult {
  readonly copyability: ReturnType<typeof summarizeCopyability>;
  readonly allocation: ReturnType<typeof summarizeAllocation>;
  readonly score: WalletScoreResult | null;
  readonly scoreEligibility: { readonly eligible: boolean; readonly reasons: readonly string[] };
  readonly classification: string;
  readonly evidenceCount: number;
  readonly versionsWritten: { readonly score: boolean; readonly classification: boolean };
}

/**
 * Derives copyability/allocation evidence, the wallet-score-v1 inputs, the score and the classification from finalized
 * accounting. Scores and classifications are versioned: a change closes the current row and appends a new one; nothing
 * historical is edited. If any required input cannot be established the score stays withheld.
 */
export async function updateWalletIntelligence(dependencies: { database: Database }, input: { walletId: string; address: string; windows: readonly PerformanceEligibility[]; evidenceInputs: AccountingReport["evidenceInputs"]; asOf: Date }): Promise<IntelligenceResult> {
  const { database } = dependencies;
  const { asOf, walletId } = input;
  const tokens = await database.query.select({ id: schema.tokens.id, mint: schema.tokens.mint }).from(schema.tokens).where(inArray(schema.tokens.mint, [...input.evidenceInputs.tokenMints]));
  const factRows = await database.query.select().from(schema.tokenLaunchFacts).where(inArray(schema.tokenLaunchFacts.tokenId, tokens.map((token) => token.id)));
  const mintById = new Map(tokens.map((token) => [token.id, token.mint]));
  const launch = new Map<string, LaunchFactInput>(factRows.flatMap((fact) => {
    const mint = mintById.get(fact.tokenId);
    return mint ? [[mint, { status: fact.status === "FOUND" ? "FOUND" as const : "UNAVAILABLE" as const, firstActivityAt: fact.firstActivityAt, firstSigner: fact.firstSigner }] as const] : [];
  }));

  const entries: EntryEvidence[] = buildEntryEvidence(input.evidenceInputs.entryTrades, launch, input.address);
  const copyability = summarizeCopyability(entries);
  const launchedMints = new Set([...launch].filter(([, fact]) => fact.firstSigner === input.address).map(([mint]) => mint));
  const allocation = summarizeAllocation(input.evidenceInputs.saleAllocations, launchedMints);

  const ninety = input.windows.find((window) => window.windowDays === 90);
  const thirty = input.windows.find((window) => window.windowDays === 30);
  const scoreInputs = ninety && thirty ? deriveScoreInputs({ ninetyDay: ninety, thirtyDay: thirty, copyability, allocation, dataConfidenceBps: input.evidenceInputs.meanQualifyingConfidenceBps }) : null;
  const scoreEligibility = ninety ? assessScoreEligibility({ ninetyDay: ninety, copyabilityInputsAvailable: scoreInputs !== null }) : { eligible: false, reasons: ["NO_90D_WINDOW"] };
  const score = scoreInputs && scoreEligibility.eligible ? scoreWallet(scoreInputs) : null;

  // ---- Evidence (neutral, factual) ---------------------------------------------------------------
  const evidence: (ClassificationEvidence & { transactionId: string | null })[] = [];
  for (const entry of entries) {
    if (entry.copyable === false) {
      evidence.push({ type: "NON_COPYABLE_ENTRY", confidenceBps: 9000, observedAt: entry.acquiredAt, transactionId: entry.transactionId, facts: { tokenMint: entry.tokenMint, secondsAfterFirstActivity: entry.secondsAfterFirstActivity, walletSignedFirstTransaction: entry.walletSignedFirstTransaction, venue: entry.venue, routed: entry.routed } });
    }
  }
  const firstSaleTx = new Map<string, string>();
  for (const sale of input.evidenceInputs.saleAllocations) if (!firstSaleTx.has(sale.tokenMint)) firstSaleTx.set(sale.tokenMint, sale.transactionId);
  for (const mint of allocation.nonPublicTokens) {
    evidence.push({ type: "EARLY_ALLOCATION_PATTERN", confidenceBps: 8000, observedAt: asOf, transactionId: firstSaleTx.get(mint) ?? null, facts: { tokenMint: mint, reason: launchedMints.has(mint) ? "WALLET_SIGNED_TOKEN_FIRST_TRANSACTION" : "SOLD_WITHOUT_RECORDED_PUBLIC_ACQUISITION" } });
  }
  if (allocation.nonPublicProceedsShareBps !== null && allocation.nonPublicProceedsShareBps >= ALLOCATION_PATTERN_MIN_SHARE_BPS) {
    evidence.push({ type: "HIGH_ALLOCATION_DEPENDENCE", confidenceBps: 8000, observedAt: asOf, transactionId: null, facts: { nonPublicProceedsShareBps: allocation.nonPublicProceedsShareBps } });
  }
  const receipts = await database.sql<{ mint: string; counterparty: string; transaction_id: string; occurred_at: string | Date }[]>`
    select k.mint, f.counterparty, wt.id as transaction_id, wt.occurred_at
    from transaction_token_flows f
    join wallet_transactions wt on wt.id = f.transaction_id
    join tokens k on k.id = f.token_id
    where wt.wallet_id = ${walletId} and wt.kind = 'TRANSFER' and wt.finality = 'finalized' and f.direction = 'IN' and f.counterparty is not null`;
  const firstSigners = new Map(factRows.flatMap((fact) => {
    const mint = mintById.get(fact.tokenId);
    return fact.firstSigner && mint ? [[mint, fact.firstSigner] as const] : [];
  }));
  for (const receipt of receipts) {
    if (firstSigners.get(receipt.mint) === receipt.counterparty) {
      evidence.push({ type: "DEPLOYER_LINKED_TRANSFER", confidenceBps: 9000, observedAt: new Date(receipt.occurred_at), transactionId: receipt.transaction_id, facts: { tokenMint: receipt.mint, sender: receipt.counterparty, note: "sender signed the token's first on-chain transaction" } });
    }
  }

  const decision = decideWalletClassification({ evidence, score, copyability, allocation });
  const versionsWritten = { score: false, classification: false };

  // ---- Versioned score ---------------------------------------------------------------------------
  const [scoreVersion] = await database.query.insert(schema.walletScoreVersions).values({
    version: walletScoreVersion, formula: { weights: { sample: 0.15, repeatability: 0.2, diversity: 0.1, concentration: 0.15, drawdown: 0.1, recency: 0.1, copyability: 0.15, confidence: 0.05 } }, activatedAt: asOf,
  }).onConflictDoNothing().returning();
  const versionRow = scoreVersion ?? (await database.query.select().from(schema.walletScoreVersions).where(eq(schema.walletScoreVersions.version, walletScoreVersion)).limit(1))[0];
  const [currentScore] = await database.query.select().from(schema.walletScores).where(and(eq(schema.walletScores.walletId, walletId), isNull(schema.walletScores.validTo))).orderBy(desc(schema.walletScores.validFrom)).limit(1);
  const inputsHash = score ? sha(score.inputs) : null;
  if (currentScore && (!score || currentScore.inputs["inputsHash"] !== inputsHash)) {
    await database.query.update(schema.walletScores).set({ validTo: asOf }).where(eq(schema.walletScores.id, currentScore.id));
    versionsWritten.score = true;
  }
  if (score && versionRow && currentScore?.inputs["inputsHash"] !== inputsHash) {
    await database.query.insert(schema.walletScores).values({
      walletId, scoreVersionId: versionRow.id, value: score.score, componentScores: { ...score.components }, inputs: { ...score.inputs, inputsHash }, quality: ninety?.metrics?.quality ?? "INSUFFICIENT", validFrom: asOf,
    });
    versionsWritten.score = true;
  }

  // ---- Versioned classification ------------------------------------------------------------------
  const classificationHash = sha({ classification: decision.classification, evidence: evidence.map((item) => [item.type, item.transactionId, item.facts]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
  const [currentClass] = await database.query.select().from(schema.walletClassifications).where(and(eq(schema.walletClassifications.walletId, walletId), isNull(schema.walletClassifications.validTo))).orderBy(desc(schema.walletClassifications.validFrom)).limit(1);
  const currentHash = currentClass?.evidence?.[0]?.["inputHash"];
  if (currentHash !== classificationHash) {
    if (currentClass) await database.query.update(schema.walletClassifications).set({ validTo: asOf }).where(eq(schema.walletClassifications.id, currentClass.id));
    const [created] = await database.query.insert(schema.walletClassifications).values({
      walletId, classification: decision.classification, earlyAccessScore: decision.earlyAccessScore, confidenceBps: decision.confidenceBps,
      evidence: [{ inputHash: classificationHash, reasons: decision.reasons, evidenceCount: evidence.length }], validFrom: asOf,
    }).returning({ id: schema.walletClassifications.id });
    if (created) {
      for (let start = 0; start < evidence.length; start += 200) {
        await database.query.insert(schema.walletClassificationEvidence).values(evidence.slice(start, start + 200).map((item) => ({
          classificationId: created.id, transactionId: item.transactionId, evidenceType: item.type, confidenceBps: item.confidenceBps, facts: { ...item.facts }, observedAt: item.observedAt,
        }))).onConflictDoNothing();
      }
    }
    versionsWritten.classification = true;
  }
  return { copyability, allocation, score, scoreEligibility, classification: decision.classification, evidenceCount: evidence.length, versionsWritten };
}

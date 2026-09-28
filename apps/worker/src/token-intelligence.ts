import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  aggregateHolderEvidence,
  aggregateTokenMarket,
  type ProviderObservation,
  type TokenHolderObservation,
  type TokenHolderProvider,
  type TokenIdentityObservation,
  type TokenIdentityProvider,
  type TokenIntelligenceComponent,
  type TokenMarketObservation,
  type TokenPoolProvider,
} from "@swi/domain";
import type { Database } from "@swi/db";
import { schema } from "@swi/db";
import { ProviderRequestError } from "@swi/blockchain";
import { DexScreenerRequestError } from "@swi/market-data";

const RISK_VERSION = "token-evidence-v1";

export interface TokenFreshnessPolicy {
  readonly marketMs: number;
  readonly holdersMs: number;
  readonly metadataMs: number;
  readonly authoritiesMs: number;
}

export interface TokenIntelligenceDependencies {
  readonly database: Database;
  readonly identity: TokenIdentityProvider;
  readonly markets: TokenPoolProvider;
  readonly holders: TokenHolderProvider;
  readonly freshness: TokenFreshnessPolicy;
  readonly now?: () => Date;
}

export async function findDueTokenEnrichmentRequests(database: Database, limit = 100, now = new Date()): Promise<readonly string[]> {
  const rows = await database.query.select({ id: schema.tokenEnrichmentRequests.id }).from(schema.tokenEnrichmentRequests)
    .where(and(inArray(schema.tokenEnrichmentRequests.status, ["PENDING", "FAILED", "PROCESSING"]), lte(schema.tokenEnrichmentRequests.nextAttemptAt, now), or(isNull(schema.tokenEnrichmentRequests.leasedUntil), lte(schema.tokenEnrichmentRequests.leasedUntil, now))))
    .orderBy(schema.tokenEnrichmentRequests.nextAttemptAt).limit(limit);
  return rows.map((row) => row.id);
}

export async function enrichTokenRequest(dependencies: TokenIntelligenceDependencies, requestId: string): Promise<{ status: "COMPLETED" | "DEFERRED" | "ALREADY_CLAIMED"; components: readonly string[] }> {
  const now = (dependencies.now ?? (() => new Date()))();
  const leaseOwner = randomUUID();
  const [request] = await dependencies.database.query.update(schema.tokenEnrichmentRequests).set({
    status: "PROCESSING", leaseOwner, leasedUntil: new Date(now.getTime() + 10 * 60_000),
    attemptCount: sql`${schema.tokenEnrichmentRequests.attemptCount} + 1`, updatedAt: now,
  }).where(and(
    eq(schema.tokenEnrichmentRequests.id, requestId),
    inArray(schema.tokenEnrichmentRequests.status, ["PENDING", "FAILED", "PROCESSING"]),
    lte(schema.tokenEnrichmentRequests.nextAttemptAt, now),
    or(isNull(schema.tokenEnrichmentRequests.leasedUntil), lte(schema.tokenEnrichmentRequests.leasedUntil, now)),
  )).returning();
  if (!request) return { status: "ALREADY_CLAIMED", components: [] };
  const [token] = await dependencies.database.query.select().from(schema.tokens).where(eq(schema.tokens.id, request.tokenId)).limit(1);
  if (!token) {
    await finish(dependencies.database, requestId, leaseOwner, now, "TOKEN_NOT_FOUND");
    return { status: "DEFERRED", components: [] };
  }

  const requested = new Set(request.requestedComponents.filter(isComponent));
  const completed: string[] = [];
  const failures: string[] = [];
  if (requested.has("IDENTITY") && !(await identityFresh(dependencies.database, token.id, now))) {
    try {
      await persistIdentity(dependencies, token.id, await dependencies.identity.getIdentity(token.mint));
      completed.push("IDENTITY");
    } catch (error) { failures.push(errorCode(error, "IDENTITY")); }
  }
  if (requested.has("MARKET") && !(await marketFresh(dependencies.database, token.id, now))) {
    try {
      const response = await dependencies.markets.getMarkets([token.mint]);
      const observation = response.get(token.mint);
      if (!observation) throw new Error("MISSING_MARKET_RESULT");
      await persistMarket(dependencies, token.id, observation);
      completed.push("MARKET");
    } catch (error) { failures.push(errorCode(error, "MARKET")); }
  }
  if (requested.has("HOLDERS") && !(await holdersFresh(dependencies.database, token.id, now))) {
    try {
      await persistHolders(dependencies, token.id, await dependencies.holders.getHolderEvidence(token.mint));
      completed.push("HOLDERS");
    } catch (error) { failures.push(errorCode(error, "HOLDERS")); }
  }
  await persistRiskSnapshot(dependencies.database, token.id, now);
  if (failures.length > 0) {
    const backoff = Math.min(6 * 60 * 60_000, 30_000 * 2 ** Math.min(request.attemptCount, 8));
    await dependencies.database.query.update(schema.tokenEnrichmentRequests).set({
      status: "PENDING", leasedUntil: null, leaseOwner: null, lastErrorCode: failures.join(","), nextAttemptAt: new Date(now.getTime() + backoff), updatedAt: now,
    }).where(and(eq(schema.tokenEnrichmentRequests.id, requestId), eq(schema.tokenEnrichmentRequests.leaseOwner, leaseOwner)));
    return { status: "DEFERRED", components: completed };
  }
  await dependencies.database.query.update(schema.tokenEnrichmentRequests).set({ status: "COMPLETED", leasedUntil: null, leaseOwner: null, lastErrorCode: null, completedAt: now, updatedAt: now })
    .where(and(eq(schema.tokenEnrichmentRequests.id, requestId), eq(schema.tokenEnrichmentRequests.leaseOwner, leaseOwner)));
  return { status: "COMPLETED", components: completed };
}

const isComponent = (value: string): value is TokenIntelligenceComponent => value === "IDENTITY" || value === "MARKET" || value === "HOLDERS";

async function identityFresh(database: Database, tokenId: string, now: Date): Promise<boolean> {
  const [row] = await database.query.select({ metadata: schema.tokenIdentitySnapshots.metadataFreshUntil, authorities: schema.tokenIdentitySnapshots.authoritiesFreshUntil }).from(schema.tokenIdentitySnapshots)
    .where(eq(schema.tokenIdentitySnapshots.tokenId, tokenId)).orderBy(desc(schema.tokenIdentitySnapshots.observedAt)).limit(1);
  return Boolean(row && row.metadata > now && row.authorities > now);
}
async function marketFresh(database: Database, tokenId: string, now: Date): Promise<boolean> {
  const [row] = await database.query.select({ freshUntil: schema.tokenMarketSnapshots.freshUntil }).from(schema.tokenMarketSnapshots)
    .where(eq(schema.tokenMarketSnapshots.tokenId, tokenId)).orderBy(desc(schema.tokenMarketSnapshots.observedAt)).limit(1);
  return Boolean(row && row.freshUntil > now);
}
async function holdersFresh(database: Database, tokenId: string, now: Date): Promise<boolean> {
  const [row] = await database.query.select({ freshUntil: schema.tokenHolderSnapshots.freshUntil }).from(schema.tokenHolderSnapshots)
    .where(eq(schema.tokenHolderSnapshots.tokenId, tokenId)).orderBy(desc(schema.tokenHolderSnapshots.observedAt)).limit(1);
  return Boolean(row && row.freshUntil > now);
}

async function persistIdentity(dependencies: TokenIntelligenceDependencies, tokenId: string, observation: ProviderObservation<TokenIdentityObservation>): Promise<void> {
  const provenance = observation.provenance;
  const data = observation.status === "AVAILABLE" || observation.status === "PARTIAL" ? observation.data : null;
  const unavailable = observation.status === "PARTIAL" ? observation.unavailableFields : observation.status === "AVAILABLE" ? [] : [observation.reasonCode];
  await dependencies.database.query.transaction(async (transaction) => {
    await transaction.insert(schema.tokenIdentitySnapshots).values({
      tokenId, provider: provenance.provider, observedAt: provenance.observedAt, fetchedAt: provenance.fetchedAt,
      metadataFreshUntil: new Date(provenance.fetchedAt.getTime() + dependencies.freshness.metadataMs),
      authoritiesFreshUntil: new Date(provenance.fetchedAt.getTime() + dependencies.freshness.authoritiesMs),
      status: observation.status, methodologyVersion: provenance.methodologyVersion,
      tokenProgram: data?.tokenProgram ?? null, decimals: data?.decimals ?? null, rawSupply: data?.rawSupply?.toString() ?? null,
      mintAuthorityStatus: data?.mintAuthority.status ?? "UNKNOWN", mintAuthority: data?.mintAuthority.status === "ENABLED" ? data.mintAuthority.address : null,
      freezeAuthorityStatus: data?.freezeAuthority.status ?? "UNKNOWN", freezeAuthority: data?.freezeAuthority.status === "ENABLED" ? data.freezeAuthority.address : null,
      metadataStatus: data?.metadata.status ?? "MISSING", name: data?.metadata.name ?? null, symbol: data?.metadata.symbol ?? null, metadataUri: data?.metadata.uri ?? null,
      chainSlot: provenance.chainSlot, unavailableFields: unavailable,
    }).onConflictDoNothing();
    if (data) await transaction.update(schema.tokens).set({ decimals: data.decimals, name: data.metadata.name, symbol: data.metadata.symbol, metadata: { status: data.metadata.status, uri: data.metadata.uri, provider: provenance.provider }, updatedAt: provenance.fetchedAt }).where(eq(schema.tokens.id, tokenId));
  });
}

async function persistMarket(dependencies: TokenIntelligenceDependencies, tokenId: string, observation: ProviderObservation<TokenMarketObservation>): Promise<void> {
  const provenance = observation.provenance;
  const data = observation.status === "AVAILABLE" || observation.status === "PARTIAL" ? observation.data : null;
  const aggregate = data ? aggregateTokenMarket(data) : null;
  const unavailable = observation.status === "PARTIAL" ? observation.unavailableFields : observation.status === "AVAILABLE" ? [] : [observation.reasonCode];
  await dependencies.database.query.transaction(async (transaction) => {
    const [snapshot] = await transaction.insert(schema.tokenMarketSnapshots).values({
      tokenId, provider: provenance.provider, observedAt: provenance.observedAt, fetchedAt: provenance.fetchedAt,
      freshUntil: new Date(provenance.fetchedAt.getTime() + dependencies.freshness.marketMs), status: observation.status, methodologyVersion: provenance.methodologyVersion,
      representativePoolAddress: aggregate?.representativePoolAddress ?? null, priceUsd: aggregate?.priceUsd ?? null, marketCapUsd: aggregate?.marketCapUsd ?? null,
      fdvUsd: aggregate?.fdvUsd ?? null, liquidityUsd: aggregate?.totalLiquidityUsd ?? null, largestPoolLiquidityUsd: aggregate?.largestPoolLiquidityUsd ?? null,
      largestPoolShareBps: aggregate?.largestPoolShareBps ?? null, topThreePoolShareBps: aggregate?.topThreePoolShareBps ?? null,
      volume24hUsd: aggregate?.volume24hUsd ?? null, usablePoolCount: aggregate?.usablePoolCount ?? 0, excludedPoolCount: aggregate?.excludedPoolCount ?? 0,
      unavailableFields: unavailable, quality: aggregate && aggregate.usablePoolCount > 0 ? "HIGH" : observation.status === "NOT_FOUND" ? "INSUFFICIENT" : "LOW",
    }).onConflictDoNothing().returning({ id: schema.tokenMarketSnapshots.id });
    if (snapshot && data?.pools.length) await transaction.insert(schema.tokenPoolSnapshots).values(data.pools.map((pool) => ({
      marketSnapshotId: snapshot.id, poolAddress: pool.poolAddress, dex: pool.dex, labels: pool.labels, baseMint: pool.baseMint, quoteMint: pool.quoteMint,
      priceUsd: pool.priceUsd, priceNative: pool.priceNative, liquidityUsd: pool.liquidityUsd, baseLiquidity: pool.baseLiquidity, quoteLiquidity: pool.quoteLiquidity,
      volumeH1Usd: pool.volumeH1Usd, volumeH6Usd: pool.volumeH6Usd, volumeH24Usd: pool.volumeH24Usd, h1Buys: pool.h1Buys, h1Sells: pool.h1Sells,
      h24Buys: pool.h24Buys, h24Sells: pool.h24Sells, fdvUsd: pool.fdvUsd, marketCapUsd: pool.marketCapUsd, pairCreatedAt: pool.pairCreatedAt,
    }))).onConflictDoNothing();
  });
}

async function persistHolders(dependencies: TokenIntelligenceDependencies, tokenId: string, observation: ProviderObservation<TokenHolderObservation>): Promise<void> {
  const provenance = observation.provenance;
  const data = observation.status === "AVAILABLE" || observation.status === "PARTIAL" ? observation.data : null;
  const aggregate = data ? aggregateHolderEvidence(data) : null;
  const unavailable = observation.status === "PARTIAL" ? observation.unavailableFields : observation.status === "AVAILABLE" ? [] : [observation.reasonCode];
  await dependencies.database.query.transaction(async (transaction) => {
    const [snapshot] = await transaction.insert(schema.tokenHolderSnapshots).values({
      tokenId, provider: provenance.provider, observedAt: provenance.observedAt, fetchedAt: provenance.fetchedAt,
      freshUntil: new Date(provenance.fetchedAt.getTime() + dependencies.freshness.holdersMs), status: observation.status, methodologyVersion: provenance.methodologyVersion,
      rawSupply: data?.rawSupply.toString() ?? null, enumeratedRawAmount: aggregate?.enumeratedRawAmount.toString() ?? null,
      enumeratedOwnerCount: aggregate?.enumeratedOwnerCount ?? 0, sourceAccountLimit: data?.sourceAccountLimit ?? 20,
      enumerationComplete: aggregate?.enumerationComplete ?? false, supplyCoverageBps: aggregate?.supplyCoverageBps ?? null,
      top1ConcentrationBps: aggregate?.top1ConcentrationBps ?? null, top5ConcentrationBps: aggregate?.top5ConcentrationBps ?? null,
      top10ConcentrationBps: aggregate?.top10ConcentrationBps ?? null, unavailableFields: unavailable,
    }).onConflictDoNothing().returning({ id: schema.tokenHolderSnapshots.id });
    if (snapshot && data) {
      const owners = [...data.owners].sort((a, b) => a.rawAmount === b.rawAmount ? a.owner.localeCompare(b.owner) : a.rawAmount > b.rawAmount ? -1 : 1);
      if (owners.length > 0) await transaction.insert(schema.tokenHolderTopOwners).values(owners.map((owner, index) => ({
        holderSnapshotId: snapshot.id, rank: index + 1, owner: owner.owner, rawAmount: owner.rawAmount.toString(), tokenAccountCount: owner.tokenAccountCount,
        classification: owner.classification, classificationEvidence: owner.classificationEvidence,
      }))).onConflictDoNothing();
    }
  });
}

async function persistRiskSnapshot(database: Database, tokenId: string, observedAt: Date): Promise<void> {
  const [identity] = await database.query.select().from(schema.tokenIdentitySnapshots).where(eq(schema.tokenIdentitySnapshots.tokenId, tokenId)).orderBy(desc(schema.tokenIdentitySnapshots.observedAt)).limit(1);
  const [market] = await database.query.select().from(schema.tokenMarketSnapshots).where(eq(schema.tokenMarketSnapshots.tokenId, tokenId)).orderBy(desc(schema.tokenMarketSnapshots.observedAt)).limit(1);
  const [holders] = await database.query.select().from(schema.tokenHolderSnapshots).where(eq(schema.tokenHolderSnapshots.tokenId, tokenId)).orderBy(desc(schema.tokenHolderSnapshots.observedAt)).limit(1);
  const observedFacts: Record<string, unknown>[] = [];
  const derivedIndicators: Record<string, unknown>[] = [];
  const unavailableEvidence: Record<string, unknown>[] = [];
  if (identity) {
    observedFacts.push({ code: "MINT_AUTHORITY_STATE", value: identity.mintAuthorityStatus, sourceObservationId: identity.id });
    observedFacts.push({ code: "FREEZE_AUTHORITY_STATE", value: identity.freezeAuthorityStatus, sourceObservationId: identity.id });
    derivedIndicators.push(indicator("MINT_AUTHORITY_ENABLED", identity.mintAuthorityStatus === "ENABLED" ? "PRESENT" : identity.mintAuthorityStatus === "REVOKED" ? "ABSENT" : "INDETERMINATE", [identity.id]));
    derivedIndicators.push(indicator("FREEZE_AUTHORITY_ENABLED", identity.freezeAuthorityStatus === "ENABLED" ? "PRESENT" : identity.freezeAuthorityStatus === "REVOKED" ? "ABSENT" : "INDETERMINATE", [identity.id]));
  } else unavailableEvidence.push({ component: "IDENTITY", reasonCode: "NO_OBSERVATION" });
  if (market) {
    observedFacts.push({ code: "USABLE_POOL_COUNT", value: market.usablePoolCount, sourceObservationId: market.id });
    if (market.liquidityUsd !== null) observedFacts.push({ code: "TOTAL_LIQUIDITY_USD", value: market.liquidityUsd, sourceObservationId: market.id });
    derivedIndicators.push(indicator("NO_USABLE_MARKET", market.status === "NOT_FOUND" || market.usablePoolCount === 0 ? "PRESENT" : "ABSENT", [market.id]));
    derivedIndicators.push(indicator("SINGLE_USABLE_POOL", market.usablePoolCount === 1 ? "PRESENT" : market.usablePoolCount > 1 ? "ABSENT" : "INDETERMINATE", [market.id]));
    derivedIndicators.push(indicator("MARKET_DATA_STALE", market.freshUntil <= observedAt ? "PRESENT" : "ABSENT", [market.id]));
  } else unavailableEvidence.push({ component: "MARKET", reasonCode: "NO_OBSERVATION" });
  if (holders) {
    observedFacts.push({ code: "BOUNDED_TOP10_CONCENTRATION_BPS", value: holders.top10ConcentrationBps, sourceObservationId: holders.id });
    observedFacts.push({ code: "ENUMERATED_SUPPLY_COVERAGE_BPS", value: holders.supplyCoverageBps, sourceObservationId: holders.id });
    derivedIndicators.push(indicator("HOLDER_ENUMERATION_INCOMPLETE", holders.enumerationComplete ? "ABSENT" : "PRESENT", [holders.id]));
  } else unavailableEvidence.push({ component: "HOLDERS", reasonCode: "NO_OBSERVATION" });
  const quality = identity && market && holders ? "MEDIUM" : identity || market || holders ? "LOW" : "INSUFFICIENT";
  await database.query.insert(schema.tokenRiskSnapshots).values({
    tokenId, observedAt, methodologyVersion: RISK_VERSION, identitySnapshotId: identity?.id ?? null, marketSnapshotId: market?.id ?? null, holderSnapshotId: holders?.id ?? null,
    observedFacts, derivedIndicators, unavailableEvidence, top10ConcentrationBps: holders?.top10ConcentrationBps ?? null,
    mintAuthorityEnabled: identity ? identity.mintAuthorityStatus === "ENABLED" : null,
    freezeAuthorityEnabled: identity ? identity.freezeAuthorityStatus === "ENABLED" : null, quality,
  }).onConflictDoNothing();
}

const indicator = (code: string, state: "PRESENT" | "ABSENT" | "INDETERMINATE", evidenceObservationIds: readonly string[]) => ({ code, state, evidenceObservationIds, methodologyVersion: RISK_VERSION });
const errorCode = (error: unknown, component: string): string => error instanceof ProviderRequestError || error instanceof DexScreenerRequestError ? `${component}_${error.code}` : `${component}_UNAVAILABLE`;
async function finish(database: Database, requestId: string, leaseOwner: string, now: Date, code: string): Promise<void> {
  await database.query.update(schema.tokenEnrichmentRequests).set({ status: "FAILED", leaseOwner: null, leasedUntil: null, lastErrorCode: code, nextAttemptAt: new Date(now.getTime() + 60 * 60_000), updatedAt: now })
    .where(and(eq(schema.tokenEnrichmentRequests.id, requestId), eq(schema.tokenEnrichmentRequests.leaseOwner, leaseOwner)));
}

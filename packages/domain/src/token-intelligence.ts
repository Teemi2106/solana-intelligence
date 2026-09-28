import { Decimal } from "decimal.js";

export type TokenIntelligenceComponent = "IDENTITY" | "MARKET" | "HOLDERS";
export type TokenEnrichmentTier = "FULL" | "REDUCED" | "DISCOVERY_ONLY";
export type Availability = "AVAILABLE" | "PARTIAL" | "NOT_FOUND" | "UNSUPPORTED";

export interface ObservationProvenance {
  readonly provider: string;
  readonly observedAt: Date;
  readonly fetchedAt: Date;
  readonly chainSlot: bigint | null;
  readonly methodologyVersion: string;
}

export type ProviderObservation<T> =
  | { readonly status: "AVAILABLE"; readonly data: T; readonly provenance: ObservationProvenance }
  | { readonly status: "PARTIAL"; readonly data: T; readonly unavailableFields: readonly string[]; readonly provenance: ObservationProvenance }
  | { readonly status: "NOT_FOUND" | "UNSUPPORTED"; readonly reasonCode: string; readonly provenance: ObservationProvenance };

export type AuthorityState =
  | { readonly status: "ENABLED"; readonly address: string }
  | { readonly status: "REVOKED" }
  | { readonly status: "UNKNOWN" | "UNSUPPORTED" };

export interface TokenIdentityObservation {
  readonly mint: string;
  readonly tokenProgram: string | null;
  readonly decimals: number | null;
  readonly rawSupply: bigint | null;
  readonly mintAuthority: AuthorityState;
  readonly freezeAuthority: AuthorityState;
  readonly metadata: {
    readonly status: "AVAILABLE" | "MISSING" | "INVALID" | "UNSUPPORTED";
    readonly name: string | null;
    readonly symbol: string | null;
    readonly uri: string | null;
  };
}

export interface TokenPoolObservation {
  readonly poolAddress: string;
  readonly dex: string;
  readonly labels: readonly string[];
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly priceUsd: string | null;
  readonly priceNative: string | null;
  readonly liquidityUsd: string | null;
  readonly baseLiquidity: string | null;
  readonly quoteLiquidity: string | null;
  readonly volumeH1Usd: string | null;
  readonly volumeH6Usd: string | null;
  readonly volumeH24Usd: string | null;
  readonly h1Buys: number | null;
  readonly h1Sells: number | null;
  readonly h24Buys: number | null;
  readonly h24Sells: number | null;
  readonly fdvUsd: string | null;
  readonly marketCapUsd: string | null;
  readonly pairCreatedAt: Date | null;
}

export interface TokenMarketObservation {
  readonly mint: string;
  readonly pools: readonly TokenPoolObservation[];
}

export interface MarketAggregate {
  readonly representativePoolAddress: string | null;
  readonly priceUsd: string | null;
  readonly marketCapUsd: string | null;
  readonly fdvUsd: string | null;
  readonly totalLiquidityUsd: string | null;
  readonly largestPoolLiquidityUsd: string | null;
  readonly largestPoolShareBps: number | null;
  readonly topThreePoolShareBps: number | null;
  readonly volume24hUsd: string | null;
  readonly usablePoolCount: number;
  readonly excludedPoolCount: number;
}

const decimalOrNull = (value: string | null): Decimal | null => {
  if (value === null) return null;
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() && parsed.greaterThanOrEqualTo(0) ? parsed : null;
  } catch {
    return null;
  }
};

/** Aggregates one provider observation only; duplicate pool addresses and unusable liquidity never enter totals. */
export function aggregateTokenMarket(observation: TokenMarketObservation): MarketAggregate {
  const unique = new Map<string, TokenPoolObservation>();
  for (const pool of observation.pools) if (!unique.has(pool.poolAddress)) unique.set(pool.poolAddress, pool);
  const usable = [...unique.values()].flatMap((pool) => {
    const liquidity = decimalOrNull(pool.liquidityUsd);
    return liquidity?.greaterThan(0) ? [{ pool, liquidity }] : [];
  }).sort((a, b) => b.liquidity.comparedTo(a.liquidity) || a.pool.poolAddress.localeCompare(b.pool.poolAddress));
  const total = usable.reduce((sum, item) => sum.plus(item.liquidity), new Decimal(0));
  const representative = usable[0];
  const share = (amount: Decimal): number | null => total.greaterThan(0) ? amount.div(total).mul(10_000).floor().toNumber() : null;
  const topThree = usable.slice(0, 3).reduce((sum, item) => sum.plus(item.liquidity), new Decimal(0));
  const volumes = usable.flatMap(({ pool }) => {
    const volume = decimalOrNull(pool.volumeH24Usd);
    return volume ? [volume] : [];
  });
  return {
    representativePoolAddress: representative?.pool.poolAddress ?? null,
    priceUsd: representative?.pool.priceUsd ?? null,
    marketCapUsd: representative?.pool.marketCapUsd ?? null,
    fdvUsd: representative?.pool.fdvUsd ?? null,
    totalLiquidityUsd: usable.length > 0 ? total.toFixed() : null,
    largestPoolLiquidityUsd: representative?.liquidity.toFixed() ?? null,
    largestPoolShareBps: representative ? share(representative.liquidity) : null,
    topThreePoolShareBps: usable.length > 0 ? share(topThree) : null,
    volume24hUsd: volumes.length > 0 ? volumes.reduce((sum, value) => sum.plus(value), new Decimal(0)).toFixed() : null,
    usablePoolCount: usable.length,
    excludedPoolCount: unique.size - usable.length,
  };
}

export type HolderOwnerClassification = "UNCLASSIFIED" | "KNOWN_POOL" | "PROGRAM_CONTROLLED" | "KNOWN_SYSTEM";

export interface HolderOwnerBalance {
  readonly owner: string;
  readonly rawAmount: bigint;
  readonly tokenAccountCount: number;
  readonly classification: HolderOwnerClassification;
  readonly classificationEvidence: readonly string[];
}

export interface TokenHolderObservation {
  readonly mint: string;
  readonly rawSupply: bigint;
  readonly owners: readonly HolderOwnerBalance[];
  readonly sourceAccountLimit: number;
  readonly enumerationComplete: boolean;
}

export interface HolderAggregate {
  readonly enumeratedOwnerCount: number;
  readonly enumeratedRawAmount: bigint;
  readonly supplyCoverageBps: number | null;
  readonly top1ConcentrationBps: number | null;
  readonly top5ConcentrationBps: number | null;
  readonly top10ConcentrationBps: number | null;
  readonly enumerationComplete: boolean;
}

export function aggregateHolderEvidence(observation: TokenHolderObservation): HolderAggregate {
  const owners = [...observation.owners].sort((a, b) => a.rawAmount === b.rawAmount ? a.owner.localeCompare(b.owner) : a.rawAmount > b.rawAmount ? -1 : 1);
  const enumerated = owners.reduce((sum, owner) => sum + owner.rawAmount, 0n);
  const concentration = (count: number): number | null => observation.rawSupply > 0n
    ? Number(owners.slice(0, count).reduce((sum, owner) => sum + owner.rawAmount, 0n) * 10_000n / observation.rawSupply)
    : null;
  return {
    enumeratedOwnerCount: owners.length,
    enumeratedRawAmount: enumerated,
    supplyCoverageBps: observation.rawSupply > 0n ? Number(enumerated * 10_000n / observation.rawSupply) : null,
    top1ConcentrationBps: concentration(1),
    top5ConcentrationBps: concentration(5),
    top10ConcentrationBps: concentration(10),
    enumerationComplete: observation.enumerationComplete,
  };
}

export interface TokenIdentityProvider {
  readonly name: string;
  getIdentity(mint: string): Promise<ProviderObservation<TokenIdentityObservation>>;
}

export interface TokenPoolProvider {
  readonly name: string;
  getMarkets(mints: readonly string[]): Promise<ReadonlyMap<string, ProviderObservation<TokenMarketObservation>>>;
}

export interface TokenHolderProvider {
  readonly name: string;
  getHolderEvidence(mint: string): Promise<ProviderObservation<TokenHolderObservation>>;
}

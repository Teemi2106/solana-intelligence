import type { ObservationProvenance, ProviderObservation, TokenMarketObservation, TokenPoolObservation, TokenPoolProvider } from "@swi/domain";
import { isLosslessNumber, parse } from "lossless-json";
import { z } from "zod";
import { MinIntervalLimiter } from "./rate-limiter.js";

const decimalString = z.union([z.string(), z.custom<unknown>(isLosslessNumber)]).transform((value) => typeof value === "string" ? value : String(value));
const optionalDecimal = decimalString.nullable().optional().transform((value) => value ?? null);
const integer = z.union([z.number().int(), z.custom<unknown>(isLosslessNumber)]).transform((value) => Number(String(value)));
const token = z.object({ address: z.string().min(32).max(64), name: z.string().optional(), symbol: z.string().optional() }).loose();
const txnWindow = z.object({ buys: integer, sells: integer }).loose();
const pair = z.object({
  chainId: z.literal("solana"),
  dexId: z.string().min(1).max(100),
  pairAddress: z.string().min(20).max(100),
  labels: z.array(z.string().max(100)).max(20).nullable().optional(),
  baseToken: token,
  quoteToken: token,
  priceNative: optionalDecimal,
  priceUsd: optionalDecimal,
  liquidity: z.object({ usd: optionalDecimal, base: optionalDecimal, quote: optionalDecimal }).nullable().optional(),
  volume: z.record(z.string(), decimalString).optional(),
  txns: z.record(z.string(), txnWindow).optional(),
  fdv: optionalDecimal,
  marketCap: optionalDecimal,
  pairCreatedAt: integer.nullable().optional(),
}).loose();
const responseSchema = z.array(pair).max(10_000);

export class DexScreenerRequestError extends Error {
  constructor(readonly code: "RATE_LIMITED" | "TIMEOUT" | "UNAVAILABLE" | "INVALID_RESPONSE", readonly retryable: boolean, readonly retryAfterMs?: number) {
    super(`DEXSCREENER_${code}`);
    this.name = "DexScreenerRequestError";
  }
}

export interface DexScreenerOptions {
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly minIntervalMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => Date;
}

/** Current Solana pool evidence. JSON numbers are parsed as LosslessNumber before validation/string conversion. */
export class DexScreenerTokenPoolProvider implements TokenPoolProvider {
  readonly name = "dexscreener";
  private readonly request: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly limiter: MinIntervalLimiter;
  private readonly now: () => Date;

  constructor(options: DexScreenerOptions = {}) {
    this.request = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://api.dexscreener.com";
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? (() => new Date());
    this.limiter = new MinIntervalLimiter(options.minIntervalMs ?? 250, this.sleep, () => this.now().getTime());
  }

  async getMarkets(mints: readonly string[]): Promise<ReadonlyMap<string, ProviderObservation<TokenMarketObservation>>> {
    const unique = [...new Set(mints)].sort();
    const pools = new Map<string, TokenPoolObservation[]>();
    const fetchedAt = this.now();
    for (let start = 0; start < unique.length; start += 30) {
      const batch = unique.slice(start, start + 30);
      const parsed = await this.fetchBatch(batch);
      for (const dto of parsed) {
        const normalized = normalize(dto);
        for (const mint of batch) {
          if (dto.baseToken.address === mint || dto.quoteToken.address === mint)
            pools.set(mint, [...(pools.get(mint) ?? []), normalized]);
        }
      }
    }
    const result = new Map<string, ProviderObservation<TokenMarketObservation>>();
    for (const mint of unique) {
      const provenance: ObservationProvenance = { provider: this.name, observedAt: fetchedAt, fetchedAt, chainSlot: null, methodologyVersion: "dexscreener-pools-v1" };
      const found = pools.get(mint) ?? [];
      result.set(mint, found.length > 0
        ? { status: "AVAILABLE", data: { mint, pools: found }, provenance }
        : { status: "NOT_FOUND", reasonCode: "NO_MARKET", provenance });
    }
    return result;
  }

  private async fetchBatch(mints: readonly string[]): Promise<z.infer<typeof responseSchema>> {
    const url = new URL(`/tokens/v1/solana/${mints.join(",")}`, this.baseUrl);
    let last: DexScreenerRequestError = new DexScreenerRequestError("UNAVAILABLE", true);
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      if (attempt > 0) await this.sleep(2 ** attempt * 250);
      await this.limiter.acquire();
      try {
        const response = await this.request(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(this.timeoutMs) });
        if (response.status === 429 || response.status >= 500) {
          const retryAfter = Number(response.headers.get("retry-after"));
          const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1_000 : undefined;
          if (retryAfterMs) await this.sleep(retryAfterMs);
          last = new DexScreenerRequestError(response.status === 429 ? "RATE_LIMITED" : "UNAVAILABLE", true, retryAfterMs);
          continue;
        }
        if (!response.ok) throw new DexScreenerRequestError("INVALID_RESPONSE", false);
        const text = await response.text();
        let decoded: unknown;
        try { decoded = parse(text); } catch { throw new DexScreenerRequestError("INVALID_RESPONSE", false); }
        const validated = responseSchema.safeParse(decoded);
        if (!validated.success) throw new DexScreenerRequestError("INVALID_RESPONSE", false);
        return validated.data;
      } catch (error) {
        if (error instanceof DexScreenerRequestError) {
          if (!error.retryable) throw error;
          last = error;
        } else last = new DexScreenerRequestError("TIMEOUT", true);
      }
    }
    throw last;
  }
}

function normalize(dto: z.infer<typeof pair>): TokenPoolObservation {
  const window = (name: string) => dto.txns?.[name];
  return {
    poolAddress: dto.pairAddress,
    dex: dto.dexId,
    labels: dto.labels ?? [],
    baseMint: dto.baseToken.address,
    quoteMint: dto.quoteToken.address,
    priceUsd: dto.priceUsd,
    priceNative: dto.priceNative,
    liquidityUsd: dto.liquidity?.usd ?? null,
    baseLiquidity: dto.liquidity?.base ?? null,
    quoteLiquidity: dto.liquidity?.quote ?? null,
    volumeH1Usd: dto.volume?.["h1"] ?? null,
    volumeH6Usd: dto.volume?.["h6"] ?? null,
    volumeH24Usd: dto.volume?.["h24"] ?? null,
    h1Buys: window("h1")?.buys ?? null,
    h1Sells: window("h1")?.sells ?? null,
    h24Buys: window("h24")?.buys ?? null,
    h24Sells: window("h24")?.sells ?? null,
    fdvUsd: dto.fdv,
    marketCapUsd: dto.marketCap,
    pairCreatedAt: dto.pairCreatedAt === null || dto.pairCreatedAt === undefined ? null : new Date(dto.pairCreatedAt),
  };
}

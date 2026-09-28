import type {
  AuthorityState,
  HolderOwnerBalance,
  ObservationProvenance,
  ProviderObservation,
  TokenHolderObservation,
  TokenHolderProvider,
  TokenIdentityObservation,
  TokenIdentityProvider,
} from "@swi/domain";
import { z } from "zod";
import { ProviderRequestError } from "./errors";
import { defaultSleep, requestJson } from "./http";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const knownSystemAccounts = new Set([SYSTEM_PROGRAM, "1nc1nerator11111111111111111111111111111111"]);
const envelope = <T extends z.ZodType>(result: T) => z.object({ result });
const mintAccount = envelope(z.object({
  context: z.object({ slot: z.number().int().nonnegative() }),
  value: z.object({
    owner: z.string(),
    data: z.object({ parsed: z.object({ info: z.object({
      decimals: z.number().int().min(0).max(30),
      supply: z.string().regex(/^\d+$/),
      mintAuthority: z.string().nullable().optional(),
      freezeAuthority: z.string().nullable().optional(),
    }).loose() }).loose() }).loose(),
  }).nullable(),
}));
const asset = envelope(z.object({
  id: z.string(),
  content: z.object({
    json_uri: z.string().max(2_048).nullable().optional(),
    metadata: z.object({ name: z.string().max(500).nullable().optional(), symbol: z.string().max(100).nullable().optional() }).loose().optional(),
  }).loose().nullable().optional(),
}).loose().nullable());
const largestAccounts = envelope(z.object({
  context: z.object({ slot: z.number().int().nonnegative() }),
  value: z.array(z.object({ address: z.string(), amount: z.string().regex(/^\d+$/), decimals: z.number().int() })).max(20),
}));
const tokenAccountInfo = z.object({ data: z.object({ parsed: z.object({ info: z.object({ owner: z.string() }).loose() }).loose() }).loose() }).loose().nullable();
const tokenAccounts = envelope(z.object({ value: z.array(tokenAccountInfo) }));
const ownerAccountInfo = z.object({ owner: z.string(), executable: z.boolean() }).loose().nullable();
const ownerAccounts = envelope(z.object({ value: z.array(ownerAccountInfo) }));

export interface HeliusTokenIntelligenceOptions {
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => Date;
}

/** Finalized on-chain identity and bounded largest-account evidence through the existing Helius RPC account. */
export class HeliusTokenIntelligenceProvider implements TokenIdentityProvider, TokenHolderProvider {
  readonly name = "helius-rpc";
  private readonly baseUrl: string;
  private readonly now: () => Date;

  constructor(private readonly options: HeliusTokenIntelligenceOptions) {
    this.baseUrl = options.baseUrl ?? "https://mainnet.helius-rpc.com";
    this.now = options.now ?? (() => new Date());
  }

  async getIdentity(mint: string): Promise<ProviderObservation<TokenIdentityObservation>> {
    const fetchedAt = this.now();
    const [mintRaw, assetRaw] = await Promise.all([
      this.rpc("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "finalized" }]),
      this.rpc("getAsset", { id: mint, displayOptions: { showFungible: true } }),
    ]);
    const parsedMint = mintAccount.safeParse(mintRaw);
    if (!parsedMint.success) throw new ProviderRequestError("Helius returned invalid mint account data", "INVALID_RESPONSE", false);
    const value = parsedMint.data.result.value;
    const provenance: ObservationProvenance = {
      provider: this.name, observedAt: fetchedAt, fetchedAt,
      chainSlot: BigInt(parsedMint.data.result.context.slot), methodologyVersion: "helius-token-identity-v1",
    };
    if (!value) return { status: "NOT_FOUND", reasonCode: "MINT_NOT_FOUND", provenance };
    const parsedAsset = asset.safeParse(assetRaw);
    const metadata = parsedAsset.success && parsedAsset.data.result?.content?.metadata
      ? { status: "AVAILABLE" as const, name: parsedAsset.data.result.content.metadata.name ?? null, symbol: parsedAsset.data.result.content.metadata.symbol ?? null, uri: parsedAsset.data.result.content.json_uri ?? null }
      : { status: "MISSING" as const, name: null, symbol: null, uri: null };
    const info = value.data.parsed.info;
    const data: TokenIdentityObservation = {
      mint,
      tokenProgram: value.owner,
      decimals: info.decimals,
      rawSupply: BigInt(info.supply),
      mintAuthority: authority(info.mintAuthority),
      freezeAuthority: authority(info.freezeAuthority),
      metadata,
    };
    return parsedAsset.success
      ? { status: "AVAILABLE", data, provenance }
      : { status: "PARTIAL", data, unavailableFields: ["metadata"], provenance };
  }

  async getHolderEvidence(mint: string): Promise<ProviderObservation<TokenHolderObservation>> {
    const fetchedAt = this.now();
    const [largestRaw, supplyRaw] = await Promise.all([
      this.rpc("getTokenLargestAccounts", [mint, { commitment: "finalized" }]),
      this.rpc("getTokenSupply", [mint, { commitment: "finalized" }]),
    ]);
    const largest = largestAccounts.safeParse(largestRaw);
    const supply = envelope(z.object({ context: z.object({ slot: z.number().int().nonnegative() }), value: z.object({ amount: z.string().regex(/^\d+$/) }) })).safeParse(supplyRaw);
    if (!largest.success || !supply.success) throw new ProviderRequestError("Helius returned invalid holder evidence", "INVALID_RESPONSE", false);
    const addresses = largest.data.result.value.map((row) => row.address);
    const accountsRaw = await this.rpc("getMultipleAccounts", [addresses, { encoding: "jsonParsed", commitment: "finalized" }]);
    const accounts = tokenAccounts.safeParse(accountsRaw);
    if (!accounts.success || accounts.data.result.value.length !== addresses.length) throw new ProviderRequestError("Helius returned invalid token account owners", "INVALID_RESPONSE", false);
    const ownerAmounts = new Map<string, { rawAmount: bigint; tokenAccountCount: number }>();
    accounts.data.result.value.forEach((account, index) => {
      const owner = account?.data.parsed.info.owner;
      const row = largest.data.result.value[index];
      if (!owner || !row) return;
      const current = ownerAmounts.get(owner) ?? { rawAmount: 0n, tokenAccountCount: 0 };
      ownerAmounts.set(owner, { rawAmount: current.rawAmount + BigInt(row.amount), tokenAccountCount: current.tokenAccountCount + 1 });
    });
    const owners = [...ownerAmounts.keys()];
    const classifications = await this.classifyOwners(owners);
    const balances: HolderOwnerBalance[] = owners.map((owner) => ({
      owner,
      rawAmount: ownerAmounts.get(owner)?.rawAmount ?? 0n,
      tokenAccountCount: ownerAmounts.get(owner)?.tokenAccountCount ?? 0,
      ...(classifications.get(owner) ?? { classification: "UNCLASSIFIED" as const, classificationEvidence: [] }),
    }));
    const provenance: ObservationProvenance = {
      provider: this.name, observedAt: fetchedAt, fetchedAt,
      chainSlot: BigInt(Math.max(largest.data.result.context.slot, supply.data.result.context.slot)), methodologyVersion: "helius-largest-token-accounts-v1",
    };
    return {
      status: "PARTIAL",
      data: { mint, rawSupply: BigInt(supply.data.result.value.amount), owners: balances, sourceAccountLimit: 20, enumerationComplete: false },
      unavailableFields: ["authoritativeHolderCount", "completeOwnerDistribution"],
      provenance,
    };
  }

  private async classifyOwners(owners: readonly string[]): Promise<ReadonlyMap<string, Pick<HolderOwnerBalance, "classification" | "classificationEvidence">>> {
    if (owners.length === 0) return new Map();
    const raw = await this.rpc("getMultipleAccounts", [owners, { encoding: "base64", commitment: "finalized" }]);
    const parsed = ownerAccounts.safeParse(raw);
    if (!parsed.success || parsed.data.result.value.length !== owners.length) return new Map();
    const result = new Map<string, Pick<HolderOwnerBalance, "classification" | "classificationEvidence">>();
    owners.forEach((owner, index) => {
      if (knownSystemAccounts.has(owner)) result.set(owner, { classification: "KNOWN_SYSTEM", classificationEvidence: ["KNOWN_SYSTEM_ADDRESS"] });
      else {
        const account = parsed.data.result.value[index];
        if (account?.executable) result.set(owner, { classification: "PROGRAM_CONTROLLED", classificationEvidence: ["EXECUTABLE_ACCOUNT"] });
        else if (account && account.owner !== SYSTEM_PROGRAM) result.set(owner, { classification: "PROGRAM_CONTROLLED", classificationEvidence: [`ACCOUNT_OWNED_BY_PROGRAM:${account.owner}`] });
      }
    });
    return result;
  }

  private rpc(method: string, params: unknown): Promise<unknown> {
    const url = new URL("/", this.baseUrl);
    url.searchParams.set("api-key", this.options.apiKey);
    return requestJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }, {
      fetch: this.options.fetch ?? fetch,
      timeoutMs: this.options.timeoutMs ?? 15_000,
      maxAttempts: this.options.maxAttempts ?? 3,
      sleep: this.options.sleep ?? defaultSleep,
      label: "Helius token intelligence",
      operation: method,
      sensitiveValues: [this.options.apiKey],
    });
  }
}

const authority = (address: string | null | undefined): AuthorityState => address ? { status: "ENABLED", address } : { status: "REVOKED" };

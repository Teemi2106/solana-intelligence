import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@swi/db";
import { createTestDatabase, requireDatabase } from "@swi/db/testing";
import type { ObservationProvenance, TokenHolderProvider, TokenIdentityProvider, TokenPoolProvider } from "@swi/domain";
import { enrichTokenRequest } from "./token-intelligence.js";

const context = await createTestDatabase();
afterAll(() => context?.dispose());
const NOW = new Date("2026-09-28T12:00:00Z");
const provenance: ObservationProvenance = { provider: "test", observedAt: NOW, fetchedAt: NOW, chainSlot: 42n, methodologyVersion: "test-v1" };

describe.skipIf(!context)("token intelligence lifecycle", () => {
  const database = () => requireDatabase(context);
  beforeEach(async () => {
    await database().sql`truncate tokens restart identity cascade`;
  });

  it("claims concurrent work once and persists independent evidence plus explicit limitations", async () => {
    const [token] = await database().query.insert(schema.tokens).values({ mint: "Mint111111111111111111111111111111111111111" }).returning();
    if (!token) throw new Error("token");
    const [request] = await database().query.insert(schema.tokenEnrichmentRequests).values({ tokenId: token.id, tier: "FULL", reasons: ["WALLET_ASSET"], requestedComponents: ["IDENTITY", "MARKET", "HOLDERS"], freshnessBucket: NOW, nextAttemptAt: NOW }).returning();
    if (!request) throw new Error("request");
    const identity = { name: "identity", getIdentity: vi.fn<TokenIdentityProvider["getIdentity"]>().mockResolvedValue({ status: "AVAILABLE", provenance, data: { mint: token.mint, tokenProgram: "TokenProgram", decimals: 9, rawSupply: 1000n, mintAuthority: { status: "REVOKED" }, freezeAuthority: { status: "ENABLED", address: "Freeze" }, metadata: { status: "AVAILABLE", name: "Token", symbol: "TOK", uri: null } } }) } satisfies TokenIdentityProvider;
    const markets = { name: "markets", getMarkets: vi.fn<TokenPoolProvider["getMarkets"]>().mockResolvedValue(new Map([[token.mint, { status: "AVAILABLE", provenance, data: { mint: token.mint, pools: [{ poolAddress: "pool", dex: "dex", labels: [], baseMint: token.mint, quoteMint: "quote", priceUsd: "1", priceNative: "2", liquidityUsd: "100", baseLiquidity: "10", quoteLiquidity: "20", volumeH1Usd: null, volumeH6Usd: null, volumeH24Usd: "5", h1Buys: null, h1Sells: null, h24Buys: 2, h24Sells: 1, fdvUsd: "1000", marketCapUsd: null, pairCreatedAt: NOW }] } }]])) } satisfies TokenPoolProvider;
    const holders = { name: "holders", getHolderEvidence: vi.fn<TokenHolderProvider["getHolderEvidence"]>().mockResolvedValue({ status: "PARTIAL", provenance, unavailableFields: ["authoritativeHolderCount"], data: { mint: token.mint, rawSupply: 1000n, sourceAccountLimit: 20, enumerationComplete: false, owners: [{ owner: "owner", rawAmount: 500n, tokenAccountCount: 1, classification: "UNCLASSIFIED", classificationEvidence: [] }] } }) } satisfies TokenHolderProvider;
    const dependencies = { database: database(), identity, markets, holders, freshness: { marketMs: 300_000, holdersMs: 86_400_000, metadataMs: 86_400_000, authoritiesMs: 21_600_000 }, now: () => NOW };
    const results = await Promise.all([enrichTokenRequest(dependencies, request.id), enrichTokenRequest(dependencies, request.id)]);
    expect(results.map((result) => result.status).sort()).toEqual(["ALREADY_CLAIMED", "COMPLETED"]);
    expect(identity.getIdentity).toHaveBeenCalledTimes(1);
    expect(await database().query.select().from(schema.tokenPoolSnapshots)).toHaveLength(1);
    expect(await database().query.select().from(schema.tokenHolderTopOwners)).toHaveLength(1);
    const [risk] = await database().query.select().from(schema.tokenRiskSnapshots);
    expect(risk?.derivedIndicators).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MINT_AUTHORITY_ENABLED", state: "ABSENT" }),
      expect.objectContaining({ code: "SINGLE_USABLE_POOL", state: "PRESENT" }),
      expect.objectContaining({ code: "HOLDER_ENUMERATION_INCOMPLETE", state: "PRESENT" }),
    ]));
  });

  it("keeps successful components when another provider fails and defers the durable request", async () => {
    const [token] = await database().query.insert(schema.tokens).values({ mint: "Mint222222222222222222222222222222222222222" }).returning();
    if (!token) throw new Error("token");
    const [request] = await database().query.insert(schema.tokenEnrichmentRequests).values({ tokenId: token.id, tier: "FULL", reasons: ["WALLET_ASSET"], requestedComponents: ["IDENTITY", "MARKET"], freshnessBucket: NOW, nextAttemptAt: NOW }).returning();
    if (!request) throw new Error("request");
    const identity: TokenIdentityProvider = { name: "identity", getIdentity: () => Promise.resolve({ status: "AVAILABLE", provenance, data: { mint: token.mint, tokenProgram: "TokenProgram", decimals: 9, rawSupply: 1n, mintAuthority: { status: "REVOKED" }, freezeAuthority: { status: "REVOKED" }, metadata: { status: "MISSING", name: null, symbol: null, uri: null } } }) };
    const markets: TokenPoolProvider = { name: "markets", getMarkets: () => Promise.reject(new Error("secret provider body")) };
    const holders: TokenHolderProvider = { name: "holders", getHolderEvidence: () => Promise.reject(new Error("unused")) };
    expect(await enrichTokenRequest({ database: database(), identity, markets, holders, freshness: { marketMs: 300_000, holdersMs: 86_400_000, metadataMs: 86_400_000, authoritiesMs: 21_600_000 }, now: () => NOW }, request.id)).toMatchObject({ status: "DEFERRED", components: ["IDENTITY"] });
    expect(await database().query.select().from(schema.tokenIdentitySnapshots)).toHaveLength(1);
    const [pending] = await database().query.select().from(schema.tokenEnrichmentRequests);
    expect(pending).toMatchObject({ status: "PENDING", lastErrorCode: "MARKET_UNAVAILABLE" });
  });
});

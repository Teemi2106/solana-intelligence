import { describe, expect, it, vi } from "vitest";
import { HeliusTokenIntelligenceProvider } from "./helius-token-intelligence.js";

const mint = "Mint111111111111111111111111111111111111111";
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("HeliusTokenIntelligenceProvider", () => {
  it("normalizes identity and keeps missing metadata explicit", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ result: { context: { slot: 42 }, value: { owner: "TokenProgram", data: { parsed: { info: { decimals: 9, supply: "123456789012345678901", mintAuthority: "Authority", freezeAuthority: null } } } } } }))
      .mockResolvedValueOnce(response({ result: { id: mint, content: null } }));
    const result = await new HeliusTokenIntelligenceProvider({ apiKey: "secret", fetch: request, sleep: () => Promise.resolve() }).getIdentity(mint);
    expect(result).toMatchObject({ status: "AVAILABLE", data: { rawSupply: 123456789012345678901n, mintAuthority: { status: "ENABLED", address: "Authority" }, freezeAuthority: { status: "REVOKED" }, metadata: { status: "MISSING" } } });
  });

  it("reports bounded owner concentration evidence as incomplete", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ result: { context: { slot: 50 }, value: [{ address: "ta1", amount: "400", decimals: 0 }, { address: "ta2", amount: "100", decimals: 0 }] } }))
      .mockResolvedValueOnce(response({ result: { context: { slot: 50 }, value: { amount: "1000" } } }))
      .mockResolvedValueOnce(response({ result: { value: [{ data: { parsed: { info: { owner: "owner1" } } } }, { data: { parsed: { info: { owner: "owner1" } } } }] } }))
      .mockResolvedValueOnce(response({ result: { value: [{ owner: "SomeProgram", executable: false }] } }));
    const result = await new HeliusTokenIntelligenceProvider({ apiKey: "secret", fetch: request, sleep: () => Promise.resolve() }).getHolderEvidence(mint);
    expect(result).toMatchObject({ status: "PARTIAL", data: { rawSupply: 1000n, sourceAccountLimit: 20, enumerationComplete: false, owners: [{ owner: "owner1", rawAmount: 500n, tokenAccountCount: 2, classification: "PROGRAM_CONTROLLED" }] }, unavailableFields: ["authoritativeHolderCount", "completeOwnerDistribution"] });
  });
});

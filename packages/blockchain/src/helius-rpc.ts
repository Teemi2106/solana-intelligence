import type { FinalityProvider, FinalityStatus, TokenLaunchProvider, TokenLaunchResult } from "@swi/domain";
import { z } from "zod";
import { ProviderRequestError } from "./errors";
import { defaultSleep, requestJson } from "./http";

export interface HeliusRpcOptions {
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly baseUrl?: string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const statusesResponse = z.object({
  result: z.object({ value: z.array(z.object({ confirmationStatus: z.string().nullable().optional(), err: z.unknown().nullable().optional() }).nullable()) }),
});

const accountKey = z.union([z.string(), z.object({ pubkey: z.string(), signer: z.boolean().optional() })]);
const firstActivityResponse = z.object({
  result: z.object({
    data: z.array(z.object({
      slot: z.number().int().nonnegative(),
      blockTime: z.number().int().nonnegative().nullable().optional(),
      transaction: z.object({ signatures: z.array(z.string()).min(1), message: z.object({ accountKeys: z.array(accountKey).min(1) }) }),
    })),
  }),
});

/** Standard Solana RPC (finality) and Helius' getTransactionsForAddress (a token's earliest activity). */
export class HeliusRpcClient implements FinalityProvider, TokenLaunchProvider {
  private readonly baseUrl: string;

  constructor(private readonly options: HeliusRpcOptions) {
    this.baseUrl = options.baseUrl ?? "https://mainnet.helius-rpc.com";
  }

  async getFinality(signatures: readonly string[]): Promise<ReadonlyMap<string, FinalityStatus>> {
    const out = new Map<string, FinalityStatus>();
    for (let start = 0; start < signatures.length; start += 256) {
      const batch = signatures.slice(start, start + 256);
      const parsed = statusesResponse.safeParse(await this.rpc("getSignatureStatuses", [batch, { searchTransactionHistory: true }]));
      if (!parsed.success || parsed.data.result.value.length !== batch.length) throw new ProviderRequestError("Helius RPC returned invalid signature statuses", "INVALID_RESPONSE", false);
      batch.forEach((signature, index) => {
        const status = parsed.data.result.value[index];
        if (!status) out.set(signature, "NOT_FOUND");
        else if (status.err !== null && status.err !== undefined) out.set(signature, "FAILED");
        else out.set(signature, status.confirmationStatus === "finalized" ? "FINALIZED" : "CONFIRMED");
      });
    }
    return out;
  }

  async getFirstActivity(mint: string): Promise<TokenLaunchResult> {
    const parsed = firstActivityResponse.safeParse(await this.rpc("getTransactionsForAddress", [mint, { transactionDetails: "full", encoding: "jsonParsed", maxSupportedTransactionVersion: 0, sortOrder: "asc", limit: 1 }]));
    if (!parsed.success) return { status: "UNAVAILABLE", reason: "INVALID_RESPONSE" };
    const [first] = parsed.data.result.data;
    if (!first?.blockTime) return { status: "UNAVAILABLE", reason: "NO_ACTIVITY_FOUND" };
    const [signer] = first.transaction.message.accountKeys;
    return {
      status: "FOUND", firstActivityAt: new Date(first.blockTime * 1000), firstActivitySlot: BigInt(first.slot),
      firstSignature: first.transaction.signatures[0] ?? "", firstSigner: signer ? (typeof signer === "string" ? signer : signer.pubkey) : null,
    };
  }

  private rpc(method: string, params: unknown): Promise<unknown> {
    const url = new URL("/", this.baseUrl);
    url.searchParams.set("api-key", this.options.apiKey);
    return requestJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }, {
      fetch: this.options.fetch ?? fetch, timeoutMs: this.options.timeoutMs ?? 15_000, maxAttempts: this.options.maxAttempts ?? 3, sleep: this.options.sleep ?? defaultSleep, label: "Helius RPC",
    });
  }
}

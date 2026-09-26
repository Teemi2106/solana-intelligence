import type {
  HealthCheck,
  LiveSubscriptionProvider,
  LiveSubscriptionState,
} from "@swi/domain";
import { z } from "zod";
import { ProviderRequestError } from "./errors";
import { heliusAuthHeaderValue } from "./helius-webhook";
import { defaultSleep, requestJson } from "./http";

/** Helius allows 100,000 addresses per webhook (API). */
export const HELIUS_MAX_WEBHOOK_ADDRESSES = 100_000;

const webhookSchema = z.object({
  webhookID: z.string().min(1),
  webhookURL: z.string(),
  webhookType: z.string().optional(),
  accountAddresses: z.array(z.string()).default([]),
  active: z.boolean().optional(),
});
type HeliusWebhook = z.infer<typeof webhookSchema>;

export interface HeliusWebhookManagerOptions {
  readonly apiKey: string;
  /** The public URL this system receives webhooks on; identifies "our" webhook among the account's webhooks. */
  readonly webhookUrl: string;
  readonly webhookSecret: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly baseUrl?: string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Manages one enhanced Helius webhook. Management calls cost credits, so callers diff before writing.
 * Every write is followed by a read-back, because update semantics are verified rather than assumed.
 */
export class HeliusWebhookManager implements LiveSubscriptionProvider {
  readonly maxAddresses = HELIUS_MAX_WEBHOOK_ADDRESSES;
  private readonly baseUrl: string;

  constructor(private readonly options: HeliusWebhookManagerOptions) {
    this.baseUrl = options.baseUrl ?? "https://mainnet.helius-rpc.com";
  }

  async findSubscription(): Promise<LiveSubscriptionState | null> {
    const listed = z
      .array(webhookSchema)
      .safeParse(await this.call("GET", "/v0/webhooks"));
    if (!listed.success)
      throw new ProviderRequestError(
        "Helius returned an invalid webhook list",
        "INVALID_RESPONSE",
        false,
      );
    const ours = listed.data.filter(
      (webhook) => webhook.webhookURL === this.options.webhookUrl,
    );
    // More than one webhook for our URL means duplicate deliveries; refuse to pick one silently.
    if (ours.length > 1)
      throw new ProviderRequestError(
        "Multiple Helius webhooks deliver to this URL",
        "INVALID_RESPONSE",
        false,
      );
    const [only] = ours;
    return only ? this.toState(only) : null;
  }

  async createSubscription(
    addresses: readonly string[],
  ): Promise<LiveSubscriptionState> {
    this.assertLimit(addresses);
    const created = await this.call("POST", "/v0/webhooks", {
      webhookURL: this.options.webhookUrl,
      webhookType: "enhanced",
      transactionTypes: [],
      accountAddresses: addresses,
      authHeader: heliusAuthHeaderValue(this.options.webhookSecret),
    });
    const parsed = webhookSchema.safeParse(created);
    if (!parsed.success)
      throw new ProviderRequestError(
        "Helius returned an invalid webhook",
        "INVALID_RESPONSE",
        false,
      );
    return this.readBack(parsed.data.webhookID);
  }

  async replaceAddresses(
    externalId: string,
    addresses: readonly string[],
  ): Promise<LiveSubscriptionState> {
    this.assertLimit(addresses);
    await this.call("PUT", `/v0/webhooks/${encodeURIComponent(externalId)}`, {
      webhookURL: this.options.webhookUrl,
      webhookType: "enhanced",
      transactionTypes: [],
      accountAddresses: addresses,
      authHeader: heliusAuthHeaderValue(this.options.webhookSecret),
    });
    return this.readBack(externalId);
  }

  async setActive(
    externalId: string,
    active: boolean,
  ): Promise<LiveSubscriptionState> {
    await this.call("PATCH", `/v0/webhooks/${encodeURIComponent(externalId)}`, {
      active,
    });
    return this.readBack(externalId);
  }

  async checkHealth(): Promise<HealthCheck> {
    const started = performance.now();
    try {
      await this.call("GET", "/v0/webhooks");
      return {
        name: "helius-webhooks",
        status: "up",
        latencyMs: Math.round(performance.now() - started),
      };
    } catch {
      return {
        name: "helius-webhooks",
        status: "down",
        latencyMs: Math.round(performance.now() - started),
      };
    }
  }

  private async readBack(externalId: string): Promise<LiveSubscriptionState> {
    const parsed = webhookSchema.safeParse(
      await this.call("GET", `/v0/webhooks/${encodeURIComponent(externalId)}`),
    );
    if (!parsed.success)
      throw new ProviderRequestError(
        "Helius returned an invalid webhook",
        "INVALID_RESPONSE",
        false,
      );
    return this.toState(parsed.data);
  }

  private toState(webhook: HeliusWebhook): LiveSubscriptionState {
    return {
      externalId: webhook.webhookID,
      webhookUrl: webhook.webhookURL,
      addresses: [...new Set(webhook.accountAddresses)].sort(),
      active: webhook.active ?? true,
    };
  }

  private assertLimit(addresses: readonly string[]): void {
    if (addresses.length > this.maxAddresses)
      throw new ProviderRequestError(
        "Tracked wallet count exceeds the Helius webhook address limit",
        "INVALID_RESPONSE",
        false,
      );
  }

  private call(
    method: "GET" | "POST" | "PUT" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    url.searchParams.set("api-key", this.options.apiKey);
    const operation =
      method === "GET"
        ? "list"
        : method === "POST"
          ? "create"
          : method === "PUT"
            ? "update"
            : "update";
    const requestMetadata = {
      method,
      operation,
      path,
      hasBody: body !== undefined,
      ...(body && typeof body === "object"
        ? {
            bodyKeys: Object.keys(body),
            webhookType: (body as Record<string, unknown>)["webhookType"],
            accountAddressCount: Array.isArray(
              (body as Record<string, unknown>)["accountAddresses"],
            )
              ? (
                  (body as Record<string, unknown>)[
                    "accountAddresses"
                  ] as unknown[]
                ).length
              : undefined,
            transactionTypeCount: Array.isArray(
              (body as Record<string, unknown>)["transactionTypes"],
            )
              ? (
                  (body as Record<string, unknown>)[
                    "transactionTypes"
                  ] as unknown[]
                ).length
              : undefined,
            hasWebhookUrl:
              typeof (body as Record<string, unknown>)["webhookURL"] ===
              "string",
            hasAuthHeader:
              typeof (body as Record<string, unknown>)["authHeader"] ===
              "string",
          }
        : {}),
    };
    return requestJson(
      url,
      {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      {
        fetch: this.options.fetch ?? fetch,
        timeoutMs: this.options.timeoutMs ?? 15_000,
        maxAttempts: this.options.maxAttempts ?? 3,
        sleep: this.options.sleep ?? defaultSleep,
        label: "Helius webhooks",
        operation,
        requestMetadata,
        sensitiveValues: [
          this.options.apiKey,
          heliusAuthHeaderValue(this.options.webhookSecret),
        ],
      },
    );
  }
}

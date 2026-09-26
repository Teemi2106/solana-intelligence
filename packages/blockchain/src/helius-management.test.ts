import { describe, expect, it, vi } from "vitest";
import { defined } from "@swi/domain";
import { HeliusWebhookManager } from "./helius-management";
import { heliusAuthHeaderValue } from "./helius-webhook";
import type { ProviderRequestError } from "./errors";

const URL_OURS = "https://example.com/api/webhooks/helius";
const secret = "s".repeat(40);
const apiKey = "very-secret-api-key";

interface FakeWebhook {
  webhookID: string;
  webhookURL: string;
  webhookType: string;
  accountAddresses: string[];
  active: boolean;
  authHeader?: string;
}

/** In-memory Helius webhook API with the documented endpoints. */
function fakeHelius(initial: FakeWebhook[] = []) {
  const webhooks = new Map(
    initial.map((webhook) => [webhook.webhookID, webhook]),
  );
  const calls: { method: string; path: string; body: unknown }[] = [];
  const request = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({ method, path: url.pathname, body });
    expect(url.searchParams.get("api-key")).toBe(apiKey);
    const id = url.pathname.split("/")[3];
    const reply = (value: unknown) =>
      Promise.resolve(new Response(JSON.stringify(value), { status: 200 }));
    if (method === "GET" && !id) return reply([...webhooks.values()]);
    if (method === "GET" && id) return reply(webhooks.get(id));
    if (method === "POST") {
      const created: FakeWebhook = {
        webhookID: `wh_${String(webhooks.size + 1)}`,
        active: true,
        webhookURL: String(body?.["webhookURL"]),
        webhookType: String(body?.["webhookType"]),
        accountAddresses: body?.["accountAddresses"] as string[],
        authHeader: String(body?.["authHeader"]),
      };
      webhooks.set(created.webhookID, created);
      return reply(created);
    }
    if (method === "PUT" && id) {
      const existing = defined(webhooks.get(id));
      const updated = {
        ...existing,
        accountAddresses: body?.["accountAddresses"] as string[],
      };
      webhooks.set(id, updated);
      return reply(updated);
    }
    if (method === "PATCH" && id) {
      const updated = {
        ...defined(webhooks.get(id)),
        active: Boolean(body?.["active"]),
      };
      webhooks.set(id, updated);
      return reply(updated);
    }
    return Promise.resolve(new Response("", { status: 404 }));
  });
  return { request, calls, webhooks };
}
const manager = (
  request: typeof fetch,
  extra: Partial<ConstructorParameters<typeof HeliusWebhookManager>[0]> = {},
) =>
  new HeliusWebhookManager({
    apiKey,
    webhookUrl: URL_OURS,
    webhookSecret: secret,
    fetch: request,
    sleep: () => Promise.resolve(),
    ...extra,
  });
const existing = (
  addresses: string[],
  overrides: Partial<FakeWebhook> = {},
): FakeWebhook => ({
  webhookID: "wh_1",
  webhookURL: URL_OURS,
  webhookType: "enhanced",
  accountAddresses: addresses,
  active: true,
  ...overrides,
});

describe("HeliusWebhookManager", () => {
  it("returns null when no webhook delivers to this system's URL and ignores other webhooks", async () => {
    const fake = fakeHelius([
      existing(["A"], { webhookURL: "https://other.example/hook" }),
    ]);
    expect(await manager(fake.request).findSubscription()).toBeNull();
  });

  it("finds our webhook and normalizes its address set", async () => {
    const fake = fakeHelius([existing(["B", "A", "A"])]);
    expect(await manager(fake.request).findSubscription()).toEqual({
      externalId: "wh_1",
      webhookUrl: URL_OURS,
      addresses: ["A", "B"],
      active: true,
    });
  });

  it("refuses to choose between duplicate webhooks for the same URL", async () => {
    const fake = fakeHelius([
      existing(["A"]),
      existing(["A"], { webhookID: "wh_2" }),
    ]);
    await expect(
      manager(fake.request).findSubscription(),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("creates an enhanced webhook with the configured auth header and reads it back", async () => {
    const fake = fakeHelius();
    const state = await manager(fake.request).createSubscription(["A", "B"]);
    expect(state).toMatchObject({
      externalId: "wh_1",
      addresses: ["A", "B"],
      active: true,
    });
    expect(fake.calls[0]).toMatchObject({
      method: "POST",
      body: {
        webhookType: "enhanced",
        webhookURL: URL_OURS,
        authHeader: heliusAuthHeaderValue(secret),
        transactionTypes: [],
      },
    });
    expect(fake.calls.at(-1)?.method).toBe("GET");
  });

  it("replaces addresses and verifies by reading the webhook back", async () => {
    const fake = fakeHelius([existing(["A"])]);
    const state = await manager(fake.request).replaceAddresses("wh_1", [
      "B",
      "C",
    ]);
    expect(state.addresses).toEqual(["B", "C"]);
    expect(fake.calls.map((call) => call.method)).toEqual(["PUT", "GET"]);
  });

  it("toggles a webhook on and off", async () => {
    const fake = fakeHelius([existing(["A"], { active: false })]);
    expect((await manager(fake.request).setActive("wh_1", true)).active).toBe(
      true,
    );
    expect(fake.calls[0]).toMatchObject({
      method: "PATCH",
      body: { active: true },
    });
  });

  it("refuses more addresses than the provider allows, before calling the provider", async () => {
    const fake = fakeHelius();
    const tooMany = Array.from(
      { length: 100_001 },
      (_, index) => `A${String(index)}`,
    );
    await expect(
      manager(fake.request).createSubscription(tooMany),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("retries a rate limit then succeeds", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("", { status: 429, headers: { "retry-after": "0" } }),
      )
      .mockResolvedValueOnce(new Response("[]", { status: 200 }));
    expect(await manager(request).findSubscription()).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("surfaces a provider timeout as a retryable error after bounded attempts", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    await expect(
      manager(request, { maxAttempts: 3 }).findSubscription(),
    ).rejects.toMatchObject<Partial<ProviderRequestError>>({
      code: "TIMEOUT",
      retryable: true,
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("does not retry authentication failures and never leaks the API key into errors", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("", { status: 401 }));
    const error = await manager(request)
      .findSubscription()
      .catch((thrown: unknown) => thrown as ProviderRequestError);
    expect(error).toMatchObject({ code: "UNAUTHORIZED", retryable: false });
    expect((error as Error).message).not.toContain(apiKey);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("captures safe diagnostics for deterministic validation failures", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid webhook URL" }), {
          status: 400,
        }),
      );
    const error = await manager(request)
      .createSubscription(["A"])
      .catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({
      code: "INVALID_RESPONSE",
      retryable: false,
      diagnostics: {
        status: 400,
        operation: "create",
        requestMetadata: {
          method: "POST",
          webhookType: "enhanced",
          accountAddressCount: 1,
          hasAuthHeader: true,
        },
      },
    });
    expect((error as ProviderRequestError).diagnostics?.responseBody).toContain("invalid webhook URL");
    expect(JSON.stringify(error)).not.toContain(apiKey);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect((error as ProviderRequestError).diagnostics?.requestUrl).toBe(
      "https://mainnet.helius-rpc.com/v0/webhooks",
    );
  });

  it("reports health from a real list call", async () => {
    expect((await manager(fakeHelius().request).checkHealth()).status).toBe(
      "up",
    );
    expect(
      (
        await manager(
          vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response("", { status: 401 })),
        ).checkHealth()
      ).status,
    ).toBe("down");
  });
});

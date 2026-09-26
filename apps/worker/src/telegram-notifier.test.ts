import { describe, expect, it, vi } from "vitest";
import { createTelegramNotifier, TELEGRAM_CONNECTIVITY_MESSAGE, TelegramNotifier } from "./telegram-notifier.js";

const token = "secret-bot-token";
const chatId = "secret-chat-id";
const message = { deduplicationKey: "test", severity: "INFO" as const, text: TELEGRAM_CONNECTIVITY_MESSAGE };

describe("TelegramNotifier", () => {
  it("uses the official sendMessage endpoint and serialized server-side chat configuration", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 }));
    await expect(new TelegramNotifier({ botToken: token, chatId, fetch: request }).deliver(message)).resolves.toEqual({ externalId: "42" });
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0] ?? [];
    expect(typeof url === "string" ? url : url instanceof URL ? url.toString() : url?.url).toBe(`https://api.telegram.org/bot${token}/sendMessage`);
    expect(JSON.parse(typeof init?.body === "string" ? init.body : "null")).toEqual({ chat_id: chatId, text: TELEGRAM_CONNECTIVITY_MESSAGE, disable_web_page_preview: true });
  });

  it("bounds retries and exposes no credentials in errors", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("bad", { status: 503 }));
    let error: unknown;
    try {
      await new TelegramNotifier({ botToken: token, chatId, fetch: request, maxAttempts: 2, sleep: () => Promise.resolve() }).deliver(message);
    } catch (thrown) {
      error = thrown;
    }
    expect(request).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("TELEGRAM_DELIVERY_FAILED");
    expect(JSON.stringify(error)).not.toContain(token);
    expect(JSON.stringify(error)).not.toContain(chatId);
  });

  it("creates no adapter and makes no request when disabled", () => {
    const request = vi.fn<typeof fetch>();
    expect(createTelegramNotifier({ enabled: false, botToken: token, chatId, fetch: request })).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
});

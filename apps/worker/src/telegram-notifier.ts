import type { HealthCheck, NotificationMessage, NotificationProvider } from "@swi/domain";

export interface TelegramNotifierOptions {
  readonly botToken: string;
  readonly chatId: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export function createTelegramNotifier(options: TelegramNotifierOptions & { readonly enabled: boolean }): TelegramNotifier | undefined {
  return options.enabled ? new TelegramNotifier(options) : undefined;
}

/** Server-only Telegram adapter used for temporary Phase 3 live-pipeline diagnostics. */
export class TelegramNotifier implements NotificationProvider {
  constructor(private readonly options: TelegramNotifierOptions) {}

  async deliver(message: NotificationMessage): Promise<{ externalId: string }> {
    const request = this.options.fetch ?? fetch;
    const attempts = this.options.maxAttempts ?? 3;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await (this.options.sleep ?? defaultSleep)(2 ** attempt * 250);
      try {
        const response = await request(`https://api.telegram.org/bot${this.options.botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: this.options.chatId, text: message.text, disable_web_page_preview: true }),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
        });
        if (!response.ok) continue;
        const body = await response.json() as { ok?: boolean; result?: { message_id?: number } };
        if (body.ok === true && typeof body.result?.message_id === "number") return { externalId: String(body.result.message_id) };
      } catch {
        // Retry below. Errors are deliberately replaced with a credential-safe adapter error.
      }
    }
    throw new Error("TELEGRAM_DELIVERY_FAILED");
  }

  checkHealth(): Promise<HealthCheck> {
    return Promise.resolve({ name: "telegram", status: "up", latencyMs: 0 });
  }
}

const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export const TELEGRAM_CONNECTIVITY_MESSAGE = [
  "🎲 Degen Scout is online.",
  "",
  "Telegram connection confirmed ✅",
  "Waiting for live wallet activity...",
].join("\n");

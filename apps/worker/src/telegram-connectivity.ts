import { parseConfig } from "@swi/config";
import { TELEGRAM_CONNECTIVITY_MESSAGE, TelegramNotifier } from "./telegram-notifier.js";

const config = parseConfig(process.env);
if (!config.ENABLE_TELEGRAM || !config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) throw new Error("TELEGRAM_NOT_ENABLED");

const notifier = new TelegramNotifier({ botToken: config.TELEGRAM_BOT_TOKEN, chatId: config.TELEGRAM_CHAT_ID });
await notifier.deliver({ deduplicationKey: `phase3-connectivity:${new Date().toISOString()}`, severity: "INFO", text: TELEGRAM_CONNECTIVITY_MESSAGE });
process.stdout.write("Telegram connectivity test delivered.\n");

import { ProviderRequestError } from "./errors";

export interface JsonRequestOptions {
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly label: string;
  readonly operation?: string;
  readonly requestMetadata?: Readonly<Record<string, unknown>>;
  readonly sensitiveValues?: readonly string[];
}

const safeUrl = (url: URL): string => {
  const copy = new URL(url);
  copy.search = "";
  return copy.toString();
};

const safeResponseBody = (
  text: string,
  sensitiveValues: readonly string[] = [],
): string => {
  let value = text.slice(0, 1_000);
  for (const sensitive of sensitiveValues)
    if (sensitive.length > 0) value = value.replaceAll(sensitive, "[REDACTED]");
  return value;
};

/**
 * Bounded JSON request against a fixed provider origin. Retries only transient failures (429, 5xx, timeouts),
 * honors retry-after, and never puts the URL (which carries the API key) into an error message.
 */
export async function requestJson(
  url: URL,
  init: RequestInit,
  options: JsonRequestOptions,
): Promise<unknown> {
  let lastCode: ProviderRequestError["code"] = "UNAVAILABLE";
  for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
    if (attempt > 0) await options.sleep(2 ** attempt * 250);
    try {
      const response = await options.fetch(url, {
        ...init,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      const responseText =
        response.ok || response.status === 429 || response.status >= 500
          ? undefined
          : await response.text();
      const diagnostics = {
        status: response.status,
        requestUrl: safeUrl(url),
        ...(options.operation ? { operation: options.operation } : {}),
        ...(options.requestMetadata
          ? { requestMetadata: options.requestMetadata }
          : {}),
        ...(responseText
          ? {
              responseBody: safeResponseBody(
                responseText,
                options.sensitiveValues,
              ),
            }
          : {}),
      };
      if (response.status === 401 || response.status === 403)
        throw new ProviderRequestError(
          `${options.label} authentication failed`,
          "UNAUTHORIZED",
          false,
          undefined,
          diagnostics,
        );
      if (response.status === 429 || response.status >= 500) {
        lastCode = response.status === 429 ? "RATE_LIMITED" : "UNAVAILABLE";
        const retryAfter = Number(response.headers.get("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter > 0)
          await options.sleep(Math.min(retryAfter, 30) * 1_000);
        continue;
      }
      if (!response.ok)
        throw new ProviderRequestError(
          `${options.label} request failed with ${String(response.status)}${responseText ? `: ${safeResponseBody(responseText, options.sensitiveValues)}` : ""}`,
          "INVALID_RESPONSE",
          false,
          undefined,
          diagnostics,
        );
      const text = await response.text();
      return text.length === 0 ? null : (JSON.parse(text) as unknown);
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      if (error instanceof SyntaxError)
        throw new ProviderRequestError(
          `${options.label} returned invalid JSON`,
          "INVALID_RESPONSE",
          false,
        );
      lastCode = "TIMEOUT";
    }
  }
  throw new ProviderRequestError(
    `${options.label} is temporarily unavailable`,
    lastCode,
    true,
  );
}

export const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly code: "RATE_LIMITED" | "TIMEOUT" | "UNAVAILABLE" | "INVALID_RESPONSE" | "UNAUTHORIZED",
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

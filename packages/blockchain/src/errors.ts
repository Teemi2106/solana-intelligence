export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly code:
      | "RATE_LIMITED"
      | "TIMEOUT"
      | "UNAVAILABLE"
      | "INVALID_RESPONSE"
      | "UNAUTHORIZED",
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    readonly diagnostics?: {
      status?: number;
      operation?: string;
      requestUrl?: string;
      requestMetadata?: Readonly<Record<string, unknown>>;
      responseBody?: string;
    },
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

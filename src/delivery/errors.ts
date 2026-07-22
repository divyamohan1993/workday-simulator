/**
 * Delivery error taxonomy and retry classification.
 *
 * WHY two error classes: the base adapter owns the entire retry policy, and it
 * must distinguish a transport-level failure (connection reset, timeout, DNS,
 * a closed NATS link) from an HTTP response the target actually returned. The
 * former is always transient and retryable; the latter is retryable only when
 * its status is in the target's `retryableStatuses`. Keeping the distinction in
 * the thrown type lets the base adapter decide without re-sniffing strings.
 */

/** A non-2xx HTTP response returned by the target. Carries the status so the
 * base adapter can consult the retry policy, plus a parsed Retry-After. */
export class DeliveryHttpError extends Error {
  public readonly status: number;
  /** Parsed Retry-After in ms (from a 429/503), when the target provided one. */
  public readonly retryAfterMs?: number;
  /** A short, non-sensitive snippet of the response body for diagnostics. */
  public readonly bodySnippet?: string;

  constructor(
    status: number,
    options: { retryAfterMs?: number; bodySnippet?: string } = {},
  ) {
    super(`HTTP ${status}`);
    this.name = 'DeliveryHttpError';
    this.status = status;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.bodySnippet !== undefined) this.bodySnippet = options.bodySnippet;
  }
}

/** A transport/connection failure (timeout, reset, closed link). Always
 * treated as transient and therefore retryable. */
export class DeliveryNetworkError extends Error {
  public override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'DeliveryNetworkError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** The retry-relevant shape distilled from any thrown delivery error. */
export interface ClassifiedError {
  /** Whether the base adapter may retry, given the retry policy. */
  retryable: boolean;
  /** HTTP status, when the failure was an HTTP response. */
  status?: number;
  /** Server-directed wait before the next attempt, when provided. */
  retryAfterMs?: number;
  /** Human-readable, secret-free summary for the DeliveryResult and logs. */
  message: string;
}

/**
 * Classify a thrown error into a retry decision.
 *
 * - {@link DeliveryHttpError}: retryable iff its status is in `retryableStatuses`.
 * - {@link DeliveryNetworkError}: always retryable (transient transport fault).
 * - Anything else: an unexpected bug in mapping/serialization. Not retried,
 *   because looping on a programming error only amplifies it; it is surfaced as
 *   a failed delivery and logged.
 *
 * @param error The caught error.
 * @param retryableStatuses HTTP statuses the target marks retryable.
 * @returns The distilled retry decision.
 */
export function classifyError(error: unknown, retryableStatuses: readonly number[]): ClassifiedError {
  if (error instanceof DeliveryHttpError) {
    const result: ClassifiedError = {
      retryable: retryableStatuses.includes(error.status),
      status: error.status,
      message: error.bodySnippet ? `HTTP ${error.status}: ${error.bodySnippet}` : `HTTP ${error.status}`,
    };
    if (error.retryAfterMs !== undefined) result.retryAfterMs = error.retryAfterMs;
    return result;
  }
  if (error instanceof DeliveryNetworkError) {
    return { retryable: true, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { retryable: false, message };
}

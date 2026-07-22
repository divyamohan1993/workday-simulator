/**
 * Internal delivery types shared across the transport, auth, senders and the
 * base adapter. These are implementation details of `src/delivery`; the module's
 * only public contract remains `DeliveryAdapter` / `DeliveryAdapterFactory` from
 * `src/contracts`. Cross-cutting domain types come from `src/types`.
 */

import type { DeliveryKind, WorkdayEvent } from '../types/index.js';

/** HTTP verbs the SCIM/webhook/rest/batch senders emit. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * A fully-serialized HTTP request. `body` is the exact bytes that will be sent:
 * HMAC signing and Content-Length both operate on this string, so nothing may
 * mutate it after auth has been applied.
 */
export interface HttpRequestSpec {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** A normalized HTTP response: status, lowercased headers, decoded text body. */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * The seam between the delivery engine and the network. The default
 * implementation is undici-backed; tests inject a fake to drive retries, circuit
 * transitions and 429 handling without a real server. Implementations MUST fully
 * consume the response body (returning it as text) so sockets are never leaked.
 */
export interface HttpTransport {
  send(request: HttpRequestSpec, options: { timeoutMs: number }): Promise<HttpResponse>;
  /** Release pooled connections. */
  close(): Promise<void>;
}

/** Applies a target's auth to an outbound request (headers and/or body signing). */
export interface Authenticator {
  /**
   * Mutate `spec.headers` (and, for HMAC, derive a signature over `spec.body`)
   * to authenticate the request. Async because OAuth2 client-credentials may
   * need to fetch and cache a token first.
   */
  apply(spec: HttpRequestSpec): Promise<void>;
  /** Drop any cached credential so the next {@link apply} re-fetches (e.g. after a 401). */
  invalidate(): void;
  /** Release timers/state. Never closes a shared transport or NATS link. */
  stop(): void;
}

/** The outcome of a successful single- or batch-send, before result accounting. */
export interface SendResult {
  /** HTTP status for wire sends; undefined for NATS and local no-ops. */
  httpStatus?: number;
  /** Identifier the receiver assigned (SCIM id / Location), for DLQ context. */
  receiverRef?: string;
  /** True when nothing crossed the wire (e.g. a SCIM no-op for an auth event). */
  noop?: boolean;
}

/** A sender that emits one wire request per event (SCIM single, webhook, REST, NATS). */
export interface SingleSender {
  readonly mode: 'single';
  /** Warm connections and authentication. Idempotent. */
  start(): Promise<void>;
  /** Deliver one event. Resolves on 2xx; throws a delivery error otherwise. */
  sendOne(event: WorkdayEvent): Promise<SendResult>;
  /** Release owned resources (transport, auth). Never the shared NATS link. */
  stop(): Promise<void>;
}

/** A sender that coalesces several events into one wire request (HR CSV feed, SCIM Bulk). */
export interface BatchSender {
  readonly mode: 'batch';
  /** Target events per batch payload. */
  readonly batchSize: number;
  start(): Promise<void>;
  /** Deliver a batch as a single wire call. Resolves on 2xx; throws otherwise. */
  sendBatch(events: WorkdayEvent[]): Promise<SendResult>;
  stop(): Promise<void>;
}

/** Either sender shape; the base adapter selects its drain strategy from `mode`. */
export type DeliverySender = SingleSender | BatchSender;

/** Kind carried alongside a sender so the adapter can stamp DeliveryResults. */
export interface SenderMeta {
  kind: DeliveryKind;
}

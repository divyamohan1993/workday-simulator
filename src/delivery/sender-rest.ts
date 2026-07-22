/**
 * Generic REST sink: POSTs events as JSON to a single configurable endpoint,
 * authenticated with the target's scheme (none/bearer/basic/oauth2/hmac).
 *
 * The body is always `{ source, count, events: [...] }`. In single mode that is
 * a batch of one; when the target sets `batchSize > 1` the sender coalesces up
 * to that many events per POST. This uniform envelope means the receiver's REST
 * ingest endpoint parses one shape regardless of batching.
 */

import type { WorkdayEvent } from '../types/index.js';
import { CONTENT_TYPE, DEFAULT_REQUEST_TIMEOUT_MS, ENVELOPE_SOURCE, IDEMPOTENCY_HEADER } from './constants.js';
import type {
  Authenticator,
  BatchSender,
  HttpRequestSpec,
  HttpTransport,
  SendResult,
  SingleSender,
} from './types.js';
import { authenticateAndSend, extractReceiverRef } from './wire.js';

/** Options for {@link createRestSender}. */
export interface RestSenderOptions {
  target: { url: string; headers: Record<string, string>; batchSize?: number };
  transport: HttpTransport;
  auth: Authenticator;
  now?: () => number;
  timeoutMs?: number;
}

/** The REST body shape posted to the sink. */
function restBody(events: readonly WorkdayEvent[]): string {
  return JSON.stringify({ source: ENVELOPE_SOURCE, count: events.length, events });
}

/** Create a REST sender: single mode, or batch mode when `batchSize > 1`. */
export function createRestSender(options: RestSenderOptions): SingleSender | BatchSender {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  const start = async (): Promise<void> => {
    /* auth warmed lazily */
  };
  const stop = async (): Promise<void> => {
    options.auth.stop();
    await options.transport.close();
  };

  const post = async (events: readonly WorkdayEvent[], idempotencyKey: string): Promise<SendResult> => {
    const spec: HttpRequestSpec = {
      method: 'POST',
      url: options.target.url,
      headers: {
        ...options.target.headers,
        'content-type': CONTENT_TYPE.json,
        [IDEMPOTENCY_HEADER]: idempotencyKey,
      },
      body: restBody(events),
    };
    const response = await authenticateAndSend(
      { transport: options.transport, auth: options.auth, timeoutMs, now },
      spec,
    );
    const receiverRef = extractReceiverRef(response);
    return { httpStatus: response.status, ...(receiverRef ? { receiverRef } : {}) };
  };

  if (options.target.batchSize && options.target.batchSize > 1) {
    return {
      mode: 'batch',
      batchSize: options.target.batchSize,
      start,
      stop,
      async sendBatch(events: WorkdayEvent[]): Promise<SendResult> {
        const first = events[0];
        // Stable across retries: keyed on the first event's idempotency key.
        const key = first ? `batch-${first.delivery.idempotencyKey}-${events.length}` : 'batch-empty';
        return post(events, key);
      },
    };
  }

  return {
    mode: 'single',
    start,
    stop,
    async sendOne(event: WorkdayEvent): Promise<SendResult> {
      return post([event], event.delivery.idempotencyKey);
    },
  };
}

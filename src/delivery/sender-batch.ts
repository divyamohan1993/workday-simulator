/**
 * Batch HR-feed sender: accumulates events and flushes them as an RFC 4180 CSV
 * document to a single endpoint, the way a nightly (or micro-batched) HR feed
 * delivers joiner/mover/leaver rows to an identity manager.
 *
 * The base adapter owns accumulation, size and age triggers; this sender only
 * turns a batch of events into the CSV wire call. The idempotency key is a
 * deterministic hash of the batch's event ids, so a retried flush of the same
 * batch is recognizably identical and never double-applied.
 */

import { createHash } from 'node:crypto';
import type { WorkdayEvent } from '../types/index.js';
import { CONTENT_TYPE, DEFAULT_BATCH_SIZE, DEFAULT_REQUEST_TIMEOUT_MS, IDEMPOTENCY_HEADER } from './constants.js';
import { hrFeedBatch } from './csv.js';
import type { Authenticator, BatchSender, HttpRequestSpec, HttpTransport, SendResult } from './types.js';
import { authenticateAndSend, extractReceiverRef } from './wire.js';

/** Options for {@link createBatchSender}. */
export interface BatchSenderOptions {
  target: { url: string; headers: Record<string, string>; batchSize?: number };
  transport: HttpTransport;
  auth: Authenticator;
  now?: () => number;
  timeoutMs?: number;
}

/** A deterministic idempotency key for a batch, stable across retries. */
function batchKey(events: readonly WorkdayEvent[]): string {
  const hash = createHash('sha1');
  for (const event of events) hash.update(event.id).update('\n');
  return `hrfeed-${hash.digest('hex')}`;
}

/** Create a batch HR-feed (CSV) sender. */
export function createBatchSender(options: BatchSenderOptions): BatchSender {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const batchSize = options.target.batchSize && options.target.batchSize > 0
    ? options.target.batchSize
    : DEFAULT_BATCH_SIZE;

  return {
    mode: 'batch',
    batchSize,
    async start(): Promise<void> {
      /* auth warmed lazily */
    },
    async stop(): Promise<void> {
      options.auth.stop();
      await options.transport.close();
    },
    async sendBatch(events: WorkdayEvent[]): Promise<SendResult> {
      if (events.length === 0) return { noop: true };
      const spec: HttpRequestSpec = {
        method: 'POST',
        url: options.target.url,
        headers: {
          ...options.target.headers,
          'content-type': CONTENT_TYPE.csv,
          [IDEMPOTENCY_HEADER]: batchKey(events),
        },
        body: hrFeedBatch(events),
      };
      const response = await authenticateAndSend(
        { transport: options.transport, auth: options.auth, timeoutMs, now },
        spec,
      );
      const receiverRef = extractReceiverRef(response);
      return { httpStatus: response.status, ...(receiverRef ? { receiverRef } : {}) };
    },
  };
}

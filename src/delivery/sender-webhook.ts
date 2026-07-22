/**
 * Webhook sender: POSTs a signed event envelope to a single endpoint.
 *
 * The body is the {@link DeliveryEnvelope} for one event. When the target's auth
 * is HMAC, the authenticator signs the EXACT serialized bytes and writes the
 * signature to the configured header; the receiver verifies over the raw body.
 * Bearer/basic/OAuth targets are supported too (the envelope is unsigned then).
 */

import type { WorkdayEvent } from '../types/index.js';
import { CONTENT_TYPE, DEFAULT_REQUEST_TIMEOUT_MS, IDEMPOTENCY_HEADER } from './constants.js';
import { buildEnvelope, serializeEnvelope } from './envelope.js';
import type { Authenticator, HttpRequestSpec, HttpTransport, SendResult, SingleSender } from './types.js';
import { authenticateAndSend, extractReceiverRef } from './wire.js';

/** Options for {@link createWebhookSender}. */
export interface WebhookSenderOptions {
  target: { url: string; headers: Record<string, string> };
  transport: HttpTransport;
  auth: Authenticator;
  now?: () => number;
  timeoutMs?: number;
}

/** Create a single-mode webhook sender. */
export function createWebhookSender(options: WebhookSenderOptions): SingleSender {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  return {
    mode: 'single',
    async start(): Promise<void> {
      /* auth warmed lazily on first send */
    },
    async stop(): Promise<void> {
      options.auth.stop();
      await options.transport.close();
    },
    async sendOne(event: WorkdayEvent): Promise<SendResult> {
      const body = serializeEnvelope(buildEnvelope(event));
      const spec: HttpRequestSpec = {
        method: 'POST',
        url: options.target.url,
        headers: {
          ...options.target.headers,
          'content-type': CONTENT_TYPE.json,
          [IDEMPOTENCY_HEADER]: event.delivery.idempotencyKey,
        },
        body,
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

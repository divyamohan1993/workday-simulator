/**
 * The outbound event envelope for the webhook and REST wire formats.
 *
 * WHY an envelope rather than the bare event: a webhook/REST consumer needs
 * routing and integrity metadata at the top level, without parsing the full
 * payload, and a stable place to carry the idempotency key and the provisioning
 * intent. The shape is CloudEvents-inspired (`specversion`, `id`, `source`,
 * `type`, `time`, `data`) so it reads naturally to any events consumer, with a
 * few delivery-specific fields the identity manager needs.
 *
 * SIGNING CONTRACT: for HMAC targets the signature is computed over the EXACT
 * serialized bytes produced by {@link serializeEnvelope} (compact JSON, no
 * incidental whitespace). The receiver MUST verify over the raw received body,
 * never a re-serialization, or the signatures will not match.
 */

import type {
  EventCategory,
  EventKind,
  ProvisioningOperation,
  ProvisioningResource,
  WorkdayEvent,
} from '../types/index.js';
import { ENVELOPE_SOURCE } from './constants.js';

/** The envelope wrapping a single event for webhook/REST delivery. */
export interface DeliveryEnvelope {
  specversion: '1.0';
  /** Envelope id; the event id, so retries carry a stable identifier. */
  id: string;
  source: typeof ENVELOPE_SOURCE;
  /** The event kind, e.g. "joiner.hire". */
  type: EventKind;
  category: EventCategory;
  /** Wall-clock emission time (RFC 3339), used for delivery-latency math. */
  time: string;
  /** Simulated workday time (RFC 3339). */
  simtime: string;
  correlationId: string;
  causationId?: string;
  /** At-least-once dedup key; mirrors the {@link IDEMPOTENCY_HEADER}. */
  idempotencyKey: string;
  operation: ProvisioningOperation;
  resource: ProvisioningResource;
  /** The affected identity id (subject when present, else the acting identity). */
  subjectId?: string;
  /** The full event, carried opaquely. */
  data: WorkdayEvent;
}

/** The affected identity id: subject when set, else the acting identity's id. */
function subjectIdOf(event: WorkdayEvent): string | undefined {
  if (event.subject) return event.subject.id;
  return event.actor.kind === 'system' ? undefined : event.actor.id;
}

/**
 * Build the delivery envelope for an event.
 *
 * @param event The event to wrap.
 * @returns The populated envelope.
 */
export function buildEnvelope(event: WorkdayEvent): DeliveryEnvelope {
  const envelope: DeliveryEnvelope = {
    specversion: '1.0',
    id: event.id,
    source: ENVELOPE_SOURCE,
    type: event.kind,
    category: event.category,
    time: event.emittedAtWall,
    simtime: event.timestamp,
    correlationId: event.correlationId,
    idempotencyKey: event.delivery.idempotencyKey,
    operation: event.delivery.operation,
    resource: event.delivery.resource,
    data: event,
  };
  if (event.causationId !== undefined) envelope.causationId = event.causationId;
  const subjectId = subjectIdOf(event);
  if (subjectId !== undefined) envelope.subjectId = subjectId;
  return envelope;
}

/**
 * Serialize an envelope to the exact bytes that will be transmitted and signed.
 * Compact `JSON.stringify` (no spacing) is the canonical encoding.
 *
 * @param envelope The envelope to serialize.
 * @returns Compact JSON.
 */
export function serializeEnvelope(envelope: DeliveryEnvelope): string {
  return JSON.stringify(envelope);
}

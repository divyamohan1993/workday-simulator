import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import type { WorkdayEvent } from '../types/index.js';
import { EVENT_CATEGORY } from '../types/index.js';
import { createEventBus } from './event-bus.js';

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

function fakeEvent(id = 'e1'): WorkdayEvent {
  return {
    id,
    category: EVENT_CATEGORY['login.success'],
    kind: 'login.success',
    timestamp: new Date().toISOString(),
    emittedAtWall: new Date().toISOString(),
    correlationId: 'corr',
    severity: 'info',
    actor: { kind: 'system', id: 'sys', component: 'test' },
    location: 'FFT',
    division: 'Operations',
    delivery: { operation: 'noop', resource: 'event', idempotencyKey: id, priority: 'normal', requiresApproval: false },
    seq: 1,
    payload: {},
  } as unknown as WorkdayEvent;
}

describe('createEventBus', () => {
  it('fans out synchronously to all subscribers in subscription order', () => {
    const bus = createEventBus({ logger: silentLogger });
    const order: number[] = [];
    bus.subscribe(() => order.push(1));
    bus.subscribe(() => order.push(2));
    bus.subscribe(() => order.push(3));
    bus.publish(fakeEvent());
    expect(order).toEqual([1, 2, 3]);
    expect(bus.subscriberCount()).toBe(3);
  });

  it('isolates a throwing subscriber and still notifies the rest', () => {
    const bus = createEventBus({ logger: silentLogger });
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe(() => seen.push('second'));
    expect(() => bus.publish(fakeEvent())).not.toThrow();
    expect(seen).toEqual(['second']);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = createEventBus({ logger: silentLogger });
    let count = 0;
    const unsubscribe = bus.subscribe(() => {
      count += 1;
    });
    bus.publish(fakeEvent());
    unsubscribe();
    bus.publish(fakeEvent());
    expect(count).toBe(1);
    expect(bus.subscriberCount()).toBe(0);
  });

  it('is safe to unsubscribe twice', () => {
    const bus = createEventBus({ logger: silentLogger });
    const unsubscribe = bus.subscribe(() => undefined);
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
    expect(bus.subscriberCount()).toBe(0);
  });
});

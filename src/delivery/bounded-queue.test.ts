import { describe, expect, it } from 'vitest';
import { BoundedQueue } from './bounded-queue.js';

describe('BoundedQueue', () => {
  it('accepts up to the high-water mark and preserves FIFO order', () => {
    const q = new BoundedQueue<string>(3, 'drop_new');
    expect(q.enqueue('a', 1).type).toBe('accepted');
    expect(q.enqueue('b', 2).type).toBe('accepted');
    expect(q.enqueue('c', 3).type).toBe('accepted');
    expect(q.size()).toBe(3);
    expect(q.dequeue()?.value).toBe('a');
    expect(q.dequeue()?.value).toBe('b');
    expect(q.dequeue()?.value).toBe('c');
    expect(q.dequeue()).toBeUndefined();
  });

  it('drop_new rejects the incoming event at capacity', () => {
    const q = new BoundedQueue<string>(2, 'drop_new');
    q.enqueue('a', 1);
    q.enqueue('b', 2);
    const result = q.enqueue('c', 3);
    expect(result.type).toBe('rejected');
    expect(q.size()).toBe(2);
    // The oldest survive; the newcomer was the casualty.
    expect(q.dequeue()?.value).toBe('a');
    expect(q.dequeue()?.value).toBe('b');
  });

  it('drop_oldest evicts the oldest and admits the newest', () => {
    const q = new BoundedQueue<string>(2, 'drop_oldest');
    q.enqueue('a', 1);
    q.enqueue('b', 2);
    const result = q.enqueue('c', 3);
    expect(result.type).toBe('accepted_evicted');
    if (result.type === 'accepted_evicted') {
      expect(result.evicted.value).toBe('a');
      expect(result.evicted.submitWallMs).toBe(1);
    }
    expect(q.size()).toBe(2);
    expect(q.dequeue()?.value).toBe('b');
    expect(q.dequeue()?.value).toBe('c');
  });

  it('block accepts beyond the high-water mark', () => {
    const q = new BoundedQueue<number>(2, 'block');
    for (let i = 0; i < 5; i += 1) expect(q.enqueue(i, i).type).toBe('accepted');
    expect(q.size()).toBe(5);
    for (let i = 0; i < 5; i += 1) expect(q.dequeue()?.value).toBe(i);
  });

  it('preserves order across internal compaction under heavy churn', () => {
    const q = new BoundedQueue<number>(1_000_000, 'block');
    let expected = 0;
    let next = 0;
    // Enqueue and dequeue in waves that cross the compaction threshold.
    for (let wave = 0; wave < 4; wave += 1) {
      for (let i = 0; i < 3_000; i += 1) q.enqueue(next++, next);
      for (let i = 0; i < 2_000; i += 1) {
        expect(q.dequeue()?.value).toBe(expected++);
      }
    }
    // Drain the remainder, still in order.
    let item = q.dequeue();
    while (item) {
      expect(item.value).toBe(expected++);
      item = q.dequeue();
    }
    expect(expected).toBe(next);
  });
});

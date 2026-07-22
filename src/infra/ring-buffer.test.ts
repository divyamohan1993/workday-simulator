import { describe, expect, it } from 'vitest';
import { RingBuffer } from './ring-buffer.js';

describe('RingBuffer', () => {
  it('reads newest-first while below capacity', () => {
    const ring = new RingBuffer<string>(3);
    ring.push('a');
    ring.push('b');
    expect(ring.length).toBe(2);
    expect(ring.toArray()).toEqual(['b', 'a']);
  });

  it('evicts the oldest element once full (rollover)', () => {
    const ring = new RingBuffer<string>(3);
    ring.push('a');
    ring.push('b');
    ring.push('c');
    expect(ring.toArray()).toEqual(['c', 'b', 'a']);

    ring.push('d'); // 'a' is evicted
    expect(ring.length).toBe(3);
    expect(ring.toArray()).toEqual(['d', 'c', 'b']);

    ring.push('e'); // 'b' is evicted
    expect(ring.toArray()).toEqual(['e', 'd', 'c']);
  });

  it('reports its configured capacity and stays bounded under heavy load', () => {
    const ring = new RingBuffer<number>(5);
    for (let i = 0; i < 1_000; i += 1) ring.push(i);
    expect(ring.capacity).toBe(5);
    expect(ring.length).toBe(5);
    expect(ring.toArray()).toEqual([999, 998, 997, 996, 995]);
  });

  it('behaves as a no-op sink at capacity 0', () => {
    const ring = new RingBuffer<number>(0);
    ring.push(1);
    ring.push(2);
    expect(ring.length).toBe(0);
    expect(ring.toArray()).toEqual([]);
  });

  it('clears all elements', () => {
    const ring = new RingBuffer<number>(3);
    ring.push(1);
    ring.push(2);
    ring.clear();
    expect(ring.length).toBe(0);
    expect(ring.toArray()).toEqual([]);
  });
});

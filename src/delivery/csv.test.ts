import { describe, expect, it } from 'vitest';
import type { EventOfKind, IdentityRef } from '../types/index.js';
import { csvEscapeField, csvRecord, HR_FEED_COLUMNS, hrFeedBatch, hrFeedHeader, hrFeedRow } from './csv.js';

function ref(overrides: Partial<IdentityRef> = {}): IdentityRef {
  return {
    id: 'emp_1',
    employeeId: 'DB00100000',
    displayName: 'Grace Hopper',
    email: 'grace.hopper@db.com',
    division: 'Technology, Data & Innovation',
    location: 'FFT',
    grade: 'VP',
    type: 'FTE',
    ...overrides,
  };
}

function loginEvent(subject: IdentityRef): EventOfKind<'login.success'> {
  return {
    id: 'evt_1',
    kind: 'login.success',
    category: 'AUTH',
    timestamp: '2026-07-22T08:00:00.000Z',
    emittedAtWall: '2026-07-22T08:00:00.100Z',
    correlationId: 'corr_1',
    severity: 'info',
    actor: { kind: 'employee', ...subject },
    location: subject.location,
    division: subject.division,
    delivery: { operation: 'noop', resource: 'session', idempotencyKey: 'idem_1', priority: 'low', requiresApproval: false },
    seq: 1,
    payload: {
      ip: '10.0.0.1',
      userAgent: 'Mozilla/5.0',
      method: 'password',
      geo: { city: 'Frankfurt', country: 'DE', lat: 50.11, lng: 8.68 },
      deviceId: 'dev_1',
      sessionId: 'sess_1',
      riskScore: 5,
    },
  };
}

describe('csvEscapeField (RFC 4180)', () => {
  it('leaves plain and unicode-only fields untouched', () => {
    expect(csvEscapeField('Grace Hopper')).toBe('Grace Hopper');
    expect(csvEscapeField('Zoë Müller-Groß')).toBe('Zoë Müller-Groß');
  });

  it('quotes fields containing a comma', () => {
    expect(csvEscapeField('Technology, Data & Innovation')).toBe('"Technology, Data & Innovation"');
  });

  it('quotes and doubles embedded double-quotes', () => {
    expect(csvEscapeField('O\'Brien, "Danger"')).toBe('"O\'Brien, ""Danger"""');
  });

  it('quotes fields containing CR or LF', () => {
    expect(csvEscapeField('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscapeField('a\r\nb')).toBe('"a\r\nb"');
  });
});

describe('csvRecord', () => {
  it('joins cells and renders nullish cells as empty', () => {
    expect(csvRecord(['a', 1, true, null, undefined])).toBe('a,1,true,,');
  });
});

describe('hr feed', () => {
  it('header lists every column in order', () => {
    expect(hrFeedHeader()).toBe(HR_FEED_COLUMNS.join(','));
  });

  it('escapes a division and a hostile display name without shifting columns', () => {
    const event = loginEvent(ref({ displayName: 'Van Der Berg, "The Great"' }));
    const row = hrFeedRow(event);
    expect(row).toContain('"Technology, Data & Innovation"');
    expect(row).toContain('"Van Der Berg, ""The Great"""');
    // The header and row must have identical column counts even after quoting.
    expect(countCsvCells(row)).toBe(HR_FEED_COLUMNS.length);
  });

  it('emits a CRLF-separated document with a trailing CRLF', () => {
    const events = [loginEvent(ref()), loginEvent(ref({ id: 'emp_2', email: 'a@b.com' }))];
    const doc = hrFeedBatch(events);
    const lines = doc.split('\r\n');
    // header + 2 rows + trailing empty from the final CRLF.
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(hrFeedHeader());
    expect(lines[3]).toBe('');
  });
});

/** Count logical CSV cells in one record, honouring RFC 4180 quoting. */
function countCsvCells(line: string): number {
  let cells = 1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i += 1; // escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      cells += 1;
    }
  }
  return cells;
}

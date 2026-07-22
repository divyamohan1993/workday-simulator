import { base, en, Faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';
import {
  buildSepaPayload,
  buildSwiftPayload,
  generateIban,
  generateUetr,
  isValidIban,
  type BankRng,
} from './banking.js';
import { paymentSepaSchema, paymentSwiftSchema } from './schema.js';

function seededRng(seed = 42): BankRng {
  const faker = new Faker({ locale: [en, base] });
  faker.seed(seed);
  return faker;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('IBAN generation', () => {
  it('always produces a mod-97 valid IBAN', () => {
    const rng = seededRng();
    for (let i = 0; i < 500; i += 1) {
      const iban = generateIban(rng);
      expect(isValidIban(iban)).toBe(true);
    }
  });

  it('honours a forced German IBAN shape', () => {
    const rng = seededRng();
    const iban = generateIban(rng, 'DE');
    expect(iban.startsWith('DE')).toBe(true);
    expect(iban).toHaveLength(22);
    expect(isValidIban(iban)).toBe(true);
  });

  it('rejects a corrupted IBAN', () => {
    const rng = seededRng();
    const iban = generateIban(rng, 'DE');
    const corrupted = `${iban.slice(0, -1)}${iban.endsWith('0') ? '1' : '0'}`;
    expect(isValidIban(corrupted)).toBe(false);
    expect(isValidIban('not-an-iban')).toBe(false);
  });
});

describe('SWIFT references', () => {
  it('generates a UUID-shaped UETR', () => {
    const rng = seededRng();
    expect(generateUetr(rng)).toMatch(UUID_RE);
  });
});

describe('SEPA payloads', () => {
  it('are schema-valid with distinct EUR IBANs', () => {
    const rng = seededRng();
    for (let i = 0; i < 200; i += 1) {
      const payload = buildSepaPayload(rng, `sepa_${i}`);
      expect(() => paymentSepaSchema.parse(payload)).not.toThrow();
      expect(payload.currency).toBe('EUR');
      expect(payload.debtorIban).not.toBe(payload.creditorIban);
      expect(isValidIban(payload.debtorIban)).toBe(true);
      expect(isValidIban(payload.creditorIban)).toBe(true);
      expect(payload.amount).toBeGreaterThan(0);
    }
  });
});

describe('SWIFT payloads', () => {
  it('are schema-valid with a UUID UETR and distinct BICs', () => {
    const rng = seededRng();
    for (let i = 0; i < 200; i += 1) {
      const payload = buildSwiftPayload(rng, `swift_${i}`);
      expect(() => paymentSwiftSchema.parse(payload)).not.toThrow();
      expect(payload.uetr).toMatch(UUID_RE);
      expect(payload.senderBic).not.toBe(payload.receiverBic);
      expect(payload.amount).toBeGreaterThan(0);
    }
  });
});

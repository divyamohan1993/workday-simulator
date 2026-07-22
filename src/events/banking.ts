/**
 * Banking payload primitives: IBANs, BICs, SWIFT references, card data and realistic
 * money amounts for the TXN event family.
 *
 * WHY this module exists: the transaction events are the load an identity manager
 * rarely sees but a bank platform team must exercise, and they are only convincing if
 * the identifiers are structurally real. A generated IBAN carries a correct mod-97
 * check so a downstream validator accepts it; a BIC follows the ISO 9362 shape; a
 * SWIFT UETR is a real UUID. Amounts are drawn from per-instrument magnitude bands so
 * a SEPA direct debit never looks like an interbank MT202. Everything is pure given
 * the injected RNG, so a fixed seed reproduces the same transactions.
 *
 * SECURITY: card events expose only the last four PAN digits; no full PAN is ever
 * generated or stored, matching the payload contract (`panLast4`).
 */

import type { PaymentSepaPayload, PaymentSwiftPayload } from '../types/index.js';

/**
 * Minimal RNG surface these helpers need, satisfied structurally by a seeded Faker
 * instance. Declaring the surface keeps banking logic decoupled from the RNG library
 * and trivially unit-testable with a stub.
 */
export interface BankRng {
  number: { int(options: { min: number; max: number }): number; float(options: { min: number; max: number }): number };
  string: { numeric(length: number): string; uuid(): string };
  helpers: {
    arrayElement<T>(array: readonly T[]): T;
    weightedArrayElement<T>(array: ReadonlyArray<{ weight: number; value: T }>): T;
  };
}

/** SEPA-zone country codes and the digit length of their BBAN (national part). */
const SEPA_BBAN_LENGTH: Record<string, number> = {
  DE: 18, // 8 BLZ + 10 account
  FR: 23,
  NL: 18,
  ES: 20,
  IT: 23,
  IE: 18,
  BE: 12,
  AT: 16,
  LU: 18,
};

const SEPA_COUNTRIES: readonly string[] = Object.keys(SEPA_BBAN_LENGTH);

/** Deutsche Bank and common counterparty BICs for realistic wire routing. */
const KNOWN_BICS: readonly string[] = [
  'DEUTDEFF', // Deutsche Bank, Frankfurt
  'DEUTGB2L', // Deutsche Bank, London
  'DEUTUS33', // Deutsche Bank Trust, New York
  'DEUTSGSG', // Deutsche Bank, Singapore
  'DEUTHKHH', // Deutsche Bank, Hong Kong
  'CHASUS33', // JPMorgan Chase, New York
  'HSBCGB2L', // HSBC, London
  'BNPAFRPP', // BNP Paribas, Paris
  'CITIUS33', // Citibank, New York
  'BARCGB22', // Barclays, London
  'UBSWCHZH80', // UBS, Zurich
  'DBSSSGSG', // DBS, Singapore
];

/**
 * Compute the two ISO 13616 check digits for an IBAN given its country code and BBAN.
 * Implements the mod-97-10 algorithm without BigInt by folding the rearranged numeric
 * string in nine-digit chunks, which is exact for the value ranges involved.
 *
 * @param country Two-letter country code.
 * @param bban National basic bank account number (digits only here).
 * @returns The zero-padded two-digit check number.
 */
function ibanCheckDigits(country: string, bban: string): string {
  // Standard rearrangement: BBAN + countryCode + "00", letters mapped A=10..Z=35.
  const rearranged = `${bban}${country}00`;
  let numeric = '';
  for (const ch of rearranged) {
    numeric += /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
  }
  // Iterative mod 97 over the (possibly very long) numeric string.
  let remainder = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    const chunk = String(remainder) + numeric.slice(i, i + 7);
    remainder = Number(chunk) % 97;
  }
  const check = 98 - remainder;
  return check.toString().padStart(2, '0');
}

/**
 * Generate a structurally valid IBAN with a correct mod-97 check digit.
 *
 * @param rng Seeded RNG.
 * @param country Optional forced country; a random SEPA country otherwise.
 * @returns A valid IBAN string, e.g. "DE89370400440532013000".
 */
export function generateIban(rng: BankRng, country?: string): string {
  const cc = country && SEPA_BBAN_LENGTH[country] ? country : rng.helpers.arrayElement(SEPA_COUNTRIES);
  const length = SEPA_BBAN_LENGTH[cc] ?? 18;
  // Deutsche Bank's German BLZ (500 700 10 / 500 700 24 are Frankfurt) makes DE IBANs
  // look like real house accounts; other countries use a random national number.
  let bban: string;
  if (cc === 'DE') {
    const blz = rng.helpers.arrayElement(['50070010', '50070024', '10070000', '50070124']);
    bban = `${blz}${rng.string.numeric(10)}`;
  } else {
    bban = rng.string.numeric(length);
  }
  const check = ibanCheckDigits(cc, bban);
  return `${cc}${check}${bban}`;
}

/**
 * Validate an IBAN's mod-97 checksum. Exposed so tests can assert generated IBANs are
 * genuinely well-formed rather than merely the right length.
 *
 * @param iban The IBAN to check.
 * @returns True when the checksum is valid.
 */
export function isValidIban(iban: string): boolean {
  const value = iban.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(value) || value.length < 15) {
    return false;
  }
  const rearranged = value.slice(4) + value.slice(0, 4);
  let numeric = '';
  for (const ch of rearranged) {
    numeric += /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
  }
  let remainder = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    remainder = Number(String(remainder) + numeric.slice(i, i + 7)) % 97;
  }
  return remainder === 1;
}

/** Pick a realistic BIC, biased toward Deutsche Bank's own for the sender side. */
export function pickBic(rng: BankRng, preferDeutsche = false): string {
  if (preferDeutsche) {
    return rng.helpers.arrayElement(KNOWN_BICS.filter((b) => b.startsWith('DEUT')));
  }
  return rng.helpers.arrayElement(KNOWN_BICS);
}

/** Generate a SWIFT gpi UETR (unique end-to-end transaction reference): a UUID v4. */
export function generateUetr(rng: BankRng): string {
  return rng.string.uuid();
}

/** Merchant category codes with human-friendly grouping for card transactions. */
const MERCHANT_CATEGORIES: ReadonlyArray<{ weight: number; value: { mcc: string; merchant: string; channel: 'pos' | 'ecom' | 'atm' } }> = [
  { weight: 22, value: { mcc: '5411', merchant: 'REWE Supermarket', channel: 'pos' } },
  { weight: 16, value: { mcc: '5812', merchant: 'Vapiano Restaurant', channel: 'pos' } },
  { weight: 12, value: { mcc: '5541', merchant: 'Aral Fuel Station', channel: 'pos' } },
  { weight: 10, value: { mcc: '4111', merchant: 'Deutsche Bahn', channel: 'ecom' } },
  { weight: 10, value: { mcc: '5999', merchant: 'Amazon EU', channel: 'ecom' } },
  { weight: 8, value: { mcc: '6011', merchant: 'ATM Withdrawal', channel: 'atm' } },
  { weight: 7, value: { mcc: '7011', merchant: 'Marriott Hotels', channel: 'ecom' } },
  { weight: 6, value: { mcc: '4814', merchant: 'Vodafone Telecom', channel: 'ecom' } },
  { weight: 5, value: { mcc: '5732', merchant: 'MediaMarkt Electronics', channel: 'pos' } },
  { weight: 4, value: { mcc: '4829', merchant: 'Wise Transfer', channel: 'ecom' } },
];

/** A drawn merchant profile for a card transaction. */
export interface MerchantProfile {
  mcc: string;
  merchant: string;
  channel: 'pos' | 'ecom' | 'atm';
}

/** Pick a weighted merchant profile for a card transaction. */
export function pickMerchant(rng: BankRng): MerchantProfile {
  return rng.helpers.weightedArrayElement(MERCHANT_CATEGORIES);
}

/**
 * Draw a money amount inside a log-uniform band, so small amounts dominate and large
 * ones appear with realistic rarity rather than a flat distribution. Rounded to cents.
 *
 * @param rng Seeded RNG.
 * @param min Lower bound (inclusive-ish).
 * @param max Upper bound.
 * @returns A positive amount with two decimal places.
 */
export function logUniformAmount(rng: BankRng, min: number, max: number): number {
  const lo = Math.log(Math.max(1, min));
  const hi = Math.log(Math.max(min + 1, max));
  const value = Math.exp(rng.number.float({ min: lo, max: hi }));
  return Math.round(value * 100) / 100;
}

/** ISO 4217 currencies seen across Deutsche Bank's booking centres, EUR-heavy. */
export const SWIFT_CURRENCIES: ReadonlyArray<{ weight: number; value: string }> = [
  { weight: 40, value: 'EUR' },
  { weight: 22, value: 'USD' },
  { weight: 12, value: 'GBP' },
  { weight: 8, value: 'CHF' },
  { weight: 6, value: 'JPY' },
  { weight: 5, value: 'SGD' },
  { weight: 4, value: 'HKD' },
  { weight: 3, value: 'INR' },
];

/** SEPA purpose codes (ISO 20022 external purpose) with plain-language intent. */
const SEPA_PURPOSES: readonly string[] = [
  'SALA', // salary
  'SUPP', // supplier payment
  'TAXS', // tax
  'RENT', // rent
  'INTC', // intra-company
  'TREA', // treasury
  'DIVI', // dividend
  'LOAN', // loan
];

/**
 * Build a complete, internally-consistent SEPA payment payload. SCT_Inst is capped at
 * the scheme's instant-payment ceiling; direct debits skew smaller than credit
 * transfers. Debtor and creditor IBANs are always distinct.
 *
 * @param rng Seeded RNG.
 * @param txnId Pre-minted transaction id from the caller.
 * @returns A SEPA payload.
 */
export function buildSepaPayload(rng: BankRng, txnId: string): PaymentSepaPayload {
  const instrument = rng.helpers.weightedArrayElement([
    { weight: 6, value: 'SCT' as const },
    { weight: 3, value: 'SDD' as const },
    { weight: 2, value: 'SCT_Inst' as const },
  ]);
  const amount =
    instrument === 'SCT_Inst'
      ? logUniformAmount(rng, 1, 15_000)
      : instrument === 'SDD'
        ? logUniformAmount(rng, 5, 5_000)
        : logUniformAmount(rng, 50, 250_000);
  let creditorIban = generateIban(rng);
  const debtorIban = generateIban(rng, 'DE');
  while (creditorIban === debtorIban) {
    creditorIban = generateIban(rng);
  }
  return {
    txnId,
    amount,
    currency: 'EUR',
    debtorIban,
    creditorIban,
    instrument,
    bic: pickBic(rng, true),
    purpose: rng.helpers.arrayElement(SEPA_PURPOSES),
  };
}

/**
 * Build a complete SWIFT payload. MT202 (bank-to-bank cover) skews to very large
 * interbank amounts; MT103 and pacs.008 are customer transfers. A correspondent BIC
 * is attached for a fraction of cross-border customer payments.
 *
 * @param rng Seeded RNG.
 * @param txnId Pre-minted transaction id from the caller.
 * @returns A SWIFT payload.
 */
export function buildSwiftPayload(rng: BankRng, txnId: string): PaymentSwiftPayload {
  const messageType = rng.helpers.weightedArrayElement([
    { weight: 5, value: 'MT103' as const },
    { weight: 3, value: 'MT202' as const },
    { weight: 2, value: 'pacs.008' as const },
  ]);
  const amount =
    messageType === 'MT202'
      ? logUniformAmount(rng, 100_000, 500_000_000)
      : logUniformAmount(rng, 1_000, 5_000_000);
  const senderBic = pickBic(rng, true);
  let receiverBic = pickBic(rng, false);
  while (receiverBic === senderBic) {
    receiverBic = pickBic(rng, false);
  }
  const payload: PaymentSwiftPayload = {
    txnId,
    amount,
    currency: rng.helpers.weightedArrayElement(SWIFT_CURRENCIES),
    messageType,
    senderBic,
    receiverBic,
    uetr: generateUetr(rng),
  };
  if (messageType === 'MT103' && rng.number.float({ min: 0, max: 1 }) < 0.35) {
    payload.correspondentBic = pickBic(rng, false);
  }
  return payload;
}

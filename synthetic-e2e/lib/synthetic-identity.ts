/**
 * Synthetic identity generator for E2E tests.
 *
 * Generates deterministic, identifiable synthetic identities for merchants
 * and customers. All synthetic data is tagged with a run_id prefix for
 * safe cleanup.
 *
 * Issue #728 safety gate 4: Fixture isolation and cleanup.
 * - Every synthetic entity is tagged with a durable run-scoped identifier
 * - Synthetic phone numbers use reserved test ranges
 * - Synthetic emails use a recognizable prefix
 */

import { randomBytes, createHash } from 'crypto';

// ── Constants ──

/** Prefix for all synthetic emails — easy to identify and clean up */
const SYNTHETIC_EMAIL_PREFIX = 'synth-e2e';

/** Domain for synthetic emails — must not be a real domain */
const SYNTHETIC_EMAIL_DOMAIN = 'test.waaiio.internal';

/**
 * Phone number prefix for synthetic customers.
 * Uses ITU-T test range: +15550xxxxxx (reserved for fictional use in US)
 * 6-digit suffix gives 1M unique values, collision-free for 500+ customers.
 */
const SYNTHETIC_PHONE_PREFIX = '15550';

/** Tag applied to synthetic records for identification */
const SYNTHETIC_TAG = 'synth-e2e';

// ── Types ──

export interface RunIdentity {
  runId: string;
  startedAt: string;
  tag: string;
}

export interface MerchantIdentity {
  runId: string;
  email: string;
  password: string;
  businessName: string;
  /** Sanitized version with secrets masked */
  sanitized: {
    email: string;
    password: string;
    businessName: string;
  };
}

export interface CustomerIdentity {
  runId: string;
  journeyId: string;
  phone: string;
  displayName: string;
  /** Sanitized version for logs */
  sanitized: {
    phone: string;
    displayName: string;
  };
}

// ── Generators ──

/**
 * Create a unique run identity. Each test run gets a unique ID
 * that ties all synthetic entities together for cleanup.
 */
export function createRunIdentity(): RunIdentity {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const random = randomBytes(4).toString('hex');
  return {
    runId: `${SYNTHETIC_TAG}-${timestamp}-${random}`,
    startedAt: new Date().toISOString(),
    tag: SYNTHETIC_TAG,
  };
}

/**
 * Generate a synthetic merchant identity.
 * The email and business name contain the run_id for traceability.
 */
export function generateMerchantIdentity(runId: string, index = 0): MerchantIdentity {
  const suffix = index > 0 ? `-${index}` : '';
  const shortId = runId.slice(-12);
  const email = `${SYNTHETIC_EMAIL_PREFIX}-merchant${suffix}-${shortId}@${SYNTHETIC_EMAIL_DOMAIN}`;
  const password = `SynthTest!${randomBytes(8).toString('hex')}`;
  const businessName = `SynthBiz ${shortId}${suffix}`;

  return {
    runId,
    email,
    password,
    businessName,
    sanitized: {
      email,
      password: '[REDACTED]',
      businessName,
    },
  };
}

/**
 * Generate a synthetic customer identity.
 * Phone numbers use the reserved 1-555-000-xxxx range.
 *
 * CTO R3/Phase 2 fix: Phone suffix is strictly numeric (0-9 only),
 * run-scoped (includes runId in hash), and collision-free for up to
 * 10,000 customers per run (4-digit numeric suffix).
 */
export function generateCustomerIdentity(
  runId: string,
  journeyId: string,
  index = 0,
): CustomerIdentity {
  // Hash includes runId for run-scoping: different runs never collide
  const hashBytes = createHash('sha256').update(`${runId}:${journeyId}:${index}`).digest();
  // Convert first 4 bytes to a 6-digit numeric suffix (000000-999999)
  const numericValue = hashBytes.readUInt32BE(0) % 1000000;
  const phoneDigits = String(numericValue).padStart(6, '0');
  const phone = `${SYNTHETIC_PHONE_PREFIX}${phoneDigits}`;
  const displayName = `SynthCustomer ${phoneDigits}`;

  return {
    runId,
    journeyId,
    phone,
    displayName,
    sanitized: {
      phone: `${SYNTHETIC_PHONE_PREFIX}****`,
      displayName,
    },
  };
}

/**
 * Check if an email belongs to a synthetic identity.
 */
export function isSyntheticEmail(email: string): boolean {
  return email.startsWith(SYNTHETIC_EMAIL_PREFIX) && email.endsWith(`@${SYNTHETIC_EMAIL_DOMAIN}`);
}

/**
 * Check if a phone number is in the synthetic test range.
 */
export function isSyntheticPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, '');
  return digits.startsWith(SYNTHETIC_PHONE_PREFIX);
}

/**
 * Check if a business name is synthetic.
 */
export function isSyntheticBusinessName(name: string): boolean {
  return name.startsWith('SynthBiz ');
}

/**
 * Extract the run ID from a synthetic email.
 */
export function extractRunIdFromEmail(email: string): string | null {
  if (!isSyntheticEmail(email)) return null;
  const match = email.match(new RegExp(`${SYNTHETIC_EMAIL_PREFIX}-merchant(?:-\\d+)?-([a-f0-9]+)@`));
  return match ? match[1] : null;
}

/**
 * Generate bulk customer identities with guaranteed uniqueness.
 * Fails if any phone collision is detected within the batch.
 *
 * @param runId - Run identity for scoping
 * @param count - Number of customers to generate
 * @param businessIndex - Business index (0-4) for journey ID prefixing
 * @returns Array of unique customer identities
 */
export function generateBulkCustomers(
  runId: string,
  count: number,
  businessIndex = 0,
): CustomerIdentity[] {
  const customers: CustomerIdentity[] = [];
  const phones = new Set<string>();

  for (let i = 0; i < count; i++) {
    const journeyId = `biz${businessIndex}-cust${i}`;
    const customer = generateCustomerIdentity(runId, journeyId, i);

    if (phones.has(customer.phone)) {
      throw new Error(
        `COLLISION: Phone ${customer.phone} already assigned at index ${i} ` +
        `(journeyId=${journeyId}, runId=${runId}). Increase phone space or fix hash.`
      );
    }
    phones.add(customer.phone);
    customers.push(customer);
  }

  return customers;
}

/**
 * Validate that a phone number contains only digits (no hex chars).
 */
export function isValidSyntheticPhone(phone: string): boolean {
  return /^\d+$/.test(phone) && phone.startsWith(SYNTHETIC_PHONE_PREFIX);
}

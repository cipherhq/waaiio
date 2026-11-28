/**
 * Brute force protection for code-check endpoints.
 *
 * Tracks failed attempts per key (phone, email, token, IP) and enforces:
 * - Lockout after N failures
 * - IP-level blocking after too many failures across all accounts
 *
 * Counts are kept in the shared Upstash store when it is configured
 * (lib/rate-limit.ts), so every server instance sees the same counts
 * (#1175 S8, F14). Without the store, counts are kept per server instance,
 * as before. If the store is unreachable, the call falls back to the
 * per-instance count and Sentry is alerted at once (#1175 C3 A).
 *
 * Each scope is counted separately (#1175 Q10 A): a customer's wrong
 * checkout codes never count toward a merchant's sign-in lockout, and
 * neither counts toward contract-signing codes.
 *
 * Store keys hold a SHA-256 hash of the identifier, never the raw phone
 * number, email or contract token.
 */

import { createHash } from 'crypto';
import * as Sentry from '@sentry/nextjs';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';
import { getSharedRedis } from '@/lib/rate-limit';

/**
 * - merchant: merchant sign-in codes (otp/send, otp/verify) and the dashboard
 *   claim-credit code, which share the phone count as before.
 * - customer: customer checkout email codes (email-otp).
 * - contract: contract-signing codes.
 */
export type BruteForceScope = 'merchant' | 'customer' | 'contract';

export interface BruteForceCheck {
  blocked: boolean;
  retryAfterMs?: number;
  failures?: number;
}

export interface BruteForceFailure {
  locked: boolean;
  failures: number;
  lockDurationMs?: number;
}

interface AttemptRecord {
  failures: number;
  lastFailure: number;
  lockedUntil: number;
}

export const BRUTE_FORCE_CONFIG = {
  maxFailures: 5,              // lock after 5 failures
  lockDurationMs: 15 * 60_000, // 15 min lockout
  failureWindowMs: 30 * 60_000, // reset failures after 30 min of no attempts
  ipMaxFailures: 20,           // block IP after 20 failures across all accounts
  ipLockDurationMs: 30 * 60_000, // 30 min IP block
} as const;

const CONFIG = BRUTE_FORCE_CONFIG;

function isIpKey(key: string): boolean {
  return key.startsWith('ip:');
}

function limitsFor(key: string) {
  return isIpKey(key)
    ? { max: CONFIG.ipMaxFailures, lockMs: CONFIG.ipLockDurationMs }
    : { max: CONFIG.maxFailures, lockMs: CONFIG.lockDurationMs };
}

/** Scope-qualified key used by the in-memory fallback. */
function memoryKey(scope: BruteForceScope, key: string): string {
  return `${scope}:${key}`;
}

/** Store keys: hashed identifier, separate count and lock keys per scope. */
export function storeKeys(scope: BruteForceScope, key: string): { count: string; lock: string } {
  const digest = createHash('sha256').update(key).digest('hex');
  return { count: `bf:${scope}:c:${digest}`, lock: `bf:${scope}:l:${digest}` };
}

// ── In-memory store (per serverless instance; also the outage fallback) ──

const attempts = new Map<string, AttemptRecord>();

let lastCleanup = Date.now();
function cleanup() {
  const now = Date.now();
  if (now - lastCleanup < 60_000) return;
  lastCleanup = now;
  for (const [key, record] of attempts) {
    if (now - record.lastFailure > CONFIG.failureWindowMs && now > record.lockedUntil) {
      attempts.delete(key);
    }
  }
  // Cap store size to prevent memory leaks
  if (attempts.size > 50_000) {
    const excess = attempts.size - 50_000;
    const iter = attempts.keys();
    for (let i = 0; i < excess; i++) {
      const next = iter.next();
      if (!next.done) attempts.delete(next.value);
    }
  }
}

function checkInMemory(mKey: string): BruteForceCheck {
  cleanup();
  const record = attempts.get(mKey);
  if (!record) return { blocked: false, failures: 0 };

  const now = Date.now();
  if (now - record.lastFailure > CONFIG.failureWindowMs) {
    attempts.delete(mKey);
    return { blocked: false, failures: 0 };
  }
  if (record.lockedUntil > now) {
    return { blocked: true, retryAfterMs: record.lockedUntil - now, failures: record.failures };
  }
  return { blocked: false, failures: record.failures };
}

function recordInMemory(mKey: string, key: string): BruteForceFailure {
  cleanup();
  const now = Date.now();
  const record = attempts.get(mKey) || { failures: 0, lastFailure: 0, lockedUntil: 0 };

  if (now - record.lastFailure > CONFIG.failureWindowMs) {
    record.failures = 0;
  }
  record.failures++;
  record.lastFailure = now;

  const { max, lockMs } = limitsFor(key);
  attempts.set(mKey, record);
  if (record.failures >= max) {
    record.lockedUntil = now + lockMs;
    return { locked: true, failures: record.failures, lockDurationMs: lockMs };
  }
  return { locked: false, failures: record.failures };
}

// ── Outage alert ──

function alertStoreOutage(operation: string, err: unknown): void {
  logger
    .withContext({ op: `brute-force.${operation}`, ...safeLogErrorContext(err) })
    .error('[BRUTE-FORCE] Shared store unreachable, counting per server');
  Sentry.captureMessage('Brute-force shared store unreachable; per-server fallback in use', {
    level: 'error',
    tags: { component: 'brute-force', operation },
  });
}

// ── Public API ──

/**
 * Check if a key (phone, email, token, or `ip:<address>`) is currently
 * blocked within its scope.
 */
export async function checkBruteForce(scope: BruteForceScope, key: string): Promise<BruteForceCheck> {
  const redis = getSharedRedis();
  if (!redis) return checkInMemory(memoryKey(scope, key));

  const k = storeKeys(scope, key);
  try {
    const [lockTtl, count] = await Promise.all([redis.pttl(k.lock), redis.get<number | string>(k.count)]);
    const failures = Number(count ?? 0) || 0;
    if (typeof lockTtl === 'number' && lockTtl > 0) {
      return { blocked: true, retryAfterMs: lockTtl, failures };
    }
    return { blocked: false, failures };
  } catch (err) {
    alertStoreOutage('check', err);
    return checkInMemory(memoryKey(scope, key));
  }
}

/**
 * Record a failed attempt. Returns whether the key is now locked.
 * The count resets after 30 minutes with no failures, as before.
 */
export async function recordFailure(scope: BruteForceScope, key: string): Promise<BruteForceFailure> {
  const redis = getSharedRedis();
  const mKey = memoryKey(scope, key);
  if (!redis) return logLock(scope, key, recordInMemory(mKey, key));

  const k = storeKeys(scope, key);
  const { max, lockMs } = limitsFor(key);
  try {
    // Atomic increment, then slide the 30-minute failure window.
    const [failuresRaw] = await redis
      .multi()
      .incr(k.count)
      .pexpire(k.count, CONFIG.failureWindowMs)
      .exec<[number, number]>();
    const failures = Number(failuresRaw) || 0;
    if (failures >= max) {
      await redis.set(k.lock, '1', { px: lockMs });
      return logLock(scope, key, { locked: true, failures, lockDurationMs: lockMs });
    }
    return { locked: false, failures };
  } catch (err) {
    alertStoreOutage('record', err);
    return logLock(scope, key, recordInMemory(mKey, key));
  }
}

/** Clear failures for a key (call after a successful check). */
export async function clearFailures(scope: BruteForceScope, key: string): Promise<void> {
  attempts.delete(memoryKey(scope, key));
  const redis = getSharedRedis();
  if (!redis) return;
  const k = storeKeys(scope, key);
  try {
    await redis.del(k.count, k.lock);
  } catch (err) {
    alertStoreOutage('clear', err);
  }
}

function logLock(scope: BruteForceScope, key: string, result: BruteForceFailure): BruteForceFailure {
  if (result.locked) {
    // Log the kind of key only, never the identifier itself.
    logger.warn(
      `[BRUTE-FORCE] Locked ${scope} ${isIpKey(key) ? 'address' : 'identifier'} after ${result.failures} failures for ${(result.lockDurationMs ?? 0) / 1000}s`,
    );
  }
  return result;
}

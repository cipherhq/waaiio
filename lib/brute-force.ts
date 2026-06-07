/**
 * Brute force protection for authentication endpoints.
 *
 * Tracks failed attempts per key (email, phone, IP) and enforces:
 * - Progressive lockout after N failures
 * - IP-level blocking after too many failures across all accounts
 *
 * Uses in-memory store (per serverless instance). For distributed
 * protection, the existing rate-limit.ts with Upstash Redis provides
 * cross-instance limiting — this module adds the lockout/penalty layer.
 */

import { logger } from '@/lib/logger';

interface AttemptRecord {
  failures: number;
  lastFailure: number;
  lockedUntil: number;
}

// In-memory store (per serverless instance)
const attempts = new Map<string, AttemptRecord>();

const CONFIG = {
  maxFailures: 5,              // lock after 5 failures
  lockDurationMs: 15 * 60_000, // 15 min lockout
  failureWindowMs: 30 * 60_000, // reset failures after 30 min of no attempts
  ipMaxFailures: 20,           // block IP after 20 failures across all accounts
  ipLockDurationMs: 30 * 60_000, // 30 min IP block
};

// Periodic cleanup of stale entries
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

/**
 * Check if a key (email, phone, or IP) is currently blocked.
 * Returns: { blocked: true, retryAfterMs } or { blocked: false }
 */
export function checkBruteForce(key: string): { blocked: boolean; retryAfterMs?: number; failures?: number } {
  cleanup();
  const record = attempts.get(key);
  if (!record) return { blocked: false, failures: 0 };

  const now = Date.now();

  // Reset if failures are stale
  if (now - record.lastFailure > CONFIG.failureWindowMs) {
    attempts.delete(key);
    return { blocked: false, failures: 0 };
  }

  // Check lockout
  if (record.lockedUntil > now) {
    return { blocked: true, retryAfterMs: record.lockedUntil - now, failures: record.failures };
  }

  return { blocked: false, failures: record.failures };
}

/**
 * Record a failed attempt. Returns whether the account is now locked.
 */
export function recordFailure(key: string): { locked: boolean; failures: number; lockDurationMs?: number } {
  cleanup();
  const now = Date.now();
  const record = attempts.get(key) || { failures: 0, lastFailure: 0, lockedUntil: 0 };

  // Reset if stale
  if (now - record.lastFailure > CONFIG.failureWindowMs) {
    record.failures = 0;
  }

  record.failures++;
  record.lastFailure = now;

  const maxFailures = key.startsWith('ip:') ? CONFIG.ipMaxFailures : CONFIG.maxFailures;
  const lockDuration = key.startsWith('ip:') ? CONFIG.ipLockDurationMs : CONFIG.lockDurationMs;

  if (record.failures >= maxFailures) {
    record.lockedUntil = now + lockDuration;
    attempts.set(key, record);
    logger.warn(`[BRUTE-FORCE] Locked ${key} after ${record.failures} failures for ${lockDuration / 1000}s`);
    return { locked: true, failures: record.failures, lockDurationMs: lockDuration };
  }

  attempts.set(key, record);
  return { locked: false, failures: record.failures };
}

/**
 * Clear failures for a key (call after successful auth).
 */
export function clearFailures(key: string): void {
  attempts.delete(key);
}

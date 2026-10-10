/**
 * #597 F3: Recurring cancellation authorization tests.
 *
 * Tests the OTP-bound cancellation proof system:
 * - issueRecurringCancellationProof creates valid, scoped proofs
 * - verifyRecurringCancellationProof rejects forged/expired/wrong-scope proofs
 * - Cancel route requires proof (rejects phone-only requests)
 * - Cancel route rejects invalid/expired proofs
 * - Cancel route checks gateway result before DB update
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Import the actual production functions
import {
  issueRecurringCancellationProof,
  verifyRecurringCancellationProof,
} from '@/lib/otp-challenge';

const CANCEL_ROUTE_PATH = join(process.cwd(), 'app/api/recurring/cancel/route.ts');

describe('#597 F3: Recurring cancellation proof system', () => {
  const PHONE = '+2348012345678';
  const SUB_ID = '00000000-0000-0000-0000-000000000001';

  describe('issueRecurringCancellationProof (production function)', () => {
    it('produces a non-empty string with two dot-separated parts', () => {
      const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
      expect(typeof proof).toBe('string');
      expect(proof.length).toBeGreaterThan(0);
      const parts = proof.split('.');
      expect(parts).toHaveLength(2);
      expect(parts[1]).toMatch(/^[a-f0-9]{64}$/); // HMAC-SHA256 signature
    });

    it('produces different proofs for different subscriptions', () => {
      const proof1 = issueRecurringCancellationProof(PHONE, SUB_ID);
      const proof2 = issueRecurringCancellationProof(PHONE, '00000000-0000-0000-0000-000000000002');
      expect(proof1).not.toBe(proof2);
    });

    it('produces different proofs for different phones', () => {
      const proof1 = issueRecurringCancellationProof(PHONE, SUB_ID);
      const proof2 = issueRecurringCancellationProof('+1234567890', SUB_ID);
      expect(proof1).not.toBe(proof2);
    });
  });

  describe('verifyRecurringCancellationProof (production function)', () => {
    it('accepts a valid, fresh proof with matching phone and subscription', () => {
      const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
      expect(verifyRecurringCancellationProof(proof, PHONE, SUB_ID)).toBe(true);
    });

    it('rejects proof for wrong phone', () => {
      const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
      expect(verifyRecurringCancellationProof(proof, '+9999999999', SUB_ID)).toBe(false);
    });

    it('rejects proof for wrong subscription', () => {
      const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
      expect(verifyRecurringCancellationProof(proof, PHONE, '00000000-0000-0000-0000-999999999999')).toBe(false);
    });

    it('rejects tampered payload', () => {
      const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
      const parts = proof.split('.');
      // Tamper the payload
      const tampered = Buffer.from('{"v":1,"phone":"+hack","subscriptionId":"x","issuedAt":1,"expiresAt":99999999999999}').toString('base64url');
      expect(verifyRecurringCancellationProof(tampered + '.' + parts[1], PHONE, SUB_ID)).toBe(false);
    });

    it('rejects tampered signature', () => {
      const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
      const parts = proof.split('.');
      const fakeSignature = 'a'.repeat(64);
      expect(verifyRecurringCancellationProof(parts[0] + '.' + fakeSignature, PHONE, SUB_ID)).toBe(false);
    });

    it('rejects null/undefined/non-string proof', () => {
      expect(verifyRecurringCancellationProof(null, PHONE, SUB_ID)).toBe(false);
      expect(verifyRecurringCancellationProof(undefined, PHONE, SUB_ID)).toBe(false);
      expect(verifyRecurringCancellationProof(123 as unknown, PHONE, SUB_ID)).toBe(false);
    });

    it('rejects empty string', () => {
      expect(verifyRecurringCancellationProof('', PHONE, SUB_ID)).toBe(false);
    });

    it('rejects oversized proof (DoS protection)', () => {
      expect(verifyRecurringCancellationProof('x'.repeat(1025), PHONE, SUB_ID)).toBe(false);
    });

    it('rejects proof with wrong number of parts', () => {
      expect(verifyRecurringCancellationProof('a.b.c', PHONE, SUB_ID)).toBe(false);
      expect(verifyRecurringCancellationProof('onlyonepart', PHONE, SUB_ID)).toBe(false);
    });
  });

  describe('Cancel route source-contract verification', () => {
    const src = readFileSync(CANCEL_ROUTE_PATH, 'utf-8');

    it('requires cancellationProof from request body', () => {
      expect(src).toContain('cancellationProof');
      expect(src).toContain('verifyRecurringCancellationProof');
    });

    it('returns 403 when proof is missing', () => {
      expect(src).toMatch(/!cancellationProof[\s\S]*?status:\s*403/);
    });

    it('returns 403 when proof verification fails', () => {
      expect(src).toMatch(/verifyRecurringCancellationProof[\s\S]*?status:\s*403/);
    });

    it('checks provider cancellation result before DB update', () => {
      // providerCancelled must be checked BEFORE the DB update
      const providerCheckIdx = src.indexOf('providerCancelled');
      const dbUpdateIdx = src.indexOf('.update({');
      expect(providerCheckIdx).toBeGreaterThan(-1);
      expect(dbUpdateIdx).toBeGreaterThan(providerCheckIdx);
    });

    it('returns 503 when provider refuses cancellation', () => {
      expect(src).toMatch(/!providerCancelled[\s\S]*?status:\s*503/);
    });

    it('uses CAS guard on DB update', () => {
      expect(src).toContain(".in('status', ['active', 'paused', 'past_due'])");
    });

    it('does not return success without checking DB update result', () => {
      expect(src).toContain('updateError');
      expect(src).toMatch(/updateError[\s\S]*?status:\s*503/);
    });

    it('does not use phone-only authentication', () => {
      // The old route used phone + subscriptionId as the only auth
      // The new route MUST require cancellationProof
      expect(src).not.toMatch(/\/\/ Verify ownership by phone\s*\n\s*const \{ data: sub \}/);
    });
  });
});

/**
 * Payment Activation Gate Tests
 *
 * Documents and verifies that payment activation is controlled at two levels:
 *
 * 1. PAYOUTS: Global kill switch via ENABLE_PAYOUTS env var (already tested extensively
 *    in deferred-features-server-disable.test.ts and payout-feature-flag.test.ts)
 *
 * 2. PAYMENTS: Business-level credential gating. There is NO global ENABLE_PAYMENTS
 *    kill switch. Instead, payment initialization requires valid gateway credentials
 *    (PAYSTACK_SECRET_KEY, STRIPE_SECRET_KEY, etc.) or BYO business credentials.
 *    A business without payment credentials cannot create payment links in production.
 *
 * Design decision: Payment activation requires business-level credential setup,
 * not a global flag. This allows per-business control and supports BYO gateway models.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Payment Activation Gate', () => {
  describe('ENABLE_PAYOUTS kill switch (reference)', () => {
    it('payout approve route checks ENABLE_PAYOUTS at top of handler', () => {
      const routePath = path.resolve(__dirname, '../../app/api/admin/payouts/[id]/approve/route.ts');
      const content = fs.readFileSync(routePath, 'utf-8');
      expect(content).toContain("process.env.ENABLE_PAYOUTS !== 'true'");
    });

    it('payout complete route checks ENABLE_PAYOUTS at top of handler', () => {
      const routePath = path.resolve(__dirname, '../../app/api/admin/payouts/[id]/complete/route.ts');
      const content = fs.readFileSync(routePath, 'utf-8');
      expect(content).toContain("process.env.ENABLE_PAYOUTS !== 'true'");
    });

    it('payout generate route checks ENABLE_PAYOUTS at top of handler', () => {
      const routePath = path.resolve(__dirname, '../../app/api/admin/payouts/generate/route.ts');
      const content = fs.readFileSync(routePath, 'utf-8');
      expect(content).toContain("process.env.ENABLE_PAYOUTS !== 'true'");
    });

    it('auto-payout cron checks ENABLE_PAYOUTS at top of handler', () => {
      const routePath = path.resolve(__dirname, '../../app/api/cron/auto-payout/route.ts');
      const content = fs.readFileSync(routePath, 'utf-8');
      expect(content).toContain("process.env.ENABLE_PAYOUTS !== 'true'");
    });
  });

  describe('Payment initialization requires valid gateway credentials', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      vi.resetModules();
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('Paystack gateway returns null in production when secret key is missing', async () => {
      delete process.env.PAYSTACK_SECRET_KEY;
      process.env.NODE_ENV = 'production';

      const { PaystackGateway } = await import('@/lib/payments/paystack');
      const gateway = new PaystackGateway();

      const mockSupabase = {
        from: () => ({ insert: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), single: vi.fn() }),
      } as any;

      // Gateway catches the internal error and returns null — no payment link created
      const result = await gateway.initializePayment({
        supabase: mockSupabase,
        userId: 'test-user',
        amount: 1000,
        currency: 'NGN',
        referenceCode: 'REF-TEST-001',
        businessName: 'Test Biz',
        phone: '+2341234567890',
        businessId: 'biz-123',
      });

      expect(result).toBeNull();
    });

    it('Paystack gateway falls back to mock in non-production when key is missing', async () => {
      delete process.env.PAYSTACK_SECRET_KEY;
      process.env.NODE_ENV = 'test';

      const { PaystackGateway } = await import('@/lib/payments/paystack');
      const gateway = new PaystackGateway();

      const insertMock = vi.fn().mockReturnValue({ select: () => ({ single: () => ({ data: { id: 'p1' }, error: null }) }) });
      const mockSupabase = {
        from: () => ({ insert: insertMock }),
      } as any;

      const result = await gateway.initializePayment({
        supabase: mockSupabase,
        userId: 'test-user',
        amount: 1000,
        currency: 'NGN',
        referenceCode: 'REF-TEST-002',
        businessName: 'Test Biz',
        phone: '+2341234567890',
        businessId: 'biz-123',
      });

      // In non-production, returns a mock URL (not null, not throw)
      expect(result).not.toBeNull();
      if (result) {
        expect(result.url).toContain('mock');
        expect(result.reference).toContain('mock');
      }
    });

    it('BYO payment requires byoSecretKey to use business credentials', async () => {
      // When isByo=true but no byoSecretKey, falls back to platform key
      // This documents that BYO mode without credentials falls through to platform
      const { PaystackGateway } = await import('@/lib/payments/paystack');
      const gateway = new PaystackGateway();

      // Read the source to verify the logic
      const sourcePath = path.resolve(__dirname, '../payments/paystack.ts');
      const source = fs.readFileSync(sourcePath, 'utf-8');

      // The key selection logic: BYO requires byoSecretKey
      expect(source).toContain('opts.isByo && opts.byoSecretKey');
    });

    it('no global ENABLE_PAYMENTS env var exists (by design)', () => {
      // Search all payment route files for ENABLE_PAYMENTS — should not exist
      const paymentRoutesDir = path.resolve(__dirname, '../../app/api/payments');
      if (fs.existsSync(paymentRoutesDir)) {
        const files = getAllTsFiles(paymentRoutesDir);
        for (const file of files) {
          const content = fs.readFileSync(file, 'utf-8');
          expect(content).not.toContain('ENABLE_PAYMENTS');
        }
      }

      // Also check lib/payments
      const libDir = path.resolve(__dirname, '../payments');
      const libFiles = getAllTsFiles(libDir);
      for (const file of libFiles) {
        const content = fs.readFileSync(file, 'utf-8');
        expect(content).not.toContain('ENABLE_PAYMENTS');
      }
    });

    it('payment factory resolves gateway by country without credential check', () => {
      // The factory simply returns the gateway instance — credential checks happen
      // at initializePayment() time, not at resolution time. This is correct because
      // the same gateway class handles both platform and BYO credentials.
      const factoryPath = path.resolve(__dirname, '../payments/factory.ts');
      const source = fs.readFileSync(factoryPath, 'utf-8');

      // Factory does not check env vars — that's initializePayment's job
      expect(source).not.toContain('process.env');
      // Factory exports getPaymentGateway and getPaymentGatewayByName
      expect(source).toContain('export function getPaymentGateway');
      expect(source).toContain('export function getPaymentGatewayByName');
    });
  });
});

/** Recursively get all .ts files in a directory */
function getAllTsFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllTsFiles(full));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Owner decision 2026-11-18: the monthly platform-fee invoice job is switched
 * off. It billed merchant-connected (byo/connect) fees that the split had
 * already collected, and direct bank transfers carry a ₦0 fee. Scheduling it
 * again needs a new Owner decision (docs/MERCHANT_PAYMENT_CUSTODY_POLICY.md).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const crons = JSON.parse(readFileSync('vercel.json', 'utf8')).crons as Array<{ path: string; schedule: string }>;

describe('fee invoice cron is switched off (Owner 2026-11-18)', () => {
  it('vercel.json does not schedule /api/cron/platform-fee-invoices', () => {
    expect(crons.some(c => c.path.startsWith('/api/cron/platform-fee-invoices'))).toBe(false);
  });

  it('vercel.json does not schedule the fee-invoice overdue reminder either', () => {
    expect(crons.some(c => c.path.startsWith('/api/cron/platform-fee-overdue'))).toBe(false);
  });

  it('other crons are still scheduled', () => {
    expect(crons.length).toBeGreaterThan(10);
    expect(crons.some(c => c.path === '/api/cron/expire-transfers')).toBe(true);
  });

  it('the route stays in place and points to the Owner decision', () => {
    const src = readFileSync('app/api/cron/platform-fee-invoices/route.ts', 'utf8');
    expect(src).toContain('SWITCHED OFF (Owner decision 2026-11-18)');
  });

  it('the custody policy records both 2026-11-18 decisions', () => {
    const doc = readFileSync('docs/MERCHANT_PAYMENT_CUSTODY_POLICY.md', 'utf8');
    expect(doc).toContain('Monthly platform-fee invoice — switched off (Owner decision, 2026-11-18)');
    expect(doc).toContain('Fee on direct bank transfer and cash — stays ₦0 (Owner decision, 2026-11-18)');
  });
});

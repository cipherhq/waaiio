/**
 * #244: Manual booking spend non-inflation — source-code verification.
 *
 * Verifies that the create-manual booking API route passes p_booking_amount: 0
 * to upsert_customer_profile, preventing LTV inflation for manual bookings.
 *
 * This is a source-string test (supplementary evidence) — the real DB test is
 * in acc-244-booking-confirmation-intent-db.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('#244 Manual booking — source verification', () => {
  const routePath = join(process.cwd(), 'app/api/bookings/create-manual/route.ts');
  let source: string;

  try {
    source = readFileSync(routePath, 'utf-8');
  } catch {
    source = '';
  }

  it('create-manual route passes p_booking_amount: 0 (not itemPrice)', () => {
    expect(source).toContain('p_booking_amount: 0');
    expect(source).not.toMatch(/p_booking_amount:\s*itemPrice/);
  });

  it('create-manual route calls claim_booking_confirmation after booking creation', () => {
    expect(source).toContain("claim_booking_confirmation");
    expect(source).toContain("p_purpose: 'create'");
  });

  it('create-manual route does NOT create a payment row', () => {
    // Verify no insert into payments table
    expect(source).not.toMatch(/\.from\(['"]payments['"]\)\.insert/);
    expect(source).not.toMatch(/INSERT INTO.*payments/i);
  });
});

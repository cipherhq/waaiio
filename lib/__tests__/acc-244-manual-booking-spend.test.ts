/**
 * #244: Manual booking spend non-inflation + durable intent authority — source-code verification.
 *
 * Verifies that the create-manual booking API route:
 * 1. Passes p_booking_amount: 0 to upsert_customer_profile
 * 2. Uses the durable intent lifecycle (claim → dispatch → single-attempt → outcome)
 * 3. Does NOT use the old sendOrEmail() direct send
 * 4. Does NOT create a payment row
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

  it('create-manual route uses singleAttemptWhatsAppSend (not sendOrEmail for WA)', () => {
    expect(source).toContain('singleAttemptWhatsAppSend');
    // sendOrEmail should not be used for WhatsApp delivery in this route
    expect(source).not.toContain('sendOrEmail(');
  });

  it('create-manual route uses mark_booking_confirmation_dispatched before send', () => {
    expect(source).toContain('mark_booking_confirmation_dispatched');
    // The dispatch barrier RPC call must appear before the singleAttemptWhatsAppSend call
    // Use the RPC string (not the import) to find the actual dispatch location
    const dispatchIdx = source.indexOf("'mark_booking_confirmation_dispatched'");
    const sendCallIdx = source.indexOf('singleAttemptWhatsAppSend(');
    expect(dispatchIdx).toBeGreaterThan(0);
    expect(sendCallIdx).toBeGreaterThan(0);
    expect(dispatchIdx).toBeLessThan(sendCallIdx);
  });

  it('create-manual route records outcome after send', () => {
    expect(source).toContain('record_booking_confirmation_outcome');
  });
});

describe('#244 Confirm route — resend safety verification', () => {
  const confirmPath = join(process.cwd(), 'app/api/bookings/confirm/route.ts');
  let source: string;

  try {
    source = readFileSync(confirmPath, 'utf-8');
  } catch {
    source = '';
  }

  it('confirm route checks create intent status before allowing resend', () => {
    expect(source).toContain('create_intent_unresolved');
    expect(source).toContain("purpose === 'resend'");
  });

  it('confirm route blocks resend when create intent is in dispatched/indeterminate', () => {
    expect(source).toContain('dispatched');
    expect(source).toContain('indeterminate');
    expect(source).toContain('nonTerminalStates');
  });

  it('confirm route uses singleAttemptWhatsAppSend (not sendOrEmail)', () => {
    expect(source).toContain('singleAttemptWhatsAppSend');
    expect(source).not.toContain('sendOrEmail(');
  });

  it('confirm route uses dispatch barrier before send', () => {
    expect(source).toContain('mark_booking_confirmation_dispatched');
    // The dispatch barrier RPC call must appear before the singleAttemptWhatsAppSend call
    const dispatchIdx = source.indexOf("'mark_booking_confirmation_dispatched'");
    const sendCallIdx = source.indexOf('singleAttemptWhatsAppSend(');
    expect(dispatchIdx).toBeGreaterThan(0);
    expect(sendCallIdx).toBeGreaterThan(0);
    expect(dispatchIdx).toBeLessThan(sendCallIdx);
  });
});

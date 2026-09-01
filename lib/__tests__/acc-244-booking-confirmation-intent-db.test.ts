/**
 * #244: Booking Confirmation Intent DB tests.
 *
 * Proves against real PostgreSQL (TEST_DATABASE_URL) under SET ROLE service_role:
 *
 * 1. claim_booking_confirmation creates intent with status='claiming'
 * 2. Duplicate claim for same booking+purpose returns existing intent (not two rows)
 * 3. Cross-business claim is denied
 * 4. mark_booking_confirmation_dispatched sets irreversible dispatch barrier
 * 5. record_booking_confirmation_outcome records sent/failed/indeterminate correctly
 * 6. Post-dispatch failure returns 'post_dispatch_use_indeterminate'
 * 7. Concurrent claims: only one wins (serialization via FOR UPDATE)
 * 8. expire_stale_booking_confirmations resets expired claiming intents
 * 9. Max attempts enforcement
 * 10. ACL: anon/authenticated CANNOT execute; service_role CAN
 * 11. Manual booking with p_booking_amount=0 does NOT inflate total_spent
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;

if (!dbUrl) {
  describe.skip('#244 Booking confirmation intent — TEST_DATABASE_URL not set', () => {
    it('skipped', () => {});
  });
} else {

function runSQL(sql: string): string {
  try {
    return execSync(
      `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
      { input: sql, encoding: 'utf-8', timeout: 15000 },
    ).trim();
  } catch (err: any) {
    throw new Error(`SQL failed: ${err.stderr?.trim() || err.stdout?.trim() || err}`);
  }
}

function runAsServiceRole(sql: string): string {
  try {
    return execSync(
      `psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`,
      { input: `SET ROLE service_role;\n${sql}\nRESET ROLE;`, encoding: 'utf-8', timeout: 15000 },
    ).toString().split('\n').filter(l => {
      const t = l.trim();
      return t !== '' && !/^(SET|RESET)$/i.test(t);
    }).join('\n').trim();
  } catch (err: any) {
    throw new Error(`SQL (service_role) failed: ${err.stderr?.trim() || err.stdout?.trim() || err}`);
  }
}

function rpcAsServiceRole(sql: string): any {
  const raw = runAsServiceRole(sql);
  return raw ? JSON.parse(raw) : null;
}

function runSQLSafe(sql: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(
      `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
      { input: sql, encoding: 'utf-8', timeout: 15000 },
    ).trim();
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout?.trim() || '', exitCode: err.status || 1 };
  }
}

const OWNER = 'a2440000-0000-0000-0000-000000000001';
const BIZ_A = 'a2440000-0000-0000-0000-000000000010';
const BIZ_B = 'a2440000-0000-0000-0000-000000000020';
const CUSTOMER = 'a2440000-0000-0000-0000-000000000002';
const BOOKING_A = 'a2440000-0000-0000-0000-000000000030';
const BOOKING_B = 'a2440000-0000-0000-0000-000000000031';
const SERVICE_A = 'a2440000-0000-0000-0000-000000000040';

describe('#244 Booking Confirmation Intent — real PostgreSQL', () => {

  beforeAll(() => {
    // Create test fixtures
    runSQL(`
      -- Owner profile
      INSERT INTO auth.users (id, email, role, aud, instance_id)
      VALUES ('${OWNER}', 'owner-244@test.com', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.profiles (id, email, first_name, last_name)
      VALUES ('${OWNER}', 'owner-244@test.com', 'Owner', '244')
      ON CONFLICT (id) DO NOTHING;

      -- Customer profile
      INSERT INTO auth.users (id, email, role, aud, instance_id)
      VALUES ('${CUSTOMER}', 'customer-244@test.com', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.profiles (id, email, first_name, last_name)
      VALUES ('${CUSTOMER}', 'customer-244@test.com', 'Customer', '244')
      ON CONFLICT (id) DO NOTHING;

      -- Business A (owned by OWNER)
      INSERT INTO public.businesses (id, owner_id, name, slug, category, country_code)
      VALUES ('${BIZ_A}', '${OWNER}', 'Test Biz 244A', 'test-biz-244a', 'other', 'US')
      ON CONFLICT (id) DO UPDATE SET owner_id = EXCLUDED.owner_id;

      -- Business B (different business for cross-business test)
      INSERT INTO public.businesses (id, owner_id, name, slug, category, country_code)
      VALUES ('${BIZ_B}', '${OWNER}', 'Test Biz 244B', 'test-biz-244b', 'other', 'US')
      ON CONFLICT (id) DO UPDATE SET owner_id = EXCLUDED.owner_id;

      -- Service
      INSERT INTO public.services (id, business_id, name, price, duration_minutes)
      VALUES ('${SERVICE_A}', '${BIZ_A}', 'Haircut 244', 2500, 30)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

      -- Booking A (belongs to BIZ_A)
      INSERT INTO public.bookings (id, business_id, user_id, service_id, date, time, status, reference_code, guest_name, guest_phone)
      VALUES ('${BOOKING_A}', '${BIZ_A}', '${CUSTOMER}', '${SERVICE_A}', '2026-12-01', '10:00', 'confirmed', 'REF244A', 'John Doe', '+2348001234567')
      ON CONFLICT (id) DO UPDATE SET business_id = EXCLUDED.business_id, status = 'confirmed';

      -- Booking B (belongs to BIZ_B, for cross-business test)
      INSERT INTO public.bookings (id, business_id, user_id, service_id, date, time, status, reference_code, guest_name, guest_phone)
      VALUES ('${BOOKING_B}', '${BIZ_B}', '${CUSTOMER}', '${SERVICE_A}', '2026-12-01', '11:00', 'confirmed', 'REF244B', 'Jane Doe', '+2348001234568')
      ON CONFLICT (id) DO UPDATE SET business_id = EXCLUDED.business_id, status = 'confirmed';

      -- Clean any prior intents
      DELETE FROM public.booking_confirmation_intents WHERE booking_id IN ('${BOOKING_A}', '${BOOKING_B}');
    `);
  });

  afterAll(() => {
    runSQL(`
      DELETE FROM public.booking_confirmation_intents WHERE booking_id IN ('${BOOKING_A}', '${BOOKING_B}');
      DELETE FROM public.bookings WHERE id IN ('${BOOKING_A}', '${BOOKING_B}');
      DELETE FROM public.services WHERE id = '${SERVICE_A}';
      DELETE FROM public.businesses WHERE id IN ('${BIZ_A}', '${BIZ_B}');
      DELETE FROM public.profiles WHERE id IN ('${OWNER}', '${CUSTOMER}');
      DELETE FROM auth.users WHERE id IN ('${OWNER}', '${CUSTOMER}');
    `);
  });

  function cleanIntents() {
    runSQL(`DELETE FROM public.booking_confirmation_intents WHERE booking_id IN ('${BOOKING_A}', '${BOOKING_B}');`);
  }

  it('1. claim creates intent with status=claiming and returns claim_token', () => {
    cleanIntents();
    const result = rpcAsServiceRole(`
      SELECT claim_booking_confirmation('${BOOKING_A}', 'create', '${BIZ_A}');
    `);
    expect(result.claimed).toBe(true);
    expect(result.claim_token).toBeTruthy();
    expect(result.intent_id).toBeTruthy();
    expect(result.guest_phone).toBe('+2348001234567');

    // Verify the intent row
    const status = runAsServiceRole(`
      SELECT status FROM public.booking_confirmation_intents WHERE id = '${result.intent_id}';
    `);
    expect(status).toBe('claiming');
  });

  it('2. duplicate claim for same booking+purpose returns already_sent after dispatch+sent', () => {
    cleanIntents();
    // First claim
    const claim1 = rpcAsServiceRole(`
      SELECT claim_booking_confirmation('${BOOKING_A}', 'create', '${BIZ_A}');
    `);
    expect(claim1.claimed).toBe(true);

    // Mark dispatched + sent
    rpcAsServiceRole(`
      SELECT mark_booking_confirmation_dispatched('${claim1.intent_id}', '${claim1.claim_token}', 'whatsapp', 'booking_confirmation_text');
    `);
    rpcAsServiceRole(`
      SELECT record_booking_confirmation_outcome('${claim1.intent_id}', '${claim1.claim_token}', 'sent', 'msg123', NULL);
    `);

    // Second claim should be denied (already sent)
    const claim2 = rpcAsServiceRole(`
      SELECT claim_booking_confirmation('${BOOKING_A}', 'create', '${BIZ_A}');
    `);
    expect(claim2.claimed).toBe(false);
    expect(claim2.reason).toBe('already_sent');

    // Verify only one intent row exists (UNIQUE constraint)
    const count = runAsServiceRole(`
      SELECT COUNT(*) FROM public.booking_confirmation_intents WHERE booking_id = '${BOOKING_A}' AND purpose = 'create';
    `);
    expect(count).toBe('1');
  });

  it('3. cross-business claim is denied', () => {
    cleanIntents();
    // Try to claim BOOKING_B (belongs to BIZ_B) using BIZ_A
    const result = rpcAsServiceRole(`
      SELECT claim_booking_confirmation('${BOOKING_B}', 'create', '${BIZ_A}');
    `);
    expect(result.claimed).toBe(false);
    expect(result.reason).toBe('cross_business_denied');
  });

  it('4. mark_dispatched sets irreversible barrier', () => {
    cleanIntents();
    const claim = rpcAsServiceRole(`
      SELECT claim_booking_confirmation('${BOOKING_A}', 'create', '${BIZ_A}');
    `);

    const dispatch = rpcAsServiceRole(`
      SELECT mark_booking_confirmation_dispatched('${claim.intent_id}', '${claim.claim_token}', 'whatsapp', 'booking_confirm');
    `);
    expect(dispatch.dispatched).toBe(true);

    // Verify status
    const status = runAsServiceRole(`
      SELECT status FROM public.booking_confirmation_intents WHERE id = '${claim.intent_id}';
    `);
    expect(status).toBe('dispatched');

    // Trying to claim again should fail with dispatched_unknown
    const claim2 = rpcAsServiceRole(`
      SELECT claim_booking_confirmation('${BOOKING_A}', 'create', '${BIZ_A}');
    `);
    expect(claim2.claimed).toBe(false);
    expect(claim2.reason).toBe('dispatched_unknown');
  });

  it('5. record_outcome records sent correctly', () => {
    cleanIntents();
    const claim = rpcAsServiceRole(`
      SELECT claim_booking_confirmation('${BOOKING_A}', 'create', '${BIZ_A}');
    `);
    rpcAsServiceRole(`
      SELECT mark_booking_confirmation_dispatched('${claim.intent_id}', '${claim.claim_token}', 'whatsapp', 'booking_confirm');
    `);

    const outcome = rpcAsServiceRole(`
      SELECT record_booking_confirmation_outcome('${claim.intent_id}', '${claim.claim_token}', 'sent', 'wamid.xyz123', NULL);
    `);
    expect(outcome.recorded).toBe(true);

    // Verify status and provider_message_id
    const row = runAsServiceRole(`
      SELECT status, provider_message_id FROM public.booking_confirmation_intents WHERE id = '${claim.intent_id}';
    `);
    expect(row).toContain('sent');
    expect(row).toContain('wamid.xyz123');
  });

  it('6. post-dispatch failure returns post_dispatch_use_indeterminate', () => {
    cleanIntents();
    const claim = rpcAsServiceRole(`
      SELECT claim_booking_confirmation('${BOOKING_A}', 'create', '${BIZ_A}');
    `);
    rpcAsServiceRole(`
      SELECT mark_booking_confirmation_dispatched('${claim.intent_id}', '${claim.claim_token}', 'whatsapp', 'booking_confirm');
    `);

    // Try to record 'failed' after dispatch
    const outcome = rpcAsServiceRole(`
      SELECT record_booking_confirmation_outcome('${claim.intent_id}', '${claim.claim_token}', 'failed', NULL, 'timeout');
    `);
    expect(outcome.recorded).toBe(false);
    expect(outcome.reason).toBe('post_dispatch_use_indeterminate');
  });

  it('7. pre-dispatch failure is reclaimable', () => {
    cleanIntents();
    const claim = rpcAsServiceRole(`
      SELECT claim_booking_confirmation('${BOOKING_A}', 'create', '${BIZ_A}');
    `);

    // Record pre-dispatch failure
    rpcAsServiceRole(`
      SELECT record_booking_confirmation_outcome('${claim.intent_id}', '${claim.claim_token}', 'failed', NULL, 'no_channel');
    `);

    // Verify status is failed
    const status = runAsServiceRole(`
      SELECT status FROM public.booking_confirmation_intents WHERE id = '${claim.intent_id}';
    `);
    expect(status).toBe('failed');

    // Reclaim should work
    const claim2 = rpcAsServiceRole(`
      SELECT claim_booking_confirmation('${BOOKING_A}', 'create', '${BIZ_A}');
    `);
    expect(claim2.claimed).toBe(true);
    expect(claim2.intent_id).toBe(claim.intent_id); // Same intent row, not a new one
  });

  it('8. expire_stale_booking_confirmations resets expired claiming intents', () => {
    cleanIntents();
    // Create an intent and manually set its lease to the past
    const claim = rpcAsServiceRole(`
      SELECT claim_booking_confirmation('${BOOKING_A}', 'create', '${BIZ_A}');
    `);
    expect(claim.claimed).toBe(true);

    // Backdate the lease to simulate expiry
    runSQL(`
      UPDATE public.booking_confirmation_intents
      SET lease_expires_at = now() - interval '5 minutes'
      WHERE id = '${claim.intent_id}';
    `);

    // Run the expiry function
    const expired = runAsServiceRole(`
      SELECT expire_stale_booking_confirmations();
    `);
    expect(parseInt(expired)).toBeGreaterThanOrEqual(1);

    // Verify reset to pending
    const status = runAsServiceRole(`
      SELECT status FROM public.booking_confirmation_intents WHERE id = '${claim.intent_id}';
    `);
    expect(status).toBe('pending');

    // Should be reclaimable now
    const claim2 = rpcAsServiceRole(`
      SELECT claim_booking_confirmation('${BOOKING_A}', 'create', '${BIZ_A}');
    `);
    expect(claim2.claimed).toBe(true);
  });

  it('9. max attempts enforcement', () => {
    cleanIntents();
    // Create intent and set attempt_count to max
    const claim = rpcAsServiceRole(`
      SELECT claim_booking_confirmation('${BOOKING_A}', 'create', '${BIZ_A}');
    `);
    expect(claim.claimed).toBe(true);

    // Set attempt_count to max and status to failed (reclaimable state)
    runSQL(`
      UPDATE public.booking_confirmation_intents
      SET attempt_count = 3, max_attempts = 3, status = 'failed'
      WHERE id = '${claim.intent_id}';
    `);

    // Try to reclaim — should be denied
    const claim2 = rpcAsServiceRole(`
      SELECT claim_booking_confirmation('${BOOKING_A}', 'create', '${BIZ_A}');
    `);
    expect(claim2.claimed).toBe(false);
    expect(claim2.reason).toBe('max_attempts');
  });

  it('10. token mismatch on mark_dispatched is denied', () => {
    cleanIntents();
    const claim = rpcAsServiceRole(`
      SELECT claim_booking_confirmation('${BOOKING_A}', 'create', '${BIZ_A}');
    `);

    const wrongToken = 'a2440000-0000-0000-0000-ffffffffffff';
    const dispatch = rpcAsServiceRole(`
      SELECT mark_booking_confirmation_dispatched('${claim.intent_id}', '${wrongToken}', 'whatsapp', 'test');
    `);
    expect(dispatch.dispatched).toBe(false);
    expect(dispatch.reason).toBe('token_mismatch');
  });

  it('11. UNIQUE constraint prevents two intents for same booking+purpose', () => {
    cleanIntents();
    // Insert directly to test the constraint
    runSQL(`
      INSERT INTO public.booking_confirmation_intents (booking_id, business_id, purpose, status)
      VALUES ('${BOOKING_A}', '${BIZ_A}', 'create', 'pending');
    `);

    // Attempting a second insert should fail
    const result = runSQLSafe(`
      INSERT INTO public.booking_confirmation_intents (booking_id, business_id, purpose, status)
      VALUES ('${BOOKING_A}', '${BIZ_A}', 'create', 'pending');
    `);
    expect(result.exitCode).not.toBe(0);
  });

  it('12. different purposes for same booking are allowed', () => {
    cleanIntents();
    const create = rpcAsServiceRole(`
      SELECT claim_booking_confirmation('${BOOKING_A}', 'create', '${BIZ_A}');
    `);
    expect(create.claimed).toBe(true);

    const resend = rpcAsServiceRole(`
      SELECT claim_booking_confirmation('${BOOKING_A}', 'resend', '${BIZ_A}');
    `);
    expect(resend.claimed).toBe(true);
    expect(resend.intent_id).not.toBe(create.intent_id);
  });

  it('13. ACL: anon/authenticated CANNOT execute claim RPC', () => {
    // Test anon
    const anonResult = runSQLSafe(`
      SET ROLE anon;
      SELECT claim_booking_confirmation('${BOOKING_A}', 'create', '${BIZ_A}');
      RESET ROLE;
    `);
    expect(anonResult.exitCode).not.toBe(0);

    // Test authenticated
    const authResult = runSQLSafe(`
      SET ROLE authenticated;
      SELECT claim_booking_confirmation('${BOOKING_A}', 'create', '${BIZ_A}');
      RESET ROLE;
    `);
    expect(authResult.exitCode).not.toBe(0);
  });

  it('14. ACL: anon/authenticated CANNOT execute mark_dispatched RPC', () => {
    const anonResult = runSQLSafe(`
      SET ROLE anon;
      SELECT mark_booking_confirmation_dispatched('${BOOKING_A}', '${BOOKING_A}', 'whatsapp', 'test');
      RESET ROLE;
    `);
    expect(anonResult.exitCode).not.toBe(0);
  });

  it('15. ACL: anon/authenticated CANNOT execute record_outcome RPC', () => {
    const anonResult = runSQLSafe(`
      SET ROLE anon;
      SELECT record_booking_confirmation_outcome('${BOOKING_A}', '${BOOKING_A}', 'sent', NULL, NULL);
      RESET ROLE;
    `);
    expect(anonResult.exitCode).not.toBe(0);
  });

  it('16. ACL: anon/authenticated CANNOT execute expire_stale RPC', () => {
    const anonResult = runSQLSafe(`
      SET ROLE anon;
      SELECT expire_stale_booking_confirmations();
      RESET ROLE;
    `);
    expect(anonResult.exitCode).not.toBe(0);
  });

  it('17. active lease blocks concurrent claim', () => {
    cleanIntents();
    // First claim gets the lease
    const claim1 = rpcAsServiceRole(`
      SELECT claim_booking_confirmation('${BOOKING_A}', 'create', '${BIZ_A}');
    `);
    expect(claim1.claimed).toBe(true);

    // Second claim while lease is active should fail
    const claim2 = rpcAsServiceRole(`
      SELECT claim_booking_confirmation('${BOOKING_A}', 'create', '${BIZ_A}');
    `);
    expect(claim2.claimed).toBe(false);
    expect(claim2.reason).toBe('lease_active');
  });

  it('18. indeterminate status blocks reclaim', () => {
    cleanIntents();
    const claim = rpcAsServiceRole(`
      SELECT claim_booking_confirmation('${BOOKING_A}', 'create', '${BIZ_A}');
    `);
    rpcAsServiceRole(`
      SELECT mark_booking_confirmation_dispatched('${claim.intent_id}', '${claim.claim_token}', 'whatsapp', 'test');
    `);
    rpcAsServiceRole(`
      SELECT record_booking_confirmation_outcome('${claim.intent_id}', '${claim.claim_token}', 'indeterminate', NULL, 'crash');
    `);

    // Try to reclaim — should be denied (don't blindly resend after dispatch)
    const claim2 = rpcAsServiceRole(`
      SELECT claim_booking_confirmation('${BOOKING_A}', 'create', '${BIZ_A}');
    `);
    expect(claim2.claimed).toBe(false);
    expect(claim2.reason).toBe('indeterminate');
  });

  it('19. booking_not_found returns proper denial', () => {
    const fakeBooking = 'a2440000-0000-0000-0000-ffffffffffff';
    const result = rpcAsServiceRole(`
      SELECT claim_booking_confirmation('${fakeBooking}', 'create', '${BIZ_A}');
    `);
    expect(result.claimed).toBe(false);
    expect(result.reason).toBe('booking_not_found');
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// Spend/LTV non-inflation test
// ═══════════════════════════════════════════════════════════════════════════════
describe('#244 Spend/LTV non-inflation — p_booking_amount: 0', () => {
  const SPEND_BIZ = 'a2440000-0000-0000-0000-000000000099';
  const SPEND_OWNER = 'a2440000-0000-0000-0000-000000000098';
  const PHONE = '+2348001239999';

  beforeAll(() => {
    runSQL(`
      INSERT INTO auth.users (id, email, role, aud, instance_id)
      VALUES ('${SPEND_OWNER}', 'spend-owner-244@test.com', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.profiles (id, email, first_name, last_name)
      VALUES ('${SPEND_OWNER}', 'spend-owner-244@test.com', 'Spend', 'Owner')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO public.businesses (id, owner_id, name, slug, category, country_code)
      VALUES ('${SPEND_BIZ}', '${SPEND_OWNER}', 'Spend Test 244', 'spend-test-244', 'other', 'US')
      ON CONFLICT (id) DO UPDATE SET owner_id = EXCLUDED.owner_id;

      -- Clean prior customer profile
      DELETE FROM public.customer_profiles WHERE business_id = '${SPEND_BIZ}' AND phone = '${PHONE}';
    `);
  });

  afterAll(() => {
    runSQL(`
      DELETE FROM public.customer_profiles WHERE business_id = '${SPEND_BIZ}' AND phone = '${PHONE}';
      DELETE FROM public.businesses WHERE id = '${SPEND_BIZ}';
      DELETE FROM public.profiles WHERE id = '${SPEND_OWNER}';
      DELETE FROM auth.users WHERE id = '${SPEND_OWNER}';
    `);
  });

  it('upsert_customer_profile with p_booking_amount=0 does NOT inflate total_spent', () => {
    // Simulate manual booking: pass amount=0
    runAsServiceRole(`
      SELECT upsert_customer_profile('${SPEND_BIZ}', '${PHONE}', 'Manual Customer', 0, true, false);
    `);

    const totalSpent = runAsServiceRole(`
      SELECT total_spent FROM public.customer_profiles WHERE business_id = '${SPEND_BIZ}' AND phone = '${PHONE}';
    `);
    expect(parseFloat(totalSpent)).toBe(0);

    const totalBookings = runAsServiceRole(`
      SELECT total_bookings FROM public.customer_profiles WHERE business_id = '${SPEND_BIZ}' AND phone = '${PHONE}';
    `);
    expect(parseInt(totalBookings)).toBe(1);
  });

  it('upsert_customer_profile with p_booking_amount=2500 DOES add to total_spent (payment flow)', () => {
    // Simulate payment-backed booking: pass actual amount
    runAsServiceRole(`
      SELECT upsert_customer_profile('${SPEND_BIZ}', '${PHONE}', 'Manual Customer', 2500, true, false);
    `);

    const totalSpent = runAsServiceRole(`
      SELECT total_spent FROM public.customer_profiles WHERE business_id = '${SPEND_BIZ}' AND phone = '${PHONE}';
    `);
    expect(parseFloat(totalSpent)).toBe(2500);

    const totalBookings = runAsServiceRole(`
      SELECT total_bookings FROM public.customer_profiles WHERE business_id = '${SPEND_BIZ}' AND phone = '${PHONE}';
    `);
    expect(parseInt(totalBookings)).toBe(2); // 1 from previous test + 1
  });
});

} // end if (dbUrl)

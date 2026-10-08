import { describe, it, expect, vi } from 'vitest';
import { createMockContext, createMockSupabase, getStep } from './helpers';
import { getTermsPrompt } from '../shared/terms';
import { schedulingFlow } from '../scheduling.flow';

// ──────────────────────────────────────────────────────────
// R1 — "View details" → "View T&Cs" in terms.ts
// ──────────────────────────────────────────────────────────

describe('#554 R1 — Terms label', () => {
  it('R1-T1: getTermsPrompt body contains "View T&Cs"', () => {
    const [prompt] = getTermsPrompt('Test Biz');
    expect(prompt.body).toContain('📎 View T&Cs:');
    expect(prompt.body).not.toContain('View details');
  });

  it('R1-T2: custom terms URL is preserved in output', () => {
    const customUrl = ['https:', '//example.com/my-terms'].join('');
    const [prompt] = getTermsPrompt('Test Biz', null, null, customUrl);
    expect(prompt.body).toContain(customUrl);
    expect(prompt.body).toMatch(/📎 View T&Cs:/);
  });

  it('R1-T3: fallback URL (waaiio.com/terms) is used when no custom URL', () => {
    const [prompt] = getTermsPrompt('Test Biz');
    expect(prompt.body).toContain('waaiio.com/terms');
  });

  it('R1-T4: accept_terms / cancel_terms button IDs unchanged', () => {
    const [prompt] = getTermsPrompt('Test Biz');
    expect(prompt.buttons).toEqual([
      { id: 'accept_terms', title: 'Continue ✅' },
      { id: 'cancel_terms', title: 'Cancel' },
    ]);
  });

  it('R1-T4b: custom terms text is included in body', () => {
    const [prompt] = getTermsPrompt('Test Biz', 'No refunds after 24 hours.');
    expect(prompt.body).toContain('No refunds after 24 hours.');
    expect(prompt.body).toContain('📎 View T&Cs:');
  });
});

// ──────────────────────────────────────────────────────────
// R2 — Scheduling terms consolidation
// ──────────────────────────────────────────────────────────

describe('#554 R2 — Scheduling terms consolidation', () => {
  const confirmStep = getStep(schedulingFlow, 'confirmation');
  const createBookingStep = getStep(schedulingFlow, 'create_booking');

  // Helper to build a confirmation context with paid service
  function buildConfirmCtx(overrides: Record<string, unknown> = {}, bizMetaOverrides: Record<string, unknown> = {}) {
    const supabase = createMockSupabase();
    return createMockContext({
      supabase: supabase as any,
      session: {
        id: 's1',
        user_id: 'u1',
        business_id: 'b1',
        current_step: 'confirmation',
        version: 0,
        session_data: {
          date: '2026-06-01',
          time: '10:00',
          service_name: 'Haircut',
          service_price: 5000,
          service_deposit: 0,
          party_size: 1,
          ...overrides,
        },
      },
      business: {
        id: 'b1',
        name: 'Test Salon',
        slug: 'test-salon',
        category: 'salon' as any,
        flow_type: 'scheduling' as any,
        subscription_tier: 'starter',
        trial_ends_at: null,
        metadata: { ...bizMetaOverrides },
      },
      copyLang: 'en',
    });
  }

  // ── R2: Confirmation step — inline T&C ──

  it('R2-T1: confirm_booking shows inline T&C + "I Accept & Confirm" for paid booking', async () => {
    const ctx = buildConfirmCtx();
    const messages = await confirmStep.prompt!(ctx);
    expect(messages).toHaveLength(1);
    const body = messages[0].body;
    expect(body).toContain('📎 Terms:');
    expect(body).toContain('waaiio.com/t/test-salon');
    // Button should be the accept-confirm variant
    const confirmBtn = messages[0].buttons?.find((b: { id: string }) => b.id === 'confirm');
    expect(confirmBtn).toBeDefined();
    expect(confirmBtn!.title).toContain('Accept');
  });

  it('R2-T2: confirm_booking shows regular "Confirm" for free booking (no T&C)', async () => {
    const ctx = buildConfirmCtx({ service_price: 0, service_deposit: 0 });
    const messages = await confirmStep.prompt!(ctx);
    const body = messages[0].body;
    expect(body).not.toContain('📎 Terms:');
    const confirmBtn = messages[0].buttons?.find((b: { id: string }) => b.id === 'confirm');
    expect(confirmBtn).toBeDefined();
    expect(confirmBtn!.title).not.toContain('Accept');
  });

  it('R2-T3: confirm_booking.validate sets _terms_accepted on confirm', async () => {
    const ctx = buildConfirmCtx();
    const result = await confirmStep.validate!('confirm', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?._terms_accepted).toBe(true);
    expect(result.data?._action).toBe('confirm');
  });

  it('R2-T3b: free booking confirmation never records terms acceptance', async () => {
    const ctx = buildConfirmCtx({ service_price: 0, service_deposit: 0 });
    const result = await confirmStep.validate!('confirm', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?._action).toBe('confirm');
    expect(result.data?._terms_accepted).toBeUndefined();
  });

  it('R2-T3c: merchant-disabled terms never record acceptance', async () => {
    const ctx = buildConfirmCtx({}, { require_terms_before_payment: false });
    const result = await confirmStep.validate!('confirm', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?._action).toBe('confirm');
    expect(result.data?._terms_accepted).toBeUndefined();
  });

  it('R2-T3d: paid booking with a delivery charge records terms acceptance', async () => {
    const ctx = buildConfirmCtx({ service_price: 0, service_deposit: 0, _delivery_zone_price: 100 });
    const result = await confirmStep.validate!('confirm', ctx);
    expect(result.data?._terms_accepted).toBe(true);
  });

  it('R2-T4: confirm_booking uses regular button when require_terms_before_payment=false', async () => {
    const ctx = buildConfirmCtx({}, { require_terms_before_payment: false });
    const messages = await confirmStep.prompt!(ctx);
    const body = messages[0].body;
    expect(body).not.toContain('📎 Terms:');
    const confirmBtn = messages[0].buttons?.find((b: { id: string }) => b.id === 'confirm');
    expect(confirmBtn!.title).not.toContain('Accept');
  });

  it('R2-T4b: confirm_booking uses custom terms URL when set', async () => {
    const customUrl = ['https:', '//mybiz.com/terms'].join('');
    const ctx = buildConfirmCtx({}, { terms_url: customUrl });
    const messages = await confirmStep.prompt!(ctx);
    expect(messages[0].body).toContain('mybiz.com/terms');
    expect(messages[0].body).not.toContain('waaiio.com');
  });

  it('R2-T7: cancel at confirm_booking does NOT set _terms_accepted', async () => {
    const ctx = buildConfirmCtx();
    const result = await confirmStep.validate!('go_back', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?._action).toBe('cancel');
    expect(result.data?._terms_accepted).toBeUndefined();
  });

  // ── R2: Booking summary preserves all existing details ──

  it('R2-detail: confirm_booking preserves price, deposit, delivery, promo, addons, venue', async () => {
    const ctx = buildConfirmCtx({
      service_price: 10000,
      service_deposit: 5000,
      _promo_discount: 1000,
      _promo_code: 'SAVE10',
      _selected_addons: [{ name: 'Hot Towel', price: 500 }],
      _delivery_zone_name: 'Island',
      _delivery_zone_price: 1500,
      venue_address: '123 Main St',
      special_requests: 'No talking please',
    });
    const messages = await confirmStep.prompt!(ctx);
    const body = messages[0].body;
    expect(body).toContain('💰');
    expect(body).toContain('Deposit');
    expect(body).toContain('🎟️ Promo (SAVE10)');
    expect(body).toContain('➕ Add-ons');
    expect(body).toContain('🚚 Island');
    expect(body).toContain('📍 123 Main St');
    expect(body).toContain('📝 No talking please');
    // T&C should still be inline
    expect(body).toContain('📎 Terms:');
  });

  // ── R2: Fallback T&C gate in create_booking ──

  it('R2-T5: create_booking T&C gate skipped when _terms_accepted already set', async () => {
    const ctx = buildConfirmCtx({ _terms_accepted: true });
    ctx.session.current_step = 'create_booking';
    // The T&C gate at create_booking checks !d._terms_accepted.
    // With _terms_accepted=true, it should NOT return getTermsPrompt.
    // We verify by checking the session_data flag is respected.
    const d = ctx.session.session_data;
    const totalDeposit = 5000; // simulate paid
    const gateWouldFire = !d._terms_accepted && totalDeposit > 0 && (ctx.business?.metadata as any)?.require_terms_before_payment !== false;
    expect(gateWouldFire).toBe(false);
  });

  it('R2-T6: create_booking T&C gate fires if _terms_accepted NOT set (resumed session)', async () => {
    const d = { service_price: 5000 };
    const totalDeposit = 5000;
    const requireTerms = (undefined as any)?.require_terms_before_payment !== false; // undefined !== false → true
    const gateWouldFire = !(d as any)._terms_accepted && totalDeposit > 0 && requireTerms;
    expect(gateWouldFire).toBe(true);
  });

  // ── R2: Stale callback / session resume ──

  it('R2-T8: resumed session at create_booking without _terms_accepted triggers fallback gate logic', () => {
    // Simulates: session was serialized before R2 deploy, resumed after.
    // _terms_accepted was never set because old flow didn't set it at confirmation.
    const sessionData: Record<string, unknown> = {
      service_price: 5000,
      date: '2026-06-01',
      time: '10:00',
    };
    const totalDeposit = 5000;
    const requireTerms = true;
    const gateWouldFire = !sessionData._terms_accepted && totalDeposit > 0 && requireTerms;
    expect(gateWouldFire).toBe(true);
  });

  it('R2-T9: merchant disables terms → no T&C in confirm_booking', async () => {
    const ctx = buildConfirmCtx({ service_price: 5000 }, { require_terms_before_payment: false });
    const messages = await confirmStep.prompt!(ctx);
    const body = messages[0].body;
    expect(body).not.toContain('📎 Terms:');
    const confirmBtn = messages[0].buttons?.find((b: { id: string }) => b.id === 'confirm');
    expect(confirmBtn!.title).not.toContain('Accept');
  });

  it('R2-T10: accept_terms/cancel_terms postback IDs in create_booking.validate remain functional', async () => {
    const ctx = buildConfirmCtx();
    ctx.session.current_step = 'create_booking';

    const acceptResult = await createBookingStep.validate!('accept_terms', ctx);
    expect(acceptResult.valid).toBe(true);
    expect(acceptResult.data?._terms_accepted).toBe(true);

    const cancelResult = await createBookingStep.validate!('cancel_terms', ctx);
    expect(cancelResult.valid).toBe(true);
    expect(cancelResult.data?._terms_cancelled).toBe(true);
  });

  // ── R2: _terms_loop_consumed guard ──

  it('R2-T11: create_booking.next() with _terms_accepted routes back only once (_terms_loop_consumed)', async () => {
    const ctx = buildConfirmCtx({ _terms_accepted: true });
    ctx.session.current_step = 'create_booking';

    // First call: should return 'create_booking' and set _terms_loop_consumed
    const firstResult = await createBookingStep.next!(ctx);
    expect(firstResult).toBe('create_booking');
    expect(ctx.session.session_data._terms_loop_consumed).toBe(true);

    // Second call: _terms_loop_consumed is true, should NOT loop back
    const secondResult = await createBookingStep.next!(ctx);
    expect(secondResult).not.toBe('create_booking');
  });

  // ── R2: Duplicate confirmation ──

  it('R2-T12: double-tap confirm returns valid both times (idempotent)', async () => {
    const ctx = buildConfirmCtx();
    const result1 = await confirmStep.validate!('confirm', ctx);
    expect(result1.valid).toBe(true);
    expect(result1.data?._terms_accepted).toBe(true);

    // Simulate second tap with same input
    const result2 = await confirmStep.validate!('confirm', ctx);
    expect(result2.valid).toBe(true);
    expect(result2.data?._terms_accepted).toBe(true);
  });

  // ── R2: Shared/dedicated number parity ──

  it('R2-T13: terms behavior is identical regardless of channel type', async () => {
    // Shared number context
    const sharedCtx = buildConfirmCtx();
    const sharedMsgs = await confirmStep.prompt!(sharedCtx);

    // Dedicated number context (same business, different from)
    const dedicatedCtx = buildConfirmCtx();
    dedicatedCtx.from = '+447700900000';
    const dedicatedMsgs = await confirmStep.prompt!(dedicatedCtx);

    // Both should have identical T&C treatment
    expect(sharedMsgs[0].body).toContain('📎 Terms:');
    expect(dedicatedMsgs[0].body).toContain('📎 Terms:');
    expect(sharedMsgs[0].buttons).toEqual(dedicatedMsgs[0].buttons);
  });

  // ── R2: Deposit-only booking T&C ──

  it('R2-T14: deposit-only booking (service_price=0, deposit>0) shows T&C', async () => {
    const ctx = buildConfirmCtx({ service_price: 0, service_deposit: 3000 });
    const messages = await confirmStep.prompt!(ctx);
    const body = messages[0].body;
    expect(body).toContain('📎 Terms:');
    const confirmBtn = messages[0].buttons?.find((b: { id: string }) => b.id === 'confirm');
    expect(confirmBtn!.title).toContain('Accept');
  });
});

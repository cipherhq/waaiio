/**
 * M378 Phase 1 — executable production-function tests
 *
 * Tests the ACTUAL production functions that POST handlers call:
 * - flutterwave-verify.ts: discoverAndVerifyTransaction, verifyTransactionById, toFlwDate
 * - flutterwave-signature.ts: verifyFlutterwaveSignature
 * - flutterwave-subscription.ts: correlateProviderSubscription, verifySubscriptionStatus
 * - flutterwave-decisions.ts: decideTimeoutRecovery, decideInitResponse, decideCancellation,
 *                              decideSubscriptionCorrelation, decideFinalizerResult
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), withContext: () => ({ error: vi.fn() }) } }));

import { discoverAndVerifyTransaction, verifyTransactionById, toFlwDate } from '../flutterwave-verify';
import { verifyFlutterwaveSignature } from '../flutterwave-signature';
import { correlateProviderSubscription, verifySubscriptionStatus } from '../flutterwave-subscription';
import { decideTimeoutRecovery, decideInitResponse, decideCancellation, decideSubscriptionCorrelation, decideFinalizerResult, decideChargeRouting } from '../flutterwave-decisions';

beforeEach(() => { mockFetch.mockReset(); });

// ═════ toFlwDate ═════
describe('toFlwDate', () => {
  it('Date → YYYY-MM-DD', () => expect(toFlwDate(new Date('2026-09-12T15:30:00Z'))).toBe('2026-09-12'));
  it('ISO → YYYY-MM-DD', () => expect(toFlwDate('2026-09-10T23:59:59.999Z')).toBe('2026-09-10'));
});

// ═════ discoverAndVerifyTransaction ═════
describe('discoverAndVerifyTransaction', () => {
  const ref = 'waaiiosub1234567890abcdef1234567890ab';
  it('requires fromDate — fails without it', async () => {
    const r = await discoverAndVerifyTransaction(ref, 'k');
    expect(r.ok).toBe(false);
  });
  it('normalizes ISO fromDate to YYYY-MM-DD', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ status: 'success', data: [] }) });
    await discoverAndVerifyTransaction(ref, 'k', { fromDate: '2026-09-10T15:30:00Z' });
    expect(decodeURIComponent((mockFetch.mock.calls[0][0] as string).match(/from=([^&]+)/)![1])).toBe('2026-09-10');
  });
  it('queries both successful+failed statuses', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ status: 'success', data: [] }) });
    await discoverAndVerifyTransaction(ref, 'k', { fromDate: '2026-09-10' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect((mockFetch.mock.calls[0][0] as string)).toContain('status=successful');
    expect((mockFetch.mock.calls[1][0] as string)).toContain('status=failed');
  });
  it('successful discovery + exact-ID verify', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 1, tx_ref: ref }] }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: { id: 1, tx_ref: ref, status: 'successful', amount: 14999, currency: 'NGN', created_at: '2026-09-12T00:00:00Z' } }) });
    const r = await discoverAndVerifyTransaction(ref, 'k', { fromDate: '2026-09-10' });
    expect(r.ok && r.tx.status).toBe('successful');
  });
  it('failed terminal via status=failed query', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 2, tx_ref: ref }] }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: { id: 2, tx_ref: ref, status: 'failed', amount: 14999, currency: 'NGN', created_at: '2026-09-12T00:00:00Z' } }) });
    const r = await discoverAndVerifyTransaction(ref, 'k', { fromDate: '2026-09-10' });
    expect(r.ok && r.tx.status).toBe('failed');
  });
  it('5xx → unavailable', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    expect((await discoverAndVerifyTransaction(ref, 'k', { fromDate: '2026-09-10' })).ok).toBe(false);
  });
  it('network → unavailable', async () => {
    mockFetch.mockRejectedValue(new Error('x'));
    expect((await discoverAndVerifyTransaction(ref, 'k', { fromDate: '2026-09-10' })).ok).toBe(false);
  });
});

// ═════ verifyTransactionById ═════
describe('verifyTransactionById', () => {
  it('match → ok', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: { id: 100, tx_ref: 'r', status: 'successful', amount: 100, currency: 'NGN', created_at: '2026-09-12T00:00:00Z' } }) });
    expect((await verifyTransactionById(100, 'r', 'k')).ok).toBe(true);
  });
  it('mismatch → fail', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: { id: 100, tx_ref: 'wrong', status: 'successful', amount: 100, currency: 'NGN', created_at: '2026-09-12T00:00:00Z' } }) });
    expect((await verifyTransactionById(100, 'expected', 'k')).ok).toBe(false);
  });
});

// ═════ verifyFlutterwaveSignature ═════
describe('verifyFlutterwaveSignature', () => {
  const s = 'secret12345'; const b = '{"data":1}';
  it('valid HMAC base64', () => expect(verifyFlutterwaveSignature(b, { flutterwaveSignature: createHmac('sha256', s).update(b).digest('base64') }, s)).toBe(true));
  it('invalid HMAC', () => expect(verifyFlutterwaveSignature(b, { flutterwaveSignature: 'wrong' }, s)).toBe(false));
  it('hex rejected', () => expect(verifyFlutterwaveSignature(b, { flutterwaveSignature: createHmac('sha256', s).update(b).digest('hex') }, s)).toBe(false));
  it('legacy ok', () => expect(verifyFlutterwaveSignature(b, { verifHash: s }, s)).toBe(true));
  it('legacy bad', () => expect(verifyFlutterwaveSignature(b, { verifHash: 'x' }, s)).toBe(false));
  it('none', () => expect(verifyFlutterwaveSignature(b, {}, s)).toBe(false));
});

// ═════ correlateProviderSubscription ═════
describe('correlateProviderSubscription', () => {
  it('one valid → ok', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 123, plan: 456 }] }) });
    const r = await correlateProviderSubscription(100, 'k');
    expect(r.ok && r.sub.subscriptionId).toBe('123');
  });
  it('zero → not_found', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) });
    expect((await correlateProviderSubscription(100, 'k')).ok).toBe(false);
  });
  it('multiple → ambiguous', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 1, plan: 1 }, { id: 2, plan: 2 }] }) });
    expect((await correlateProviderSubscription(100, 'k')).ok).toBe(false);
  });
  it('HTTP 5xx → unavailable', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    expect((await correlateProviderSubscription(100, 'k')).ok).toBe(false);
  });
  it('zero planId → invalid', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 1, plan: 0 }] }) });
    expect((await correlateProviderSubscription(100, 'k')).ok).toBe(false);
  });
});

// ═════ verifySubscriptionStatus (documented list with explicit status filters) ═════
describe('verifySubscriptionStatus', () => {
  it('found as cancelled → returns cancelled', async () => {
    // Step 1: query status=cancelled finds the subscription
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 42, status: 'cancelled' }] }) });
    const r = await verifySubscriptionStatus('42', 'user@test.com', 'k');
    expect(r.ok && r.status).toBe('cancelled');
    // Only one call needed — found in cancelled query
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('not cancelled but found as active → returns active', async () => {
    // Step 1: cancelled query returns empty
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) });
    // Step 2: active query finds it
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 42, status: 'active' }] }) });
    const r = await verifySubscriptionStatus('42', 'user@test.com', 'k');
    expect(r.ok && r.status).toBe('active');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('not found in either status → not_found', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) });
    const r = await verifySubscriptionStatus('42', 'user@test.com', 'k');
    expect(!r.ok && r.reason).toBe('not_found');
  });

  it('unavailable → fail closed', async () => {
    mockFetch.mockRejectedValueOnce(new Error('t'));
    expect((await verifySubscriptionStatus('42', 'u@t.com', 'k')).ok).toBe(false);
  });

  it('URL contains explicit status=cancelled filter', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 42, status: 'cancelled' }] }) });
    await verifySubscriptionStatus('42', 'user@test.com', 'k');
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('status=cancelled');
    expect(url).toContain('email=user%40test.com');
  });

  it('URL contains explicit status=active filter when checking active', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) }); // cancelled: empty
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 42, status: 'active' }] }) });
    await verifySubscriptionStatus('42', 'user@test.com', 'k');
    const url2 = mockFetch.mock.calls[1][0] as string;
    expect(url2).toContain('status=active');
  });

  it('exact ID match only — different ID in results ignored', async () => {
    // Cancelled query returns a different subscription ID
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 99, status: 'cancelled' }] }) });
    // Active query returns a different ID too
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 88, status: 'active' }] }) });
    const r = await verifySubscriptionStatus('42', 'user@test.com', 'k');
    expect(!r.ok && r.reason).toBe('not_found');
  });
});

// ═════ DECISION FUNCTIONS — actual route logic ═════

describe('decideTimeoutRecovery', () => {
  it('successful → finalize original', () => {
    const r = decideTimeoutRecovery({ ok: true, tx: { id: 1, tx_ref: 'r', status: 'successful', amount: 100, currency: 'NGN', created_at: '2026-09-12T00:00:00Z' } });
    expect(r.action).toBe('finalize');
  });
  it('failed → replace', () => {
    const r = decideTimeoutRecovery({ ok: true, tx: { id: 1, tx_ref: 'r', status: 'failed', amount: 100, currency: 'NGN', created_at: '2026-09-12T00:00:00Z' } });
    expect(r.action).toBe('replace');
  });
  it('pending → retain', () => {
    const r = decideTimeoutRecovery({ ok: true, tx: { id: 1, tx_ref: 'r', status: 'pending', amount: 100, currency: 'NGN', created_at: '2026-09-12T00:00:00Z' } });
    expect(r.action).toBe('retain');
  });
  it('unavailable → fail_closed', () => {
    expect(decideTimeoutRecovery({ ok: false, reason: 'unavailable' }).action).toBe('fail_closed');
  });
});

describe('decideInitResponse', () => {
  it('success → success', () => expect(decideInitResponse(200, true).action).toBe('success'));
  it('4xx → mark_failed', () => expect(decideInitResponse(422, false).action).toBe('mark_failed'));
  it('5xx → retain_key', () => expect(decideInitResponse(500, false).action).toBe('retain_key'));
  it('network (0) → retain_key', () => expect(decideInitResponse(0, false).action).toBe('retain_key'));
});

describe('decideCancellation', () => {
  it('first cancellation: provider=cancelled → cancel', () => {
    expect(decideCancellation('active', true, { ok: true, status: 'cancelled' }).action).toBe('cancel');
  });
  it('duplicate before reactivation: local=cancelled → already_cancelled', () => {
    expect(decideCancellation('cancelled', true, null).action).toBe('already_cancelled');
  });
  it('cancel→reactivate→new cancel: provider=cancelled → cancel', () => {
    expect(decideCancellation('active', true, { ok: true, status: 'cancelled' }).action).toBe('cancel');
  });
  it('delayed OLD cancellation after reactivation: provider=active → stale_duplicate', () => {
    expect(decideCancellation('active', true, { ok: true, status: 'active' }).action).toBe('stale_duplicate');
  });
  it('missing subscription ID → fail_closed', () => {
    expect(decideCancellation('active', false, null).action).toBe('fail_closed');
  });
  it('provider unavailable → fail_closed', () => {
    expect(decideCancellation('active', true, { ok: false, reason: 'unavailable' }).action).toBe('fail_closed');
  });
});

describe('decideSubscriptionCorrelation', () => {
  it('ok → proceed', () => {
    expect(decideSubscriptionCorrelation({ ok: true, sub: { subscriptionId: '1', planId: 2 } }).action).toBe('proceed');
  });
  it('not_found → fail_closed', () => {
    expect(decideSubscriptionCorrelation({ ok: false, reason: 'not_found' }).action).toBe('fail_closed');
  });
  it('ambiguous → fail_closed', () => {
    expect(decideSubscriptionCorrelation({ ok: false, reason: 'ambiguous' }).action).toBe('fail_closed');
  });
});

describe('decideFinalizerResult', () => {
  it('finalized=true → success', () => expect(decideFinalizerResult({ finalized: true }, null).action).toBe('success'));
  it('null result → failed', () => expect(decideFinalizerResult(null, null).action).toBe('failed'));
  it('quarantine → quarantined', () => expect(decideFinalizerResult({ finalized: false, quarantine: true }, null).action).toBe('quarantined'));
  it('error → failed', () => expect(decideFinalizerResult(null, new Error('x')).action).toBe('failed'));
});

// ═════ Charge routing — production function (Blocker C) ═════
describe('decideChargeRouting — executable business-payment non-regression', () => {
  it('waaiiosub prefix with intent match → platform_initial', () => {
    const r = decideChargeRouting('waaiiosubabcdef1234567890abcdef12', true, 'not_subscription');
    expect(r.route).toBe('platform_initial');
  });

  it('waaiiosub prefix without intent match → business_payment (no intent = not ours)', () => {
    const r = decideChargeRouting('waaiiosubabcdef1234567890abcdef12', false, 'not_subscription');
    expect(r.route).toBe('business_payment');
  });

  it('non-waaiiosub + renewal matched → platform_renewal', () => {
    const r = decideChargeRouting('flw_charge_abc123', false, 'matched');
    expect(r.route).toBe('platform_renewal');
  });

  it('non-waaiiosub + renewal unavailable → unknown (fail closed, NOT business_payment)', () => {
    const r = decideChargeRouting('flw_charge_abc123', false, 'unavailable');
    expect(r.route).toBe('unknown');
  });

  it('non-waaiiosub + renewal ambiguous → unknown (fail closed)', () => {
    const r = decideChargeRouting('flw_charge_abc123', false, 'ambiguous');
    expect(r.route).toBe('unknown');
  });

  it('non-waaiiosub + not_subscription → business_payment (ordinary charge)', () => {
    const r = decideChargeRouting('flw_charge_abc123', false, 'not_subscription');
    expect(r.route).toBe('business_payment');
    expect(r.route).toBe('business_payment'); // NOT swallowed by subscription routing
  });

  it('ordinary business tx_ref reaches business_payment path', () => {
    // This proves a normal non-platform charge goes to the existing reconciliation path
    const r = decideChargeRouting('flw_1234567890abcdef', false, 'not_subscription');
    expect(r.route).toBe('business_payment');
    expect(r).toHaveProperty('txRef', 'flw_1234567890abcdef');
  });
});

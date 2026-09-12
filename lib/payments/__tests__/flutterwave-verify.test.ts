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
import { correlateProviderSubscription, correlateProviderSubscriptionExhaustive, querySubscriptionsByTxId, verifySubscriptionStatus, findSubscriptionByStatus } from '../flutterwave-subscription';
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
    // Cancelled: empty (exhausted)
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) });
    // Active: found on page 1
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 42, status: 'active' }] }) });
    const r = await verifySubscriptionStatus('42', 'user@test.com', 'k');
    expect(r.ok && r.status).toBe('active');
  });

  it('not found in either status (both empty) → not_found', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) }); // cancelled: empty
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) }); // active: empty
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
    // Cancelled: one non-matching result, then empty (exhausted)
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 99, status: 'cancelled' }] }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) }); // cancelled exhausted
    // Active: one non-matching result, then empty (exhausted)
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 88, status: 'active' }] }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) }); // active exhausted
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

// ═════ findSubscriptionByStatus — paginated lookup ═════
describe('findSubscriptionByStatus — pagination', () => {
  it('found on page 1', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 42, status: 'cancelled' }] }) });
    const r = await findSubscriptionByStatus('42', 'u@t.com', 'cancelled', 'k');
    expect(r.ok && r.found).toBe(true);
    expect((mockFetch.mock.calls[0][0] as string)).toContain('status=cancelled&page=1');
  });

  it('found on later page (page 3)', async () => {
    // Pages 1-2: non-matching results (no page-size heuristic — continues)
    for (let i = 0; i < 2; i++) {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: i + 1, status: 'cancelled' }] }) });
    }
    // Page 3: target found
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 42, status: 'cancelled' }] }) });
    const r = await findSubscriptionByStatus('42', 'u@t.com', 'cancelled', 'k');
    expect(r.ok && r.found).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect((mockFetch.mock.calls[2][0] as string)).toContain('page=3');
  });

  it('empty page = exhausted → not found', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) });
    const r = await findSubscriptionByStatus('42', 'u@t.com', 'cancelled', 'k');
    expect(r.ok && !r.found).toBe(true);
  });

  it('safety cap reached → fail closed (unavailable, NOT not_found)', async () => {
    // Every page returns non-matching results
    for (let i = 0; i < 3; i++) {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: i + 100, status: 'cancelled' }] }) });
    }
    const r = await findSubscriptionByStatus('42', 'u@t.com', 'cancelled', 'k', { maxPages: 3 });
    // Cap hit → fail closed, NOT { found: false }
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unavailable');
  });

  it('provider error → fail closed', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const r = await findSubscriptionByStatus('42', 'u@t.com', 'cancelled', 'k');
    expect(r.ok).toBe(false);
  });

  it('includes plan filter when provided', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) });
    await findSubscriptionByStatus('42', 'u@t.com', 'cancelled', 'k', { planId: 999 });
    expect((mockFetch.mock.calls[0][0] as string)).toContain('plan=999');
  });
});

// ═════ decideChargeRouting — wired into actual POST webhook ═════
describe('decideChargeRouting — production routing authority', () => {
  it('waaiiosub + intent match → platform_initial', () => {
    expect(decideChargeRouting('waaiiosubtest123', 100, true, 'not_subscription').route).toBe('platform_initial');
  });
  it('waaiiosub WITHOUT intent → unknown (NEVER business_payment)', () => {
    const r = decideChargeRouting('waaiiosubtest123', 100, false, 'not_subscription');
    expect(r.route).toBe('unknown');
    if (r.route === 'unknown') expect(r.reason).toBe('waaiiosub_without_intent');
  });
  it('non-waaiiosub + matched + local sub → platform_renewal with real txId', () => {
    const r = decideChargeRouting('flw_abc', 12345, false, 'matched', 'sub-uuid');
    expect(r.route).toBe('platform_renewal');
    if (r.route === 'platform_renewal') expect(r.txId).toBe(12345);
  });
  it('non-waaiiosub + matched WITHOUT local sub → unknown (orphaned)', () => {
    const r = decideChargeRouting('flw_abc', 100, false, 'matched');
    expect(r.route).toBe('unknown');
    if (r.route === 'unknown') expect(r.reason).toBe('provider_match_without_local_subscription');
  });
  it('non-waaiiosub + unavailable → unknown (fail closed)', () => {
    expect(decideChargeRouting('flw_abc', 100, false, 'unavailable').route).toBe('unknown');
  });
  it('non-waaiiosub + ambiguous → unknown (fail closed)', () => {
    expect(decideChargeRouting('flw_abc', 100, false, 'ambiguous').route).toBe('unknown');
  });
  it('non-waaiiosub + not_subscription → business_payment (zero-subscription proof)', () => {
    const r = decideChargeRouting('flw_biz_charge_123', 100, false, 'not_subscription');
    expect(r.route).toBe('business_payment');
    if (r.route === 'business_payment') expect(r.txRef).toBe('flw_biz_charge_123');
  });
  it('missing provider txId → unknown (fail closed)', () => {
    const r = decideChargeRouting('flw_abc', 0, false, 'not_checked');
    expect(r.route).toBe('unknown');
  });
  it('subscription lookup not performed → unknown (fail closed)', () => {
    const r = decideChargeRouting('flw_abc', 100, false, 'not_checked');
    expect(r.route).toBe('unknown');
  });
});

// ═════ querySubscriptionsByTxId — explicit status filter ═════
describe('querySubscriptionsByTxId', () => {
  it('explicit status=active in URL', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) });
    await querySubscriptionsByTxId(100, 'active', 'k');
    expect((mockFetch.mock.calls[0][0] as string)).toContain('status=active');
    expect((mockFetch.mock.calls[0][0] as string)).toContain('transaction_id=100');
  });
  it('explicit status=cancelled in URL', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) });
    await querySubscriptionsByTxId(100, 'cancelled', 'k');
    expect((mockFetch.mock.calls[0][0] as string)).toContain('status=cancelled');
  });
  it('returns subs on success', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 1, plan: 2 }] }) });
    const r = await querySubscriptionsByTxId(100, 'active', 'k');
    expect(r.ok && r.subs).toEqual([{ id: 1, plan: 2 }]);
  });
  it('HTTP error → unavailable', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    expect((await querySubscriptionsByTxId(100, 'active', 'k')).ok).toBe(false);
  });
  it('network error → unavailable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('net'));
    expect((await querySubscriptionsByTxId(100, 'active', 'k')).ok).toBe(false);
  });
});

// ═════ correlateProviderSubscriptionExhaustive — dual-query ═════
describe('correlateProviderSubscriptionExhaustive — dual-query classification', () => {
  it('active-only match → subscription', async () => {
    // active: one sub; cancelled: zero
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 10, plan: 20 }] }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) });
    const r = await correlateProviderSubscriptionExhaustive(100, 'k');
    expect(r.ok && r.sub.subscriptionId).toBe('10');
    // Verify both queries were made with explicit status params
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect((mockFetch.mock.calls[0][0] as string)).toContain('status=active');
    expect((mockFetch.mock.calls[1][0] as string)).toContain('status=cancelled');
  });

  it('cancelled-only match → subscription', async () => {
    // active: zero; cancelled: one sub
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 30, plan: 40 }] }) });
    const r = await correlateProviderSubscriptionExhaustive(100, 'k');
    expect(r.ok && r.sub.subscriptionId).toBe('30');
  });

  it('zero across both active AND cancelled → not_found (not_subscription)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) });
    const r = await correlateProviderSubscriptionExhaustive(100, 'k');
    expect(!r.ok && r.reason).toBe('not_found');
  });

  it('same identity in both queries → deduped to one subscription', async () => {
    // Same sub appears in both active and cancelled (edge case)
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 50, plan: 60 }] }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 50, plan: 60 }] }) });
    const r = await correlateProviderSubscriptionExhaustive(100, 'k');
    expect(r.ok && r.sub.subscriptionId).toBe('50');
    expect(r.ok && r.sub.planId).toBe(60);
  });

  it('different identities across queries → ambiguous (fail closed)', async () => {
    // active: sub A; cancelled: sub B — conflicting identities
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 70, plan: 80 }] }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 90, plan: 100 }] }) });
    const r = await correlateProviderSubscriptionExhaustive(100, 'k');
    expect(!r.ok && r.reason).toBe('ambiguous');
  });

  it('active query error → fail closed (unavailable)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 }); // active fails
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 1, plan: 2 }] }) });
    const r = await correlateProviderSubscriptionExhaustive(100, 'k');
    expect(!r.ok && r.reason).toBe('unavailable');
  });

  it('cancelled query error → fail closed (unavailable)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) }); // active ok
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 }); // cancelled fails
    const r = await correlateProviderSubscriptionExhaustive(100, 'k');
    expect(!r.ok && r.reason).toBe('unavailable');
  });

  it('both queries error → fail closed (unavailable)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    const r = await correlateProviderSubscriptionExhaustive(100, 'k');
    expect(!r.ok && r.reason).toBe('unavailable');
  });

  it('ambiguity within active query → fail closed', async () => {
    // active: multiple subs; cancelled: zero
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 1, plan: 2 }, { id: 3, plan: 4 }] }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) });
    const r = await correlateProviderSubscriptionExhaustive(100, 'k');
    expect(!r.ok && r.reason).toBe('ambiguous');
  });

  it('ambiguity within cancelled query → fail closed', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 5, plan: 6 }, { id: 7, plan: 8 }] }) });
    const r = await correlateProviderSubscriptionExhaustive(100, 'k');
    expect(!r.ok && r.reason).toBe('ambiguous');
  });

  it('invalid identity (zero plan) in active → fail closed', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 1, plan: 0 }] }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) });
    const r = await correlateProviderSubscriptionExhaustive(100, 'k');
    expect(!r.ok && r.reason).toBe('invalid');
  });

  it('invalid identity (zero id) in cancelled → fail closed', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [{ id: 0, plan: 5 }] }) });
    const r = await correlateProviderSubscriptionExhaustive(100, 'k');
    expect(!r.ok && r.reason).toBe('invalid');
  });

  it('both queries fire with explicit status params (never default)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: [] }) });
    await correlateProviderSubscriptionExhaustive(999, 'k');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const url0 = mockFetch.mock.calls[0][0] as string;
    const url1 = mockFetch.mock.calls[1][0] as string;
    // Both must have explicit status — one active, one cancelled (order from Promise.all)
    const statuses = [url0.match(/status=(\w+)/)?.[1], url1.match(/status=(\w+)/)?.[1]].sort();
    expect(statuses).toEqual(['active', 'cancelled']);
  });
});

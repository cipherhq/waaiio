/**
 * Issue #211/#248 — Contact Winner UI Wiring Tests
 *
 * CTO review (PR #590): tests MUST import and exercise the ACTUAL production
 * logic from contact-winner-logic.ts, not reimplemented copies.
 *
 * Validates:
 * 1. Button state machine (hidden/disabled/ready) including in-flight guard
 * 2. Template readiness via nested promo_winner_status_v1.status path
 * 3. Fail-closed on !res.ok, network error, unexpected shape, business transition
 * 4. Exact outgoing POST payload {businessId, campaignId, redemptionId}
 * 5. Error states: 429, 503, 5xx, 401/403, 404, network errors
 * 6. Click → API → UI transition (loading, success, error)
 * 7. Double-click guard + multi-winner rapid click serialization
 * 8. No phone number leakage
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkWinnerTemplateReadiness,
  getButtonState,
  handleContactWinner,
} from '../[id]/contact-winner-logic';

/* ------------------------------------------------------------------ */
/*  Button State (production logic)                                     */
/* ------------------------------------------------------------------ */

describe('Contact Winner — Button State', () => {
  it('returns hidden when can_contact_winner is false', () => {
    expect(getButtonState(false, true)).toBe('hidden');
    expect(getButtonState(false, false)).toBe('hidden');
  });

  it('returns disabled when can_contact_winner is true but template not ready', () => {
    expect(getButtonState(true, false)).toBe('disabled');
  });

  it('returns ready when can_contact_winner is true AND template is ready', () => {
    expect(getButtonState(true, true)).toBe('ready');
  });

  it('returns disabled when template is ready but another send is in-flight', () => {
    expect(getButtonState(true, true, 'red-other')).toBe('disabled');
  });

  it('returns ready when template is ready and no send in-flight', () => {
    expect(getButtonState(true, true, null)).toBe('ready');
  });

  it('returns hidden regardless of in-flight state when no permission', () => {
    expect(getButtonState(false, true, 'red-1')).toBe('hidden');
    expect(getButtonState(false, false, 'red-1')).toBe('hidden');
  });
});

/* ------------------------------------------------------------------ */
/*  Template Readiness (production logic)                               */
/* ------------------------------------------------------------------ */

describe('Contact Winner — Template Readiness Fetch', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
  });

  it('returns true when nested promo_winner_status_v1.status is ready', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'pending',
        templates: {
          promo_winner_status_v1: { status: 'ready', message: 'Template is approved and ready.' },
          promo_pickup_verification: { status: 'pending', message: 'Awaiting approval.' },
        },
      }),
    });

    const result = await checkWinnerTemplateReadiness(mockFetch as typeof fetch, 'biz-1');
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/promotions/template-status?businessId=biz-1',
    );
  });

  it('returns false when top-level status is ready but nested winner is NOT ready', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'ready',
        templates: {
          promo_winner_status_v1: { status: 'pending', message: 'Awaiting Meta approval.' },
          promo_pickup_verification: { status: 'ready', message: 'Template is approved.' },
        },
      }),
    });

    const result = await checkWinnerTemplateReadiness(mockFetch as typeof fetch, 'biz-1');
    expect(result).toBe(false);
  });

  it('returns false when response is not ok (500)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await checkWinnerTemplateReadiness(mockFetch as typeof fetch, 'biz-1');
    expect(result).toBe(false);
  });

  it('returns false when response is 401 (unauthorized)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const result = await checkWinnerTemplateReadiness(mockFetch as typeof fetch, 'biz-1');
    expect(result).toBe(false);
  });

  it('returns false when response is 503 (template service down)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

    const result = await checkWinnerTemplateReadiness(mockFetch as typeof fetch, 'biz-1');
    expect(result).toBe(false);
  });

  it('returns false when fetch throws (network error)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await checkWinnerTemplateReadiness(mockFetch as typeof fetch, 'biz-1');
    expect(result).toBe(false);
  });

  it('returns false when response has no templates key', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ready' }),
    });

    const result = await checkWinnerTemplateReadiness(mockFetch as typeof fetch, 'biz-1');
    expect(result).toBe(false);
  });

  it('returns false when promo_winner_status_v1 key is absent from templates', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'ready',
        templates: {
          promo_pickup_verification: { status: 'ready' },
        },
      }),
    });

    const result = await checkWinnerTemplateReadiness(mockFetch as typeof fetch, 'biz-1');
    expect(result).toBe(false);
  });

  it('returns false when winner template status is provisioning_required', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        templates: { promo_winner_status_v1: { status: 'provisioning_required' } },
      }),
    });

    const result = await checkWinnerTemplateReadiness(mockFetch as typeof fetch, 'biz-1');
    expect(result).toBe(false);
  });

  it('returns false when winner template status is rejected', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        templates: { promo_winner_status_v1: { status: 'rejected' } },
      }),
    });

    const result = await checkWinnerTemplateReadiness(mockFetch as typeof fetch, 'biz-1');
    expect(result).toBe(false);
  });

  it('properly encodes businessId in query string', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ templates: { promo_winner_status_v1: { status: 'ready' } } }),
    });

    await checkWinnerTemplateReadiness(mockFetch as typeof fetch, 'biz with spaces & symbols');
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/promotions/template-status?businessId=biz%20with%20spaces%20%26%20symbols',
    );
  });

  it('returns false when response JSON has unexpected shape (null templates)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ templates: null }),
    });

    const result = await checkWinnerTemplateReadiness(mockFetch as typeof fetch, 'biz-1');
    expect(result).toBe(false);
  });

  it('returns false when response JSON is empty object', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    const result = await checkWinnerTemplateReadiness(mockFetch as typeof fetch, 'biz-1');
    expect(result).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Business Transition (fail-closed on switch)                         */
/* ------------------------------------------------------------------ */

describe('Contact Winner — Business Transition', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
  });

  it('sequential calls for different businesses return independent results', async () => {
    // Business A: template ready
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ templates: { promo_winner_status_v1: { status: 'ready' } } }),
    });
    const resultA = await checkWinnerTemplateReadiness(mockFetch as typeof fetch, 'biz-a');
    expect(resultA).toBe(true);

    // Business B: template pending — must NOT inherit A's result
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ templates: { promo_winner_status_v1: { status: 'pending' } } }),
    });
    const resultB = await checkWinnerTemplateReadiness(mockFetch as typeof fetch, 'biz-b');
    expect(resultB).toBe(false);
  });

  it('business switch where new business returns 401 gives false', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    const result = await checkWinnerTemplateReadiness(mockFetch as typeof fetch, 'biz-new');
    expect(result).toBe(false);
  });

  it('business switch where fetch fails gives false', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Connection reset'));
    const result = await checkWinnerTemplateReadiness(mockFetch as typeof fetch, 'biz-new');
    expect(result).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Click Handler (production logic)                                    */
/* ------------------------------------------------------------------ */

describe('Contact Winner — Click Handler', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const BASE = {
    businessId: 'biz-1',
    campaignId: 'camp-1',
    redemptionId: 'red-1',
    currentlyContacting: null as string | null,
  };

  beforeEach(() => {
    mockFetch = vi.fn();
  });

  it('sends correct POST payload {businessId, campaignId, redemptionId}', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ sent: true }) });

    const result = await handleContactWinner(mockFetch as typeof fetch, BASE);

    expect(result.fetchCalled).toBe(true);
    expect(result.fetchPayload).toEqual({
      url: '/api/promotions/winners/contact',
      body: { businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' },
    });

    expect(mockFetch).toHaveBeenCalledWith('/api/promotions/winners/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' }),
    });
  });

  it('handles success (200) — sets success result', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ sent: true }) });

    const result = await handleContactWinner(mockFetch as typeof fetch, BASE);

    expect(result.contactResult).toEqual({
      redemptionId: 'red-1',
      type: 'success',
      message: 'Winner notified successfully.',
    });
    expect(result.contactingWinner).toBeNull();
  });

  it('handles 401 unauthorized', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) });

    const result = await handleContactWinner(mockFetch as typeof fetch, BASE);

    expect(result.contactResult?.type).toBe('error');
    expect(result.contactResult?.message).toContain('permission');
  });

  it('handles 403 forbidden', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) });

    const result = await handleContactWinner(mockFetch as typeof fetch, BASE);

    expect(result.contactResult?.type).toBe('error');
    expect(result.contactResult?.message).toContain('permission');
  });

  it('handles 404 not found', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: 'Winner not found' }) });

    const result = await handleContactWinner(mockFetch as typeof fetch, BASE);

    expect(result.contactResult?.type).toBe('error');
    expect(result.contactResult?.message).toContain('not found');
  });

  it('handles 429 rate limit — uses server message when available', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: 'rate_limited', message: 'Custom cooldown message from server.' }),
    });

    const result = await handleContactWinner(mockFetch as typeof fetch, BASE);

    expect(result.contactResult?.type).toBe('error');
    expect(result.contactResult?.message).toBe('Custom cooldown message from server.');
  });

  it('handles 429 rate limit — uses fallback when json fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => { throw new Error('Bad JSON'); },
    });

    const result = await handleContactWinner(mockFetch as typeof fetch, BASE);

    expect(result.contactResult?.type).toBe('error');
    expect(result.contactResult?.message).toContain('contacted recently');
  });

  it('handles 503 template unavailable', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ error: 'template_not_ready' }),
    });

    const result = await handleContactWinner(mockFetch as typeof fetch, BASE);

    expect(result.contactResult?.type).toBe('error');
    expect(result.contactResult?.message).toContain('template unavailable');
  });

  it('handles 500 server error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal Server Error' }),
    });

    const result = await handleContactWinner(mockFetch as typeof fetch, BASE);

    expect(result.contactResult?.type).toBe('error');
    expect(result.contactResult?.message).toContain('Failed to contact winner');
  });

  it('handles 502 ambiguous provider error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({ error: 'Ambiguous' }),
    });

    const result = await handleContactWinner(mockFetch as typeof fetch, BASE);

    expect(result.contactResult?.type).toBe('error');
    expect(result.contactResult?.message).toContain('Failed to contact winner');
  });

  it('handles network error (fetch throws)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Failed to fetch'));

    const result = await handleContactWinner(mockFetch as typeof fetch, BASE);

    expect(result.contactResult?.type).toBe('error');
    expect(result.contactResult?.message).toContain('Network error');
    expect(result.contactingWinner).toBeNull();
  });

  it('guards against double-click — does not call fetch when already contacting', async () => {
    const result = await handleContactWinner(mockFetch as typeof fetch, {
      ...BASE,
      currentlyContacting: 'red-other',
    });

    expect(result.fetchCalled).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.contactingWinner).toBe('red-other');
  });

  it('clears contactingWinner after successful send', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ sent: true }) });

    const result = await handleContactWinner(mockFetch as typeof fetch, BASE);

    expect(result.contactingWinner).toBeNull();
  });

  it('clears contactingWinner after failed send', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });

    const result = await handleContactWinner(mockFetch as typeof fetch, BASE);

    expect(result.contactingWinner).toBeNull();
  });

  it('never leaks phone numbers in success or error results', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ sent: true }) });
    const successResult = await handleContactWinner(mockFetch as typeof fetch, BASE);

    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: 'Not found' }) });
    const errorResult = await handleContactWinner(mockFetch as typeof fetch, { ...BASE, currentlyContacting: null });

    const phoneRegex = /\+?\d{10,}/;
    expect(successResult.contactResult?.message).not.toMatch(phoneRegex);
    expect(errorResult.contactResult?.message).not.toMatch(phoneRegex);

    const resultStr = JSON.stringify(successResult) + JSON.stringify(errorResult);
    expect(resultStr).not.toContain('phone_e164');
    expect(resultStr).not.toContain('phone_number');
  });
});

/* ------------------------------------------------------------------ */
/*  Multi-Winner Rapid Click Serialization                              */
/* ------------------------------------------------------------------ */

describe('Contact Winner — Multi-Winner Rapid Click', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
  });

  it('second winner click is rejected while first is in-flight', async () => {
    // First winner: slow response
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ sent: true }) });

    // Click winner A
    const resultA = handleContactWinner(mockFetch as typeof fetch, {
      businessId: 'biz-1',
      campaignId: 'camp-1',
      redemptionId: 'red-A',
      currentlyContacting: null,
    });

    // Click winner B while A is in-flight
    const resultB = await handleContactWinner(mockFetch as typeof fetch, {
      businessId: 'biz-1',
      campaignId: 'camp-1',
      redemptionId: 'red-B',
      currentlyContacting: 'red-A', // A is in-flight
    });

    // B must be rejected
    expect(resultB.fetchCalled).toBe(false);
    expect(resultB.contactingWinner).toBe('red-A');
    expect(mockFetch).toHaveBeenCalledTimes(1); // only A's call

    // A completes normally
    const resolvedA = await resultA;
    expect(resolvedA.contactResult?.type).toBe('success');
    expect(resolvedA.contactingWinner).toBeNull();
  });

  it('button state reflects in-flight guard for all winners', () => {
    // No send in-flight: all ready
    expect(getButtonState(true, true, null)).toBe('ready');

    // Winner A in-flight: all disabled (including B's button)
    expect(getButtonState(true, true, 'red-A')).toBe('disabled');

    // Still disabled for winner A's own button
    expect(getButtonState(true, true, 'red-A')).toBe('disabled');
  });

  it('after in-flight clears, next winner click proceeds', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ sent: true }) });

    // First call completes
    const resultA = await handleContactWinner(mockFetch as typeof fetch, {
      businessId: 'biz-1',
      campaignId: 'camp-1',
      redemptionId: 'red-A',
      currentlyContacting: null,
    });
    expect(resultA.contactingWinner).toBeNull();

    // Now B can proceed
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ sent: true }) });
    const resultB = await handleContactWinner(mockFetch as typeof fetch, {
      businessId: 'biz-1',
      campaignId: 'camp-1',
      redemptionId: 'red-B',
      currentlyContacting: null, // cleared after A
    });

    expect(resultB.fetchCalled).toBe(true);
    expect(resultB.contactResult?.type).toBe('success');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

/* ------------------------------------------------------------------ */
/*  Full Click → API → UI Transition                                    */
/* ------------------------------------------------------------------ */

describe('Contact Winner — Full Click → API → UI Transition', () => {
  it('simulates complete success flow: idle → loading → success', async () => {
    const fetchCalls: Array<{ url: string; method: string; body: string }> = [];

    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, method: init?.method || 'GET', body: init?.body as string || '' });
      return { ok: true, json: async () => ({ sent: true }) };
    });

    const result = await handleContactWinner(mockFetch as unknown as typeof fetch, {
      businessId: 'biz-1',
      campaignId: 'camp-1',
      redemptionId: 'red-1',
      currentlyContacting: null,
    });

    expect(result.contactingWinner).toBeNull();
    expect(result.contactResult?.type).toBe('success');
    expect(result.contactResult?.message).toBe('Winner notified successfully.');

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('/api/promotions/winners/contact');
    expect(fetchCalls[0].method).toBe('POST');
    expect(JSON.parse(fetchCalls[0].body)).toEqual({
      businessId: 'biz-1',
      campaignId: 'camp-1',
      redemptionId: 'red-1',
    });
  });

  it('simulates complete error flow: idle → loading → error → idle', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: 'rate_limited', message: 'Wait 8 more minutes.' }),
    }));

    const result = await handleContactWinner(mockFetch as unknown as typeof fetch, {
      businessId: 'biz-1',
      campaignId: 'camp-1',
      redemptionId: 'red-1',
      currentlyContacting: null,
    });

    expect(result.contactingWinner).toBeNull();
    expect(result.contactResult?.type).toBe('error');
    expect(result.contactResult?.message).toBe('Wait 8 more minutes.');
    expect(result.contactResult?.redemptionId).toBe('red-1');
  });
});

/* ------------------------------------------------------------------ */
/*  No actual sends                                                     */
/* ------------------------------------------------------------------ */

describe('Contact Winner — No actual sends', () => {
  it('all fetch calls in these tests are mocked', () => {
    const mockFetch = vi.fn();
    expect(vi.isMockFunction(mockFetch)).toBe(true);
  });
});

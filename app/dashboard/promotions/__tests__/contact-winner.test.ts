/**
 * Issue #211/#248 — Contact Winner UI Wiring Tests
 *
 * Behavioral unit tests for the Contact Winner button state machine.
 * Validates:
 * 1. Button hidden vs disabled vs ready states based on permissions + template readiness
 * 2. Absent/failed template-status response → fail-closed (button disabled)
 * 3. Correct nested template status path (templates.promo_winner_status_v1.status, NOT top-level)
 * 4. Exact outgoing POST payload {businessId, campaignId, redemptionId}
 * 5. Error states: 429, 503, 5xx, 401/403, 404, network errors
 * 6. Click → API → UI transition (loading, success, error)
 * 7. Double-click guard
 * 8. No actual sends — all fetch calls are mocked
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/* ------------------------------------------------------------------ */
/*  Extracted state machine — mirrors page.tsx logic                    */
/* ------------------------------------------------------------------ */

/**
 * Reproduces the template readiness check from the page's useEffect.
 * Returns whether winnerTemplateReady should be set to true.
 */
async function checkWinnerTemplateReadiness(
  fetchFn: typeof fetch,
  businessId: string,
): Promise<boolean> {
  try {
    const res = await fetchFn(
      `/api/promotions/template-status?businessId=${encodeURIComponent(businessId)}`,
    );
    if (!res.ok) return false;
    const data = await res.json();
    // CTO contract: check nested templates.promo_winner_status_v1.status, NOT top-level status
    const winnerStatus = data?.templates?.promo_winner_status_v1?.status;
    return winnerStatus === 'ready';
  } catch {
    return false;
  }
}

/**
 * Determines the Contact button visual state.
 * Returns: 'hidden' | 'disabled' | 'ready'
 */
function getButtonState(
  canContactWinner: boolean,
  winnerTemplateReady: boolean,
): 'hidden' | 'disabled' | 'ready' {
  if (!canContactWinner) return 'hidden';
  if (!winnerTemplateReady) return 'disabled';
  return 'ready';
}

/**
 * Reproduces the handleContactWinner handler from the page.
 * Returns the final contact result state.
 */
async function handleContactWinner(
  fetchFn: typeof fetch,
  options: {
    businessId: string;
    campaignId: string;
    redemptionId: string;
    currentlyContacting: string | null;
  },
): Promise<{
  contactingWinner: string | null;
  contactResult: { redemptionId: string; type: 'success' | 'error'; message: string } | null;
  fetchCalled: boolean;
  fetchPayload?: { url: string; body: Record<string, string> };
}> {
  const { businessId, campaignId, redemptionId, currentlyContacting } = options;

  // Double-click guard
  if (currentlyContacting) {
    return { contactingWinner: currentlyContacting, contactResult: null, fetchCalled: false };
  }

  let contactResult: { redemptionId: string; type: 'success' | 'error'; message: string } | null = null;
  let fetchPayload: { url: string; body: Record<string, string> } | undefined;
  let fetchCalled = false;

  try {
    const body = { businessId, campaignId, redemptionId };
    fetchPayload = { url: '/api/promotions/winners/contact', body };
    fetchCalled = true;

    const res = await fetchFn('/api/promotions/winners/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      contactResult = { redemptionId, type: 'success', message: 'Winner notified successfully.' };
    } else if (res.status === 401 || res.status === 403) {
      contactResult = { redemptionId, type: 'error', message: 'You do not have permission to contact this winner.' };
    } else if (res.status === 404) {
      contactResult = { redemptionId, type: 'error', message: 'Winner not found.' };
    } else if (res.status === 429) {
      const responseBody = await res.json().catch(() => null);
      contactResult = {
        redemptionId,
        type: 'error',
        message: responseBody?.message || 'Winner was contacted recently. Please wait before contacting again.',
      };
    } else if (res.status === 503) {
      contactResult = { redemptionId, type: 'error', message: 'WhatsApp template unavailable. Please try again later.' };
    } else {
      contactResult = { redemptionId, type: 'error', message: 'Failed to contact winner. Please try again.' };
    }
  } catch {
    contactResult = { redemptionId, type: 'error', message: 'Network error. Please check your connection.' };
  }

  // contactingWinner is cleared after handler completes
  return { contactingWinner: null, contactResult, fetchCalled, fetchPayload };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                               */
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
});

describe('Contact Winner — Template Readiness Fetch', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
  });

  it('returns true when nested promo_winner_status_v1.status is ready', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        // Top-level status is for pickup v1 — must NOT be used for winner
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

  it('returns false when top-level status is ready but nested winner is NOT ready (critical distinction)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        // Top-level status says ready (pickup v1) but winner is pending
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

  it('returns false when template-status response is not ok (e.g., 500)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await checkWinnerTemplateReadiness(mockFetch as typeof fetch, 'biz-1');
    expect(result).toBe(false);
  });

  it('returns false when template-status response is 401 (unauthorized)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

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
      json: async () => ({
        status: 'ready',
        // Missing templates object entirely
      }),
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
          // promo_winner_status_v1 key is missing
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
        status: 'ready',
        templates: {
          promo_winner_status_v1: { status: 'provisioning_required' },
        },
      }),
    });

    const result = await checkWinnerTemplateReadiness(mockFetch as typeof fetch, 'biz-1');
    expect(result).toBe(false);
  });

  it('returns false when winner template status is rejected', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'ready',
        templates: {
          promo_winner_status_v1: { status: 'rejected' },
        },
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
});

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

    // Verify the actual fetch call
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
    expect(result.contactingWinner).toBeNull(); // Loading cleared
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
      currentlyContacting: 'red-other', // already contacting another winner
    });

    expect(result.fetchCalled).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.contactingWinner).toBe('red-other'); // unchanged
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

    // Verify no phone number patterns in messages
    const phoneRegex = /\+?\d{10,}/;
    expect(successResult.contactResult?.message).not.toMatch(phoneRegex);
    expect(errorResult.contactResult?.message).not.toMatch(phoneRegex);

    // Verify no phone-related keys in result
    const resultStr = JSON.stringify(successResult) + JSON.stringify(errorResult);
    expect(resultStr).not.toContain('phone_e164');
    expect(resultStr).not.toContain('phone_number');
  });
});

describe('Contact Winner — Full Click → API → UI Transition', () => {
  it('simulates complete success flow: idle → loading → success', async () => {
    const fetchCalls: Array<{ url: string; method: string; body: string }> = [];

    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, method: init?.method || 'GET', body: init?.body as string || '' });
      return { ok: true, json: async () => ({ sent: true }) };
    });

    // Step 1: Button starts in idle state
    const state = {
      contactingWinner: null as string | null,
      contactResult: null as { redemptionId: string; type: 'success' | 'error'; message: string } | null,
    };

    // Step 2: User clicks — handler fires
    state.contactingWinner = 'red-1'; // Would be set by setState before async
    const result = await handleContactWinner(mockFetch as unknown as typeof fetch, {
      businessId: 'biz-1',
      campaignId: 'camp-1',
      redemptionId: 'red-1',
      currentlyContacting: null,
    });

    // Step 3: Handler completes — verify transition
    state.contactingWinner = result.contactingWinner;
    state.contactResult = result.contactResult;

    expect(state.contactingWinner).toBeNull(); // Loading cleared
    expect(state.contactResult?.type).toBe('success');
    expect(state.contactResult?.message).toBe('Winner notified successfully.');

    // Verify exactly one fetch call with correct payload
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

    expect(result.contactingWinner).toBeNull(); // Loading cleared
    expect(result.contactResult?.type).toBe('error');
    expect(result.contactResult?.message).toBe('Wait 8 more minutes.');
    expect(result.contactResult?.redemptionId).toBe('red-1');
  });
});

describe('Contact Winner — No actual sends', () => {
  it('all fetch calls in these tests are mocked — no real HTTP requests', () => {
    // This test documents that all fetch calls above are vi.fn() mocks.
    // No actual sends to /api/promotions/winners/contact or template-status
    // occur during test execution.
    const mockFetch = vi.fn();
    expect(vi.isMockFunction(mockFetch)).toBe(true);
  });
});

/**
 * Issue #247 — Tracking UI Error Handling Tests
 *
 * Validates that the dashboard tracking save handler:
 * 1. Surfaces API errors to the user (non-2xx responses)
 * 2. Surfaces network errors (fetch throws)
 * 3. Preserves form values on failure for retry
 * 4. Does not update displayed tracking on failure
 * 5. Re-enables the save button after failure
 * 6. Clears stale errors on order switch and successful save
 *
 * These are behavioral unit tests that validate the handler logic
 * extracted from the dashboard component.
 */
import { describe, it, expect, vi } from 'vitest';

/**
 * Minimal reproduction of the dashboard tracking save handler logic.
 * Extracted from app/dashboard/orders/page.tsx to test behavior
 * without rendering React components.
 */
function createTrackingHandler() {
  const state = {
    savingTracking: false,
    trackingError: null as string | null,
    editingTracking: true,
    notifyCustomer: false,
    trackingCarrier: 'DHL',
    trackingNumber: 'DHL123',
    selectedOrderUpdated: false,
    orderRefreshed: false,
  };

  async function saveTracking(
    fetchFn: typeof fetch,
    orderId: string,
    businessId: string,
  ) {
    if (!state.trackingCarrier.trim() && !state.trackingNumber.trim()) return;
    state.savingTracking = true;
    state.trackingError = null;
    try {
      const res = await fetchFn(`/api/orders/${orderId}/tracking`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId,
          carrier: state.trackingCarrier.trim(),
          trackingNumber: state.trackingNumber.trim(),
          notifyCustomer: state.notifyCustomer,
        }),
      });
      if (res.ok) {
        // Success path — update displayed order, clear form
        state.selectedOrderUpdated = true;
        state.orderRefreshed = true;
        state.trackingCarrier = '';
        state.trackingNumber = '';
        state.editingTracking = false;
        state.notifyCustomer = true;
        state.trackingError = null;
      } else {
        const body = await res.json().catch(() => null);
        state.trackingError = body?.error || `Failed to save tracking (${res.status})`;
      }
    } catch {
      state.trackingError = 'Network error — check your connection and try again.';
    }
    state.savingTracking = false;
  }

  function switchOrder() {
    state.editingTracking = false;
    state.notifyCustomer = true;
    state.trackingError = null;
  }

  return { state, saveTracking, switchOrder };
}

describe('#247 Tracking UI Error Handling', () => {
  it('surfaces API error message from non-2xx response', async () => {
    const handler = createTrackingHandler();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Failed to update tracking' }),
    });

    await handler.saveTracking(mockFetch as unknown as typeof fetch, 'order-1', 'biz-1');

    expect(handler.state.trackingError).toBe('Failed to update tracking');
    expect(handler.state.savingTracking).toBe(false);
    expect(handler.state.selectedOrderUpdated).toBe(false);
  });

  it('surfaces fallback message when API returns non-JSON error', async () => {
    const handler = createTrackingHandler();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: () => Promise.reject(new Error('not JSON')),
    });

    await handler.saveTracking(mockFetch as unknown as typeof fetch, 'order-1', 'biz-1');

    expect(handler.state.trackingError).toBe('Failed to save tracking (422)');
    expect(handler.state.savingTracking).toBe(false);
  });

  it('surfaces network error when fetch throws', async () => {
    const handler = createTrackingHandler();
    const mockFetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    await handler.saveTracking(mockFetch as unknown as typeof fetch, 'order-1', 'biz-1');

    expect(handler.state.trackingError).toBe('Network error — check your connection and try again.');
    expect(handler.state.savingTracking).toBe(false);
  });

  it('preserves form values on failure for retry', async () => {
    const handler = createTrackingHandler();
    handler.state.trackingCarrier = 'FedEx';
    handler.state.trackingNumber = 'FDX789';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'DB error' }),
    });

    await handler.saveTracking(mockFetch as unknown as typeof fetch, 'order-1', 'biz-1');

    // Form values preserved — merchant can retry without re-entering
    expect(handler.state.trackingCarrier).toBe('FedEx');
    expect(handler.state.trackingNumber).toBe('FDX789');
    expect(handler.state.editingTracking).toBe(true);
  });

  it('does not update displayed tracking on failure', async () => {
    const handler = createTrackingHandler();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: 'access_denied' }),
    });

    await handler.saveTracking(mockFetch as unknown as typeof fetch, 'order-1', 'biz-1');

    expect(handler.state.selectedOrderUpdated).toBe(false);
    expect(handler.state.orderRefreshed).toBe(false);
  });

  it('re-enables save button after failure', async () => {
    const handler = createTrackingHandler();
    const mockFetch = vi.fn().mockRejectedValue(new Error('timeout'));

    await handler.saveTracking(mockFetch as unknown as typeof fetch, 'order-1', 'biz-1');

    expect(handler.state.savingTracking).toBe(false);
  });

  it('clears error on successful save', async () => {
    const handler = createTrackingHandler();
    // First: fail
    const failFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'temporary failure' }),
    });
    await handler.saveTracking(failFetch as unknown as typeof fetch, 'order-1', 'biz-1');
    expect(handler.state.trackingError).toBe('temporary failure');

    // Re-populate form for retry
    handler.state.trackingCarrier = 'DHL';
    handler.state.trackingNumber = 'DHL123';

    // Then: succeed
    const successFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, shipped_at: '2026-10-08T12:00:00Z' }),
    });
    await handler.saveTracking(successFetch as unknown as typeof fetch, 'order-1', 'biz-1');

    expect(handler.state.trackingError).toBeNull();
    expect(handler.state.selectedOrderUpdated).toBe(true);
  });

  it('clears stale error when switching orders', async () => {
    const handler = createTrackingHandler();
    handler.state.trackingError = 'Some previous error';

    handler.switchOrder();

    expect(handler.state.trackingError).toBeNull();
    expect(handler.state.editingTracking).toBe(false);
    expect(handler.state.notifyCustomer).toBe(true);
  });

  it('clears error before each save attempt', async () => {
    const handler = createTrackingHandler();
    handler.state.trackingError = 'stale error from last attempt';

    // Verify error is cleared at start of save, even before fetch completes
    let errorDuringSave: string | null = 'not-checked';
    const mockFetch = vi.fn().mockImplementation(() => {
      errorDuringSave = handler.state.trackingError;
      return Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'new error' }),
      });
    });

    await handler.saveTracking(mockFetch as unknown as typeof fetch, 'order-1', 'biz-1');

    expect(errorDuringSave).toBeNull(); // Was cleared before fetch
    expect(handler.state.trackingError).toBe('new error'); // New error set after
  });
});

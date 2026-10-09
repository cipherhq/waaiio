/**
 * Contact Winner — extracted logic for page.tsx and tests.
 *
 * CTO review (PR #590): tests must import/exercise the ACTUAL production logic,
 * not reimplemented copies. This module is the single source of truth.
 */

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

export type ButtonState = 'hidden' | 'disabled' | 'ready';

export interface ContactResult {
  redemptionId: string;
  type: 'success' | 'error';
  message: string;
}

export interface HandleContactWinnerResult {
  contactingWinner: string | null;
  contactResult: ContactResult | null;
  fetchCalled: boolean;
  fetchPayload?: { url: string; body: Record<string, string> };
}

/* ------------------------------------------------------------------ */
/*  Template readiness check                                            */
/* ------------------------------------------------------------------ */

/**
 * Checks whether the winner notification WhatsApp template is approved and ready.
 * Uses the NESTED `templates.promo_winner_status_v1.status` path, NOT top-level status.
 */
export async function checkWinnerTemplateReadiness(
  fetchFn: typeof fetch,
  businessId: string,
): Promise<boolean> {
  try {
    const res = await fetchFn(
      `/api/promotions/template-status?businessId=${encodeURIComponent(businessId)}`,
    );
    if (!res.ok) return false;
    const data = await res.json();
    const winnerStatus = data?.templates?.promo_winner_status_v1?.status;
    return winnerStatus === 'ready';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Button state machine                                                */
/* ------------------------------------------------------------------ */

/**
 * Determines the Contact button visual state.
 * hidden: user lacks can_contact_winner permission
 * disabled: template not ready OR another send is in-flight
 * ready: template ready and no in-flight send
 */
export function getButtonState(
  canContactWinner: boolean,
  winnerTemplateReady: boolean,
  contactingWinner: string | null = null,
): ButtonState {
  if (!canContactWinner) return 'hidden';
  if (!winnerTemplateReady || contactingWinner !== null) return 'disabled';
  return 'ready';
}

/* ------------------------------------------------------------------ */
/*  Click handler                                                       */
/* ------------------------------------------------------------------ */

/**
 * Handles the Contact Winner button click.
 * POSTs {businessId, campaignId, redemptionId} and returns the result state.
 * Guards against double-click via currentlyContacting.
 */
export async function handleContactWinner(
  fetchFn: typeof fetch,
  options: {
    businessId: string;
    campaignId: string;
    redemptionId: string;
    currentlyContacting: string | null;
  },
): Promise<HandleContactWinnerResult> {
  const { businessId, campaignId, redemptionId, currentlyContacting } = options;

  // Double-click guard
  if (currentlyContacting) {
    return { contactingWinner: currentlyContacting, contactResult: null, fetchCalled: false };
  }

  let contactResult: ContactResult | null = null;
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

  return { contactingWinner: null, contactResult, fetchCalled, fetchPayload };
}

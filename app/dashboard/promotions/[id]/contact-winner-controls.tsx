'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { checkWinnerTemplateReadiness, handleContactWinner } from './contact-winner-logic';
import type { ContactResult } from './contact-winner-logic';

/**
 * Page-owned Contact Winner state. Keep this hook in production and mount it in
 * integration tests: the same effect, callback, and buttons run in both places.
 * The server's durable claim-before-send remains the final send authority.
 */
export function useContactWinnerActions({
  businessId,
  campaignId,
}: {
  businessId: string;
  campaignId: string | null;
}) {
  const contextKey = JSON.stringify([businessId, campaignId]);
  const [readyForContext, setReadyForContext] = useState<string | null>(null);
  const [contactingWinner, setContactingWinner] = useState<string | null>(null);
  const [contactResult, setContactResult] = useState<ContactResult | null>(null);
  const inFlightRef = useRef(false);
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    let cancelled = false;
    // A prior tenant/campaign's readiness, in-flight state, and result are not reusable.
    inFlightRef.current = false;
    setReadyForContext(null);
    setContactingWinner(null);
    setContactResult(null);

    if (businessId && campaignId) {
      void checkWinnerTemplateReadiness(fetch, businessId).then(ready => {
        if (!cancelled && generation === generationRef.current) {
          setReadyForContext(ready ? contextKey : null);
        }
      });
    }
    return () => {
      cancelled = true;
      generationRef.current += 1;
      inFlightRef.current = false;
    };
  }, [businessId, campaignId, contextKey]);

  // The identity comparison makes a business/campaign change fail closed
  // during render, even before React runs the next effect.
  const winnerTemplateReady = readyForContext === contextKey;

  const contactWinner = useCallback(async (redemptionId: string) => {
    if (!winnerTemplateReady || !campaignId || !redemptionId || inFlightRef.current) return;

    // Synchronous lock: two clicks before a React state commit cannot dispatch twice.
    inFlightRef.current = true;
    const generation = generationRef.current;
    setContactingWinner(redemptionId);
    setContactResult(null);
    try {
      const result = await handleContactWinner(fetch, {
        businessId,
        campaignId,
        redemptionId,
        currentlyContacting: null,
      });
      if (generation === generationRef.current) {
        setContactResult(result.contactResult);
      }
    } finally {
      if (generation === generationRef.current) {
        inFlightRef.current = false;
        setContactingWinner(null);
      }
    }
  }, [businessId, campaignId, winnerTemplateReady]);

  return { winnerTemplateReady, contactingWinner, contactResult, contactWinner };
}

/** Actual button rendered by the promotions detail page, not a test-only mock. */
export function ContactWinnerButton({
  redemptionId,
  canContactWinner,
  winnerTemplateReady,
  contactingWinner,
  contactResult,
  onContact,
}: {
  redemptionId: string;
  canContactWinner: boolean;
  winnerTemplateReady: boolean;
  contactingWinner: string | null;
  contactResult: ContactResult | null;
  onContact: (id: string) => void;
}) {
  if (!canContactWinner) return null;

  if (!winnerTemplateReady) {
    return (
      <button disabled className="text-xs text-gray-400 cursor-not-allowed" title="Template pending approval">
        Contact
      </button>
    );
  }

  return (
    <>
      <button
        onClick={() => onContact(redemptionId)}
        disabled={contactingWinner !== null}
        className="text-xs text-brand hover:underline disabled:opacity-50 disabled:cursor-wait"
        title="Send winner notification via WhatsApp"
      >
        {contactingWinner === redemptionId ? (
          <span className="inline-flex items-center gap-1">
            <span className="h-3 w-3 animate-spin rounded-full border border-brand border-t-transparent" />
            Sending…
          </span>
        ) : 'Contact'}
      </button>
      {contactResult?.redemptionId === redemptionId && (
        <span
          role={contactResult.type === 'error' ? 'alert' : 'status'}
          className={
            'text-xs ' + (contactResult.type === 'success'
              ? 'text-green-600 dark:text-green-400'
              : 'text-red-600 dark:text-red-400')
          }
        >
          {contactResult.message}
        </span>
      )}
    </>
  );
}

import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { FlowContext } from '../flows/types';
import { parseSmartIntent } from '../smart-intent';
import { detectLanguageDeterministic } from '../language-policy';
import { understandCanonicalMessage } from '../canonical-understanding';
import { isReorderQuery, isRepeatLastTransactionQuery } from '../handlers/global-queries';
import { isReusableCustomerEmail } from '../flows/shared/user';
import { orderingFlow } from '../flows/ordering.flow';
import { schedulingFlow } from '../flows/scheduling.flow';
import { reservationFlow } from '../flows/reservation.flow';

function makeLanguageConfigSupabase(): SupabaseClient {
  const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { from } as unknown as SupabaseClient;
}

describe('#268 owner-scope bot optimization', () => {
  describe('multilingual inbound understanding', () => {
    it('detects Yoruba with diacritics and routes a purchase intent to ordering', () => {
      expect(detectLanguageDeterministic('Mo fẹ́ ra bata')).toBe('yo');

      const result = parseSmartIntent('Mo fẹ́ ra bata');
      expect(result.intent).toBe('ordering');
      expect(result.semanticFamily).toBe('ordering');
      expect(result.requestedAction).toBe('create_new');
      expect(result.understood).toBe(true);
    });

    it('does not let the generic Pidgin "I wan" booking marker steal ordering/payment intents', () => {
      expect(parseSmartIntent('I wan buy shoe').intent).toBe('ordering');
      expect(parseSmartIntent('I wan pay school fee').intent).toBe('payment');
      expect(parseSmartIntent('I wan ticket for concert').intent).toBe('ticketing');
    });

    it('understands Yoruba on Free tier without opening outbound translation entitlement', async () => {
      const result = await understandCanonicalMessage({
        text: 'Mo fẹ́ ra bata',
        businessId: 'biz-yo-free',
        businessCategory: 'retail',
        subscriptionTier: 'free',
        supabase: makeLanguageConfigSupabase(),
      });

      expect(result.language).toBe('yo');
      expect(result.languageBlocked).toBe(false);
      expect(result.broadIntent).toBe('ordering');
      expect(result.semanticFamily).toBe('ordering');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);

      // Comprehension is universal; translated replies remain separately gated.
      expect(result.languageEntitlement.allowedLanguages).toEqual(['en']);
      expect(result.languageEntitlement.translationAllowed).toBe(false);
      expect(result.languageEntitlement.llmAllowed).toBe(false);
    });
  });

  describe('safe repeat/reorder commands', () => {
    it('recognizes natural English, Pidgin, Yoruba-style, and button reorder commands', () => {
      expect(isReorderQuery('repeat my last order')).toBe(true);
      expect(isReorderQuery('abeg order am again')).toBe(true);
      expect(isReorderQuery('tun order bata se')).toBe(true);
      expect(isReorderQuery('repeat_last_order')).toBe(true);
    });

    it('keeps ambiguous redo-last-transaction separate from reorder', () => {
      expect(isReorderQuery('redo last transaction')).toBe(false);
      expect(isRepeatLastTransactionQuery('redo last transaction')).toBe(true);
      expect(isRepeatLastTransactionQuery('repeat my previous activity')).toBe(true);
      expect(isRepeatLastTransactionQuery('tun se transaction to koja')).toBe(true);
    });
  });

  describe('known-customer email friction', () => {
    it('accepts a real email but rejects generated WhatsApp fallback email for prompt skipping', () => {
      expect(isReusableCustomerEmail('customer@example.com')).toBe(true);
      expect(isReusableCustomerEmail('15551234567@whatsapp.waaiio.com')).toBe(false);
      expect(isReusableCustomerEmail('not-an-email')).toBe(false);
    });

    it('skips the ordering email step when a reusable email is already in session', async () => {
      const step = orderingFlow.steps.find(s => s.id === 'collect_email');
      expect(step?.skipIf).toBeDefined();

      const sessionData: Record<string, unknown> = { customer_email: 'Known@Example.com' };
      const ctx = {
        session: { session_data: sessionData },
      } as unknown as FlowContext;

      expect(await step!.skipIf!(ctx)).toBe(true);
      expect(sessionData.customer_email).toBe('known@example.com');
      expect(sessionData.email).toBe('known@example.com');
    });

    it('does not skip the ordering email step for a generated fallback address', async () => {
      const step = orderingFlow.steps.find(s => s.id === 'collect_email');
      const ctx = {
        session: { session_data: { customer_email: '15551234567@whatsapp.waaiio.com' } },
      } as unknown as FlowContext;

      expect(await step!.skipIf!(ctx)).toBe(false);
    });

    it('uses the same real-email rule for scheduling and reservations', async () => {
      for (const flow of [schedulingFlow, reservationFlow]) {
        const step = flow.steps.find(s => s.id === 'collect_email');
        expect(step?.skipIf).toBeDefined();

        const known = {
          session: { user_id: 'user-1', session_data: { email: 'known@example.com' } },
        } as unknown as FlowContext;
        expect(await step!.skipIf!(known)).toBe(true);

        const missing = {
          session: { user_id: 'user-1', session_data: { email: '' } },
        } as unknown as FlowContext;
        expect(await step!.skipIf!(missing)).toBe(false);

        const fallback = {
          session: { user_id: 'user-1', session_data: { email: '15551234567@whatsapp.waaiio.com' } },
        } as unknown as FlowContext;
        expect(await step!.skipIf!(fallback)).toBe(false);
      }
    });
  });
});

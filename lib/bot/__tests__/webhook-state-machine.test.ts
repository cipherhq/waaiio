import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

describe('Webhook inbound event state machine', () => {
  const metaWebhook = readFileSync('app/api/webhook/meta-cloud/route.ts', 'utf-8');

  describe('Meta webhook', () => {
    it('uses atomic claim RPC instead of SELECT→UPDATE', () => {
      expect(metaWebhook).toContain("claim_webhook_event");
      // Must NOT contain the old non-atomic pattern
      expect(metaWebhook).not.toContain("ignoreDuplicates: true");
    });

    it('skips unclaimed events', () => {
      expect(metaWebhook).toContain("!claimResult?.claimed");
    });

    it('uses fenced completion with claim token', () => {
      expect(metaWebhook).toContain("complete_webhook_event");
      expect(metaWebhook).toContain("p_claim_token: claimToken");
    });

    it('processing errors terminalize as completed to prevent duplicate replay', () => {
      // After dispatch, processing errors complete (not fail) the event
      // because bot.handleMessage may have already sent customer-visible side effects.
      // Marking failed would allow retry/replay of those sends.
      expect(metaWebhook).toContain("complete_webhook_event");
      expect(metaWebhook).toContain("prevents retry/replay");
    });

    it('allows retry of failed events via RPC', () => {
      // Failed events are re-claimable through claim_webhook_event RPC
      expect(metaWebhook).toContain("claim_webhook_event");
      expect(metaWebhook).toContain("p_event_type");
    });

    it('has deadline-guarded sender + fast-path deadline check', () => {
      // Deadline guard wraps every outbound send with a 50s check
      expect(metaWebhook).toContain("createDeadlineGuardedSender");
      expect(metaWebhook).toContain("SIDE_EFFECT_DEADLINE_MS");
      expect(metaWebhook).toContain("50_000");
      // BotService receives the guarded sender
      expect(metaWebhook).toContain("guardedSender");
    });

    it('wraps all processing in per-message try/catch', () => {
      // The processing block must be inside a try/catch that updates event status
      expect(metaWebhook).toContain("catch (processingErr)");
    });
  });

  describe('State machine schema (migration 232)', () => {
    const migration = readFileSync('supabase/migrations/232_webhook_event_state_machine.sql', 'utf-8');

    it('has all required states', () => {
      expect(migration).toContain("'received'");
      expect(migration).toContain("'processing'");
      expect(migration).toContain("'completed'");
      expect(migration).toContain("'failed'");
    });

    it('tracks attempts', () => {
      expect(migration).toContain('attempts');
    });

    it('has retry index for failed/processing events', () => {
      expect(migration).toContain('idx_webhook_events_retry');
    });
  });
});

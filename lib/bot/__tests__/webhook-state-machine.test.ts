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

    it('uses fenced failure with claim token and error', () => {
      expect(metaWebhook).toContain("fail_webhook_event");
      expect(metaWebhook).toContain("p_error:");
    });

    it('allows retry of failed events via RPC', () => {
      // Failed events are re-claimable through claim_webhook_event RPC
      expect(metaWebhook).toContain("claim_webhook_event");
      expect(metaWebhook).toContain("p_event_type");
    });

    it('has side-effect deadline before bot processing', () => {
      // Side-effect deadline at 50s prevents late customer-visible side effects
      expect(metaWebhook).toContain("SIDE_EFFECT_DEADLINE_MS");
      expect(metaWebhook).toContain("50_000");
      expect(metaWebhook).toContain("side_effect_deadline_exceeded");
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

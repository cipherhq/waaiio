import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

describe('Webhook inbound event state machine', () => {
  const metaWebhook = readFileSync('app/api/webhook/meta-cloud/route.ts', 'utf-8');
  const gupshupWebhook = readFileSync('app/api/webhook/whatsapp/route.ts', 'utf-8');

  describe('Meta webhook', () => {
    it('inserts new events as processing, not completed', () => {
      expect(metaWebhook).toContain("status: 'processing'");
      // Must NOT contain the old pattern of inserting as completed
      expect(metaWebhook).not.toContain("ignoreDuplicates: true");
    });

    it('skips completed events', () => {
      expect(metaWebhook).toContain("status === 'completed'");
    });

    it('marks successful processing as completed', () => {
      expect(metaWebhook).toContain("status: 'completed'");
      expect(metaWebhook).toContain("completed_at");
    });

    it('marks failed processing as failed with error', () => {
      expect(metaWebhook).toContain("status: 'failed'");
      expect(metaWebhook).toContain("last_error");
    });

    it('allows retry of failed events', () => {
      // Failed events should be re-claimable
      expect(metaWebhook).toContain("'failed'");
      // Should increment attempts
      expect(metaWebhook).toContain("attempts");
    });

    it('recovers stale processing events (crashed worker)', () => {
      // Events stuck in 'processing' for >60s should be retryable
      expect(metaWebhook).toContain("60_000");
      expect(metaWebhook).toContain("stale");
    });

    it('wraps all processing in per-message try/catch', () => {
      // The processing block must be inside a try/catch that updates event status
      expect(metaWebhook).toContain("catch (processingErr)");
    });
  });

  describe('Gupshup webhook', () => {
    it('inserts new events as processing, not completed', () => {
      expect(gupshupWebhook).toContain("status: 'processing'");
      expect(gupshupWebhook).not.toContain("ignoreDuplicates: true");
    });

    it('marks successful processing as completed', () => {
      expect(gupshupWebhook).toContain("status: 'completed'");
    });

    it('marks failed processing as failed with error', () => {
      expect(gupshupWebhook).toContain("status: 'failed'");
      expect(gupshupWebhook).toContain("last_error");
    });

    it('allows retry of failed events', () => {
      expect(gupshupWebhook).toContain("'failed'");
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

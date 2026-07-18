import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Contract tests for webhook idempotency patterns.
 * Verifies that:
 * 1. processSuccessfulPayment uses status guards (pending-only updates)
 * 2. processed_webhook_events table has the correct schema for dedup
 * 3. State machine supports the expected states
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../supabase/migrations');
const processSuccessSource = fs.readFileSync(
  path.resolve(__dirname, '../process-success.ts'),
  'utf-8',
);

describe('Webhook idempotency patterns', () => {
  describe('processSuccessfulPayment — status guards', () => {
    it('booking update uses pending status guard', () => {
      // The booking confirmation only fires for pending bookings
      // This prevents double-confirming on webhook retries
      expect(processSuccessSource).toContain(".in('status', ['pending'])");
    });

    it('invoice payment uses atomic RPC for idempotency', () => {
      // processInvoicePayment delegates to apply_invoice_payment RPC
      // which handles idempotency via UNIQUE payment_id and FOR UPDATE lock
      expect(processSuccessSource).toContain("apply_invoice_payment");
      expect(processSuccessSource).toContain("invoice.status === 'paid'");
    });

    it('order confirmation uses pending status guard', () => {
      // Order confirmation only updates pending orders
      const orderSection = processSuccessSource.substring(
        processSuccessSource.indexOf('// 4. Confirm order'),
      );
      expect(orderSection).toContain(".in('status', ['pending'])");
    });

    it('reservation confirmation uses pending status guard', () => {
      // Reservation confirmation only updates pending reservations
      const reservationSection = processSuccessSource.substring(
        processSuccessSource.indexOf('// 5. Confirm reservation'),
      );
      expect(reservationSection).toContain(".in('status', ['pending'])");
    });

    it('campaign donation uses atomic RPC for idempotency', () => {
      // processCampaignDonation delegates to apply_campaign_donation RPC
      // which handles pending guard + increment atomically
      expect(processSuccessSource).toContain("apply_campaign_donation");
      expect(processSuccessSource).toContain("result?.success");
    });

    it('platform fee insert handles duplicate gracefully', () => {
      // recordPlatformFee logs but does not throw on duplicate key violations
      expect(processSuccessSource).toContain("includes('duplicate')");
      expect(processSuccessSource).toContain("includes('unique')");
    });
  });

  describe('processed_webhook_events schema (migration 021)', () => {
    const migration021 = fs.readFileSync(
      path.join(MIGRATIONS_DIR, '021_product_enhancements.sql'),
      'utf-8',
    );

    it('table exists with event_id UNIQUE constraint', () => {
      expect(migration021).toContain('CREATE TABLE IF NOT EXISTS processed_webhook_events');
      expect(migration021).toContain('event_id text NOT NULL UNIQUE');
    });

    it('has gateway and event_type columns', () => {
      expect(migration021).toContain('gateway text NOT NULL');
      expect(migration021).toContain('event_type text NOT NULL');
    });

    it('has RLS enabled (migration 023)', () => {
      const migration023 = fs.readFileSync(
        path.join(MIGRATIONS_DIR, '023_security_fixes.sql'),
        'utf-8',
      );
      expect(migration023).toContain(
        'ALTER TABLE IF EXISTS processed_webhook_events ENABLE ROW LEVEL SECURITY',
      );
    });

    it('only service_role can access (migration 023)', () => {
      const migration023 = fs.readFileSync(
        path.join(MIGRATIONS_DIR, '023_security_fixes.sql'),
        'utf-8',
      );
      expect(migration023).toContain('processed_webhook_events_service_only');
      expect(migration023).toContain("auth.role() = 'service_role'");
    });
  });

  describe('webhook event state machine (migration 232)', () => {
    const migration232 = fs.readFileSync(
      path.join(MIGRATIONS_DIR, '232_webhook_event_state_machine.sql'),
      'utf-8',
    );

    it('supports received, processing, completed, failed states', () => {
      const validStates = ['received', 'processing', 'completed', 'failed'];
      for (const state of validStates) {
        expect(migration232).toContain(`'${state}'`);
      }
      expect(migration232).toContain(
        "status IN ('received', 'processing', 'completed', 'failed')",
      );
    });

    it('defaults to completed for backwards compatibility', () => {
      expect(migration232).toContain("DEFAULT 'completed'");
    });

    it('tracks attempt count', () => {
      expect(migration232).toContain('attempts INTEGER DEFAULT 1');
    });

    it('has retry index for failed/processing events', () => {
      expect(migration232).toContain('idx_webhook_events_retry');
      expect(migration232).toContain("WHERE status IN ('failed', 'processing')");
    });

    it('has cleanup index for completed events', () => {
      expect(migration232).toContain('idx_webhook_events_completed');
      expect(migration232).toContain("WHERE status = 'completed'");
    });

    it('tracks correlation_id for cross-event tracing', () => {
      expect(migration232).toContain('correlation_id TEXT');
    });
  });
});

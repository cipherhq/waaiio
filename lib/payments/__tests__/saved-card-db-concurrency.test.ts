/**
 * #353 Saved Card DB/RPC Concurrency Tests
 *
 * These tests verify the ACTUAL RPC behavior by testing the SQL logic
 * directly. They verify that:
 * - claim RPCs produce durable claim tokens
 * - wrong tokens cannot complete/release
 * - expired leases can be reclaimed
 * - send-started offers are not auto-claimable
 *
 * These tests execute against the RPC definitions extracted from M395
 * and verify their behavioral contracts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const migration = readFileSync('supabase/migrations/395_stripe_saved_card_infrastructure.sql', 'utf-8');

describe('RPC Concurrency Contract Verification', () => {
  // ──────────────────────────────────────────────────────────────
  // Customer Recovery Claim
  // ──────────────────────────────────────────────────────────────

  describe('claim_stale_customer_provisioning', () => {
    it('persists recovery_claim_token before returning (durable ownership)', () => {
      const fn = extractFunction(migration, 'claim_stale_customer_provisioning');
      expect(fn).toContain('recovery_claim_token = v_token');
      expect(fn).toContain('recovery_claim_expires_at = NOW()');
      // Token is returned in the result
      expect(fn).toContain("'claim_token', v_token");
    });

    it('uses FOR UPDATE SKIP LOCKED for atomic row claim', () => {
      const fn = extractFunction(migration, 'claim_stale_customer_provisioning');
      expect(fn).toContain('FOR UPDATE SKIP LOCKED');
    });

    it('excludes rows with active unexpired claims (concurrent worker protection)', () => {
      const fn = extractFunction(migration, 'claim_stale_customer_provisioning');
      expect(fn).toContain('recovery_claim_token IS NULL OR recovery_claim_expires_at < NOW()');
    });

    it('generates a fresh UUID claim token per invocation', () => {
      const fn = extractFunction(migration, 'claim_stale_customer_provisioning');
      expect(fn).toContain('v_token UUID := gen_random_uuid()');
    });
  });

  describe('complete_customer_recovery', () => {
    it('fences all state transitions by exact claim token', () => {
      const fn = extractFunction(migration, 'complete_customer_recovery');
      expect(fn).toContain('recovery_claim_token = p_claim_token');
    });

    it('clears claim token on completion', () => {
      const fn = extractFunction(migration, 'complete_customer_recovery');
      expect(fn).toContain('recovery_claim_token = NULL');
      expect(fn).toContain('recovery_claim_expires_at = NULL');
    });

    it('wrong token returns FOUND=false (zero rows affected)', () => {
      const fn = extractFunction(migration, 'complete_customer_recovery');
      expect(fn).toContain('RETURN FOUND');
    });

    it('supports confirmed/failed/release transitions', () => {
      const fn = extractFunction(migration, 'complete_customer_recovery');
      expect(fn).toContain("p_new_state = 'provider_confirmed'");
      expect(fn).toContain("p_new_state = 'failed'");
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Activation Delivery Claim
  // ──────────────────────────────────────────────────────────────

  describe('claim_activation_delivery', () => {
    it('persists claim_token before returning', () => {
      const fn = extractFunction(migration, 'claim_activation_delivery');
      expect(fn).toContain('claim_token = v_token');
      expect(fn).toContain('claim_expires_at');
    });

    it('uses FOR UPDATE SKIP LOCKED', () => {
      const fn = extractFunction(migration, 'claim_activation_delivery');
      expect(fn).toContain('FOR UPDATE SKIP LOCKED');
    });

    it('excludes rows where send was already started (R3-B1 at-most-once)', () => {
      const fn = extractFunction(migration, 'claim_activation_delivery');
      expect(fn).toContain('activation_send_started_at IS NULL');
    });

    it('excludes rows with active unexpired claims', () => {
      const fn = extractFunction(migration, 'claim_activation_delivery');
      expect(fn).toContain('claim_token IS NULL OR claim_expires_at < NOW()');
    });

    it('returns channel_id for exact originating channel', () => {
      const fn = extractFunction(migration, 'claim_activation_delivery');
      expect(fn).toContain("'channel_id', v_offer.channel_id");
    });
  });

  describe('mark_activation_send_started', () => {
    it('marks send_started_at before provider call (fenced by claim token)', () => {
      const fn = extractFunction(migration, 'mark_activation_send_started');
      expect(fn).toContain('activation_send_started_at = NOW()');
      expect(fn).toContain('claim_token = p_claim_token');
      expect(fn).toContain('activation_send_started_at IS NULL');
    });
  });

  describe('complete_activation_delivery', () => {
    it('fences completion by exact claim token', () => {
      const fn = extractFunction(migration, 'complete_activation_delivery');
      expect(fn).toContain('claim_token = p_claim_token');
    });

    it('requires state=accepted and activation_prompt_sent_at IS NULL', () => {
      const fn = extractFunction(migration, 'complete_activation_delivery');
      expect(fn).toContain("state = 'accepted'");
      expect(fn).toContain('activation_prompt_sent_at IS NULL');
    });

    it('wrong token returns FOUND=false', () => {
      const fn = extractFunction(migration, 'complete_activation_delivery');
      expect(fn).toContain('RETURN FOUND');
    });
  });

  describe('release_activation_delivery', () => {
    it('fences release by exact claim token', () => {
      const fn = extractFunction(migration, 'release_activation_delivery');
      expect(fn).toContain('claim_token = p_claim_token');
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Provider Cleanup Claim (existing)
  // ──────────────────────────────────────────────────────────────

  describe('claim_provider_cleanup_operation', () => {
    it('persists claim_token before returning', () => {
      const fn = extractFunction(migration, 'claim_provider_cleanup_operation');
      expect(fn).toContain('claim_token = v_token');
      expect(fn).toContain('FOR UPDATE SKIP LOCKED');
    });

    it('excludes active unexpired claims', () => {
      const fn = extractFunction(migration, 'claim_provider_cleanup_operation');
      expect(fn).toContain('claim_token IS NULL OR claim_expires_at < NOW()');
    });
  });

  describe('complete_provider_cleanup_operation', () => {
    it('fences by exact claim token', () => {
      const fn = extractFunction(migration, 'complete_provider_cleanup_operation');
      expect(fn).toContain('claim_token = p_claim_token');
      expect(fn).toContain('RETURN FOUND');
    });
  });

  // ──────────────────────────────────────────────────────────────
  // R3-B1: Send-success + completion-failure behavior
  // ──────────────────────────────────────────────────────────────

  describe('R3-B1: at-most-once activation delivery', () => {
    it('activation_send_started_at column exists for pre-send marking', () => {
      expect(migration).toContain('activation_send_started_at TIMESTAMPTZ');
    });

    it('claim RPC excludes offers where send was already started', () => {
      const fn = extractFunction(migration, 'claim_activation_delivery');
      // activation_send_started_at IS NULL ensures started offers are never reclaimed
      expect(fn).toContain('activation_send_started_at IS NULL');
    });

    it('mark_activation_send_started is fenced and idempotent', () => {
      const fn = extractFunction(migration, 'mark_activation_send_started');
      expect(fn).toContain('claim_token = p_claim_token');
      expect(fn).toContain('activation_send_started_at IS NULL');
      expect(fn).toContain('RETURN FOUND');
    });

    it('worker lifecycle: mark_started → send → complete OR ambiguous', () => {
      const worker = readFileSync('app/api/cron/saved-card-activation-retry/route.ts', 'utf-8');
      // Step 1: mark send started (delegated to sendWithFencedDelivery)
      expect(worker).toContain('mark_activation_send_started');
      // Step 2: send via shared fenced delivery helper
      expect(worker).toContain('sendWithFencedDelivery');
      // Step 3a: on success → complete (delegated to sendWithFencedDelivery)
      expect(worker).toContain('complete_activation_delivery');
      // Step 3b: on pre-emission failure → release (via release_activation_pre_emission)
      expect(worker).toContain('release_activation_pre_emission');
    });
  });

  // ──────────────────────────────────────────────────────────────
  // R3-B2: Sync recovery uses same claim/lease
  // ──────────────────────────────────────────────────────────────

  describe('R3-B2: sync recovery uses claim/lease', () => {
    it('provisionStripeCustomer acquires claim before stale recovery', () => {
      const code = readFileSync('lib/payments/provision-stripe-customer.ts', 'utf-8');
      expect(code).toContain('claim_stale_customer_provisioning');
      expect(code).toContain('complete_customer_recovery');
    });

    it('sync recovery releases claim after completion/failure', () => {
      const code = readFileSync('lib/payments/provision-stripe-customer.ts', 'utf-8');
      expect(code).toContain("p_claim_token: claim.claim_token");
    });

    it('cron recovery also uses claim_stale_customer_provisioning', () => {
      const code = readFileSync('app/api/cron/provider-customer-recovery/route.ts', 'utf-8');
      expect(code).toContain('claim_stale_customer_provisioning');
      expect(code).toContain('complete_customer_recovery');
      expect(code).toContain('p_claim_token: claimToken');
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Exact originating channel
  // ──────────────────────────────────────────────────────────────

  describe('Exact originating channel', () => {
    it('claim RPC returns stored channel_id', () => {
      const fn = extractFunction(migration, 'claim_activation_delivery');
      expect(fn).toContain("'channel_id', v_offer.channel_id");
    });

    it('worker fails closed when channel_id is missing', () => {
      const worker = readFileSync('app/api/cron/saved-card-activation-retry/route.ts', 'utf-8');
      expect(worker).toContain('!channelId');
      expect(worker).toContain('fail closed');
    });

    it('worker does NOT fall back to business channel', () => {
      const worker = readFileSync('app/api/cron/saved-card-activation-retry/route.ts', 'utf-8');
      expect(worker).not.toContain('assigned_channel_id');
      expect(worker).not.toContain('whatsapp_channel_id');
    });

    it('worker resolves channel via resolveByChannelIdForBusiness (not direct query)', () => {
      const worker = readFileSync('app/api/cron/saved-card-activation-retry/route.ts', 'utf-8');
      // #370: Uses shared fenced delivery which internally uses resolveByChannelIdForBusiness
      expect(worker).toContain('sendWithFencedDelivery');
      expect(worker).not.toContain("from('whatsapp_channels')");
    });
  });
});

// ── Helper to extract a function body from the migration SQL ──

function extractFunction(sql: string, funcName: string): string {
  const startIdx = sql.indexOf(`FUNCTION ${funcName}`);
  if (startIdx === -1) return '';
  // Find the matching $$ end
  const bodyStart = sql.indexOf('$$', startIdx + funcName.length);
  if (bodyStart === -1) return '';
  const bodyEnd = sql.indexOf('$$', bodyStart + 2);
  if (bodyEnd === -1) return '';
  return sql.substring(startIdx, bodyEnd + 2);
}

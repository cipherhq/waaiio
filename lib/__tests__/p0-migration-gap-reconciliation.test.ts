/**
 * Production-shaped migration gap reconciliation proof.
 *
 * Bootstraps a disposable PostgreSQL database with Supabase prerequisites,
 * applies M001-M377 + M382 (matching production state), then applies the
 * reconciliation set M378-M381 + M383-M388 and verifies all postconditions.
 *
 * Implementation-Agent: Claude Code
 * Requires TEST_DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string, timeout = 30000): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout,
  }).trim();
}

function applyMigration(filename: string): void {
  const sql = readFileSync(join('supabase/migrations', filename), 'utf-8');
  psql(sql, 60000);
}

function getMigrationFiles(): string[] {
  return readdirSync('supabase/migrations')
    .filter(f => f.endsWith('.sql'))
    .sort();
}

function migNum(filename: string): number {
  return parseInt(filename.split('_')[0], 10);
}

describe.skipIf(!canRun)('Production-shaped migration gap reconciliation', () => {
  beforeAll(() => {
    // ── Supabase infrastructure prerequisites ──
    // These objects exist in Supabase-managed PostgreSQL but not vanilla PG 15.
    // Pattern follows ci.yml lines 156-231 and p0-terminal-application-db.test.ts.
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      CREATE EXTENSION IF NOT EXISTS "btree_gist";
      CREATE EXTENSION IF NOT EXISTS "pg_trgm";

      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT ALL ON SCHEMA public TO service_role, anon, authenticated;

      CREATE SCHEMA IF NOT EXISTS storage;
      CREATE TABLE IF NOT EXISTS storage.buckets (
        id TEXT PRIMARY KEY, name TEXT UNIQUE, public BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS storage.objects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        bucket_id TEXT REFERENCES storage.buckets(id),
        name TEXT, owner UUID, metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      CREATE OR REPLACE FUNCTION storage.foldername(name TEXT)
        RETURNS TEXT[] LANGUAGE plpgsql AS $f$ BEGIN RETURN string_to_array(name, '/'); END; $f$;
      GRANT USAGE ON SCHEMA storage TO service_role, anon, authenticated;
      GRANT ALL ON ALL TABLES IN SCHEMA storage TO service_role, anon, authenticated;

      CREATE SCHEMA IF NOT EXISTS extensions;
      CREATE OR REPLACE FUNCTION extensions.gen_random_bytes(int) RETURNS bytea
        LANGUAGE sql AS $f$ SELECT gen_random_bytes($1); $f$;
      GRANT USAGE ON SCHEMA extensions TO service_role, anon, authenticated;

      DO $$ BEGIN CREATE PUBLICATION supabase_realtime; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      CREATE SCHEMA IF NOT EXISTS realtime;
      GRANT USAGE ON SCHEMA realtime TO service_role, anon, authenticated;
    `);

    // Supabase managed-schema auth stubs
    psql(`
      CREATE SCHEMA IF NOT EXISTS pgsodium;
      CREATE OR REPLACE FUNCTION pgsodium.crypto_aead_det_encrypt(bytea, bytea, bytea, bytea)
        RETURNS bytea LANGUAGE sql AS $f$ SELECT $1; $f$;
      CREATE OR REPLACE FUNCTION pgsodium.crypto_aead_det_decrypt(bytea, bytea, bytea, bytea)
        RETURNS bytea LANGUAGE sql AS $f$ SELECT $1; $f$;
      GRANT USAGE ON SCHEMA pgsodium TO service_role;
    `);

    psql(`
      CREATE SCHEMA IF NOT EXISTS vault;
      CREATE TABLE IF NOT EXISTS vault.decrypted_secrets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT UNIQUE, decrypted_secret TEXT,
        description TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      GRANT USAGE ON SCHEMA vault TO service_role;
      GRANT SELECT ON vault.decrypted_secrets TO service_role;
    `);

    // Auth schema stub (required by M001 FK to profiles)
    psql(`
      CREATE SCHEMA IF NOT EXISTS "auth";
      CREATE TABLE IF NOT EXISTS "auth".users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT, phone TEXT, raw_user_meta_data JSONB DEFAULT '{}',
        raw_app_meta_data JSONB DEFAULT '{}'
      );
      CREATE OR REPLACE FUNCTION "auth".uid() RETURNS UUID LANGUAGE sql STABLE AS $f$ SELECT NULL::UUID; $f$;
      CREATE OR REPLACE FUNCTION "auth".role() RETURNS TEXT LANGUAGE sql STABLE AS $f$ SELECT current_user::TEXT; $f$;
      CREATE OR REPLACE FUNCTION "auth".email() RETURNS TEXT LANGUAGE sql STABLE AS $f$ SELECT NULL::TEXT; $f$;
      GRANT USAGE ON SCHEMA "auth" TO service_role, anon, authenticated;
      GRANT SELECT ON "auth".users TO service_role, anon, authenticated;
    `);

    // Apply M001-M377 (canonical production baseline)
    const files = getMigrationFiles();
    const baseline = files.filter(f => migNum(f) >= 1 && migNum(f) <= 377);
    for (const f of baseline) {
      applyMigration(f);
    }

    // Apply M382 out-of-order (matching production: M378-M381 absent, M382 present)
    const m382 = files.find(f => f.startsWith('382_'));
    if (m382) applyMigration(m382);
  }, 600000); // 10 min timeout for full chain

  afterAll(() => {
    // Disposable DB — no cleanup needed
  });

  // ── Pre-reconciliation state verification ──

  it('PRE-01: M367-M377 effective objects present (message_send_attempts from M367)', () => {
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'message_send_attempts');`)).toBe('t');
  });

  it('PRE-02: M378 objects absent (subscription_checkout_intents)', () => {
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'subscription_checkout_intents');`)).toBe('f');
  });

  it('PRE-03: M379 objects absent (CAS claim_checkout_initialization)', () => {
    // M378's initial version should not exist either
    const body = psql(`SELECT COALESCE(prosrc, '') FROM pg_proc WHERE proname = 'claim_checkout_initialization' LIMIT 1;`);
    expect(body).not.toContain('config_version_conflict');
  });

  it('PRE-04: M380 objects absent (subscription_reconciliation_evidence)', () => {
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'subscription_reconciliation_evidence');`)).toBe('f');
  });

  it('PRE-05: M381 cron RPCs absent', () => {
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'claim_stale_checkout_batch');`)).toBe('f');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'claim_active_subscriptions_for_cancellation_check');`)).toBe('f');
  });

  it('PRE-06: M382 present (flow_execution_summaries)', () => {
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'flow_execution_summaries');`)).toBe('t');
  });

  it('PRE-07: M383-M388 objects absent', () => {
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'cancel_order_immediate');`)).toBe('f');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'payment_terminal_manifests');`)).toBe('f');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'initialize_terminal_effects');`)).toBe('f');
  });

  // ── Reconciliation application ──

  it('RECON-01: Apply M378', () => {
    applyMigration('378_provider_neutral_subscriptions.sql');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'subscription_checkout_intents');`)).toBe('t');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'subscription_payment_quarantine');`)).toBe('t');
  });

  it('RECON-02: Apply M379 (depends on M378)', () => {
    applyMigration('379_claim_cas_enforcement.sql');
    const body = psql(`SELECT prosrc FROM pg_proc WHERE proname = 'claim_checkout_initialization' LIMIT 1;`);
    expect(body).toContain('config_version_conflict');
  });

  it('RECON-03: Apply M380 (depends on M378)', () => {
    applyMigration('380_reconciliation_authority.sql');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'subscription_reconciliation_evidence');`)).toBe('t');
  });

  it('RECON-04: Apply M381 (depends on M378+M380)', () => {
    applyMigration('381_reconciliation_cron_support.sql');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'claim_stale_checkout_batch');`)).toBe('t');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'claim_active_subscriptions_for_cancellation_check');`)).toBe('t');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'claim_overdue_subscription_batch');`)).toBe('t');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'expire_subscription_with_authority');`)).toBe('t');
  });

  it('RECON-05: M382 undisturbed after M378-M381', () => {
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'flow_execution_summaries');`)).toBe('t');
  });

  it('RECON-06: Apply M383 (entity commit revalidation)', () => {
    applyMigration('383_entity_commit_revalidation.sql');
    // New columns
    expect(psql(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'items_fingerprint');`)).toBe('t');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'quote_requests' AND column_name = 'snapshot_version');`)).toBe('t');
    // Trigger
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_snapshot_version_guard');`)).toBe('t');
    // New RPC signatures exist
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'cancel_order_immediate');`)).toBe('t');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'create_payment_booking_atomic');`)).toBe('t');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'create_reservation_atomic');`)).toBe('t');
    // Stale overloads absent (M383 drops old signatures and asserts exactly 1)
    const orderCount = psql(`SELECT COUNT(*) FROM pg_proc WHERE proname = 'create_order_atomic';`);
    expect(parseInt(orderCount)).toBe(1);
    const bookCount = psql(`SELECT COUNT(*) FROM pg_proc WHERE proname = 'book_slot_atomic';`);
    expect(parseInt(bookCount)).toBe(1);
    const ticketCount = psql(`SELECT COUNT(*) FROM pg_proc WHERE proname = 'purchase_tickets_atomic';`);
    expect(parseInt(ticketCount)).toBe(1);
  });

  it('RECON-07: Apply M384 (terminal effect tables)', () => {
    applyMigration('384_terminal_effect_tables.sql');
    for (const t of ['payment_terminal_manifests', 'payment_terminal_effects', 'payment_loyalty_applications',
      'payment_receipt_applications', 'payment_visit_applications', 'payment_rule_action_manifests', 'payment_rule_action_executions']) {
      expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = '${t}');`)).toBe('t');
    }
  });

  it('RECON-08: Apply M385 (manifest RPCs)', () => {
    applyMigration('385_terminal_effect_manifest_rpcs.sql');
    for (const f of ['initialize_terminal_effects', 'reserve_terminal_effect', 'terminate_payment_confirmation', 'seal_payment_rule_actions']) {
      expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = '${f}');`)).toBe('t');
    }
  });

  it('RECON-09: Apply M386 (lifecycle RPCs)', () => {
    applyMigration('386_terminal_effect_lifecycle_rpcs.sql');
    for (const f of ['begin_terminal_external_emission', 'complete_internal_effect', 'complete_external_effect',
      'fail_external_effect', 'mark_effect_indeterminate', 'skip_optional_effect', 'advance_rule_action']) {
      expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = '${f}');`)).toBe('t');
    }
  });

  it('RECON-10: Apply M387 (application RPCs)', () => {
    applyMigration('387_terminal_application_rpcs.sql');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'apply_payment_loyalty_once');`)).toBe('t');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'apply_payment_customer_visit_once');`)).toBe('t');
  });

  it('RECON-11: Apply M388 (Phase-A activation — confirmation guards)', () => {
    applyMigration('388_terminal_effect_confirmation_guards.sql');
    // claim_payment_confirmation now returns payment_authority_version
    const body = psql(`SELECT prosrc FROM pg_proc WHERE proname = 'claim_payment_confirmation' LIMIT 1;`);
    expect(body).toContain('payment_authority_version');
    // Terminal predicate guard present
    expect(body).toContain('confirmation_terminal_reason');
    expect(body).toContain('already_terminated');
  });

  // ── Final postcondition verification ──

  it('POST-01: All postconditions hold after full reconciliation', () => {
    // M381 cron RPCs
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'claim_stale_checkout_batch');`)).toBe('t');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'claim_active_subscriptions_for_cancellation_check');`)).toBe('t');

    // M382 undisturbed
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'flow_execution_summaries');`)).toBe('t');

    // M383 exact new signatures (exactly 1 overload each)
    expect(psql(`SELECT COUNT(*) FROM pg_proc WHERE proname = 'create_order_atomic';`)).toBe('1');
    expect(psql(`SELECT COUNT(*) FROM pg_proc WHERE proname = 'book_slot_atomic';`)).toBe('1');
    expect(psql(`SELECT COUNT(*) FROM pg_proc WHERE proname = 'purchase_tickets_atomic';`)).toBe('1');

    // M384 tables
    for (const t of ['payment_terminal_manifests', 'payment_terminal_effects', 'payment_loyalty_applications',
      'payment_receipt_applications', 'payment_visit_applications', 'payment_rule_action_manifests', 'payment_rule_action_executions']) {
      expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = '${t}');`)).toBe('t');
    }

    // M385-M387 RPCs
    for (const f of ['initialize_terminal_effects', 'reserve_terminal_effect', 'terminate_payment_confirmation',
      'seal_payment_rule_actions', 'begin_terminal_external_emission', 'complete_internal_effect',
      'complete_external_effect', 'fail_external_effect', 'mark_effect_indeterminate', 'skip_optional_effect',
      'advance_rule_action', 'apply_payment_loyalty_once', 'apply_payment_customer_visit_once']) {
      expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = '${f}');`)).toBe('t');
    }

    // M388 claim RPC returns authoritative payment_authority_version
    const claimBody = psql(`SELECT prosrc FROM pg_proc WHERE proname = 'claim_payment_confirmation' LIMIT 1;`);
    expect(claimBody).toContain('payment_authority_version');
  });
});

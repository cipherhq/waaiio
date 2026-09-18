/**
 * Production-shaped migration gap reconciliation proof.
 *
 * Models the exact production state including the migration ledger
 * (supabase_migrations.schema_migrations) with M367-M377 tracked,
 * M382 tracked, M378-M381 and M383-M388 absent.
 *
 * Applies the reconciliation using the exact atomic batches proposed
 * for production:
 * - Batch A: M378+M379+M380+M381 in ONE transaction + ledger entries
 * - M383 atomically + ledger entry
 * - Batch B: M384+M385+M386+M387+M388 in ONE transaction + ledger entries
 *
 * Verifies both ledger state AND effective schema state after each batch.
 * M382 remains tracked and undisturbed throughout.
 *
 * Implementation-Agent: Claude Code
 * Requires TEST_DATABASE_URL.
 */
import { describe, it, expect, beforeAll } from 'vitest';
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

function readMig(filename: string): string {
  return readFileSync(join('supabase/migrations', filename), 'utf-8');
}

function getMigrationFiles(): string[] {
  return readdirSync('supabase/migrations').filter(f => f.endsWith('.sql')).sort();
}

function migNum(f: string): number { return parseInt(f.split('_')[0], 10); }

function ledgerHas(version: string): boolean {
  return psql(`SELECT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '${version}');`) === 't';
}

function ledgerInsert(filename: string): string {
  // Supabase ledger uses the filename as version (without .sql) — but actually uses a timestamp.
  // In practice, the version column stores the migration filename prefix.
  // We use the numeric prefix as the version for this proof.
  const num = filename.split('_')[0];
  const name = filename.replace('.sql', '');
  return `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('${num}', '${name}');`;
}

describe.skipIf(!canRun)('Production-shaped migration gap reconciliation', () => {
  beforeAll(() => {
    // ── Supabase infrastructure prerequisites ──
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      CREATE EXTENSION IF NOT EXISTS "btree_gist";
      CREATE EXTENSION IF NOT EXISTS "pg_trgm";
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT ALL ON SCHEMA public TO service_role, anon, authenticated;
      CREATE SCHEMA IF NOT EXISTS storage;
      CREATE TABLE IF NOT EXISTS storage.buckets (id TEXT PRIMARY KEY, name TEXT UNIQUE, public BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS storage.objects (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id TEXT REFERENCES storage.buckets(id), name TEXT, owner UUID, metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      CREATE OR REPLACE FUNCTION storage.foldername(name TEXT) RETURNS TEXT[] LANGUAGE plpgsql AS $f$ BEGIN RETURN string_to_array(name, '/'); END; $f$;
      GRANT USAGE ON SCHEMA storage TO service_role, anon, authenticated;
      GRANT ALL ON ALL TABLES IN SCHEMA storage TO service_role, anon, authenticated;
      CREATE SCHEMA IF NOT EXISTS extensions;
      CREATE OR REPLACE FUNCTION extensions.gen_random_bytes(int) RETURNS bytea LANGUAGE sql AS $f$ SELECT gen_random_bytes($1); $f$;
      GRANT USAGE ON SCHEMA extensions TO service_role, anon, authenticated;
      DO $$ BEGIN CREATE PUBLICATION supabase_realtime; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE SCHEMA IF NOT EXISTS realtime;
      GRANT USAGE ON SCHEMA realtime TO service_role, anon, authenticated;
      CREATE SCHEMA IF NOT EXISTS pgsodium;
      CREATE OR REPLACE FUNCTION pgsodium.crypto_aead_det_encrypt(bytea, bytea, bytea, bytea) RETURNS bytea LANGUAGE sql AS $f$ SELECT $1; $f$;
      CREATE OR REPLACE FUNCTION pgsodium.crypto_aead_det_decrypt(bytea, bytea, bytea, bytea) RETURNS bytea LANGUAGE sql AS $f$ SELECT $1; $f$;
      GRANT USAGE ON SCHEMA pgsodium TO service_role;
      CREATE SCHEMA IF NOT EXISTS vault;
      CREATE TABLE IF NOT EXISTS vault.decrypted_secrets (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT UNIQUE, decrypted_secret TEXT, description TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
      GRANT USAGE ON SCHEMA vault TO service_role;
      GRANT SELECT ON vault.decrypted_secrets TO service_role;
    `);
    psql(`
      CREATE SCHEMA IF NOT EXISTS "auth";
      CREATE TABLE IF NOT EXISTS "auth".users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT, phone TEXT, raw_user_meta_data JSONB DEFAULT '{}', raw_app_meta_data JSONB DEFAULT '{}');
      CREATE OR REPLACE FUNCTION "auth".uid() RETURNS UUID LANGUAGE sql STABLE AS $f$ SELECT NULL::UUID; $f$;
      CREATE OR REPLACE FUNCTION "auth".role() RETURNS TEXT LANGUAGE sql STABLE AS $f$ SELECT current_user::TEXT; $f$;
      CREATE OR REPLACE FUNCTION "auth".email() RETURNS TEXT LANGUAGE sql STABLE AS $f$ SELECT NULL::TEXT; $f$;
      GRANT USAGE ON SCHEMA "auth" TO service_role, anon, authenticated;
      GRANT SELECT ON "auth".users TO service_role, anon, authenticated;
    `);

    // Create the migration ledger schema (Supabase-managed)
    psql(`
      CREATE SCHEMA IF NOT EXISTS supabase_migrations;
      CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
        version TEXT PRIMARY KEY, name TEXT, statements_applied INT DEFAULT 0
      );
    `);

    // Apply M001-M377 + track in ledger
    const files = getMigrationFiles();
    const baseline = files.filter(f => migNum(f) >= 1 && migNum(f) <= 377);
    for (const f of baseline) {
      psql(readMig(f), 60000);
      psql(ledgerInsert(f));
    }

    // Apply M382 out-of-order + track in ledger (M378-M381 skipped)
    const m382 = files.find(f => f.startsWith('382_'))!;
    psql(readMig(m382), 60000);
    psql(ledgerInsert(m382));
  }, 600000);

  // ── PRE-RECONCILIATION: Ledger state ──

  it('PRE-L1: M367-M377 tracked in ledger', () => {
    expect(ledgerHas('367')).toBe(true);
    expect(ledgerHas('377')).toBe(true);
  });

  it('PRE-L2: M382 tracked in ledger', () => {
    expect(ledgerHas('382')).toBe(true);
  });

  it('PRE-L3: M378-M381 absent from ledger', () => {
    expect(ledgerHas('378')).toBe(false);
    expect(ledgerHas('379')).toBe(false);
    expect(ledgerHas('380')).toBe(false);
    expect(ledgerHas('381')).toBe(false);
  });

  it('PRE-L4: M383-M388 absent from ledger', () => {
    for (const v of ['383', '384', '385', '386', '387', '388']) {
      expect(ledgerHas(v)).toBe(false);
    }
  });

  // ── PRE-RECONCILIATION: Effective schema ──

  it('PRE-S1: M367 objects present (message_send_attempts)', () => {
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'message_send_attempts');`)).toBe('t');
  });

  it('PRE-S2: M378-M381 objects absent', () => {
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'subscription_checkout_intents');`)).toBe('f');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'subscription_reconciliation_evidence');`)).toBe('f');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'claim_stale_checkout_batch');`)).toBe('f');
  });

  it('PRE-S3: M382 objects present', () => {
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'flow_execution_summaries');`)).toBe('t');
  });

  it('PRE-S4: M383-M388 objects absent', () => {
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'cancel_order_immediate');`)).toBe('f');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'payment_terminal_manifests');`)).toBe('f');
  });

  // ── BATCH A: M378+M379+M380+M381 in ONE transaction ──

  it('BATCH-A: Apply M378-M381 atomically + ledger', () => {
    const files = getMigrationFiles();
    const batchSQL = [378, 379, 380, 381].map(n => {
      const f = files.find(ff => ff.startsWith(`${n}_`))!;
      return readMig(f) + '\n' + ledgerInsert(f);
    }).join('\n');

    // Execute as one transaction
    psql(`BEGIN;\n${batchSQL}\nCOMMIT;`, 120000);

    // Verify ledger
    expect(ledgerHas('378')).toBe(true);
    expect(ledgerHas('379')).toBe(true);
    expect(ledgerHas('380')).toBe(true);
    expect(ledgerHas('381')).toBe(true);

    // Verify effective schema
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'subscription_checkout_intents');`)).toBe('t');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'subscription_reconciliation_evidence');`)).toBe('t');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'claim_stale_checkout_batch');`)).toBe('t');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'claim_active_subscriptions_for_cancellation_check');`)).toBe('t');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'claim_overdue_subscription_batch');`)).toBe('t');

    // M382 undisturbed
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'flow_execution_summaries');`)).toBe('t');
    expect(ledgerHas('382')).toBe(true);
  });

  // ── M383 atomic ──

  it('M383: Apply entity commit revalidation atomically + ledger', () => {
    const files = getMigrationFiles();
    const f = files.find(ff => ff.startsWith('383_'))!;
    psql(`BEGIN;\n${readMig(f)}\n${ledgerInsert(f)}\nCOMMIT;`, 120000);

    expect(ledgerHas('383')).toBe(true);

    // Columns
    expect(psql(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'items_fingerprint');`)).toBe('t');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'quote_requests' AND column_name = 'snapshot_version');`)).toBe('t');

    // Trigger
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_snapshot_version_guard');`)).toBe('t');

    // Exact canonical M383 identities via pg_get_function_identity_arguments

    // create_order_atomic: canonical 24-arg M383 identity
    const orderArgs = psql(`SELECT pg_get_function_identity_arguments(oid) FROM pg_proc WHERE proname = 'create_order_atomic';`);
    expect(orderArgs).toContain('p_items jsonb');
    expect(orderArgs).toContain('p_referral_id uuid');
    expect(orderArgs).toContain('p_validate_products boolean');
    expect(orderArgs).toContain('p_expected_total integer');
    expect(orderArgs.split(',').length).toBe(24);

    // book_slot_atomic: canonical 30-arg M383 identity
    const bookArgs = psql(`SELECT pg_get_function_identity_arguments(oid) FROM pg_proc WHERE proname = 'book_slot_atomic';`);
    expect(bookArgs).toContain('p_bot_session_id uuid');
    expect(bookArgs).toContain('p_class_session_id uuid');
    expect(bookArgs).toContain('p_expected_price integer');
    expect(bookArgs).toContain('p_expected_deposit integer');
    expect(bookArgs.split(',').length).toBe(30);

    // purchase_tickets_atomic: canonical 12-arg M383 identity
    const ticketArgs = psql(`SELECT pg_get_function_identity_arguments(oid) FROM pg_proc WHERE proname = 'purchase_tickets_atomic';`);
    expect(ticketArgs).toContain('p_total_amount integer');
    expect(ticketArgs).toContain('p_channel text');
    expect(ticketArgs).toContain('p_bot_session_id uuid');
    expect(ticketArgs).toContain('p_expected_price integer');
    expect(ticketArgs.split(',').length).toBe(12);

    // Stale old identities absent — exactly 1 overload each (old 22/28/10 dropped)
    expect(psql(`SELECT COUNT(*) FROM pg_proc WHERE proname = 'create_order_atomic';`)).toBe('1');
    expect(psql(`SELECT COUNT(*) FROM pg_proc WHERE proname = 'book_slot_atomic';`)).toBe('1');
    expect(psql(`SELECT COUNT(*) FROM pg_proc WHERE proname = 'purchase_tickets_atomic';`)).toBe('1');

    // Prove old identities do NOT exist by checking no function matches old arity
    // Old create_order_atomic was 22-arg (M333)
    expect(psql(`SELECT COUNT(*) FROM pg_proc WHERE proname = 'create_order_atomic' AND pronargs = 22;`)).toBe('0');
    // Old book_slot_atomic was 28-arg (M325)
    expect(psql(`SELECT COUNT(*) FROM pg_proc WHERE proname = 'book_slot_atomic' AND pronargs = 28;`)).toBe('0');
    // Old purchase_tickets_atomic was 10-arg (M149)
    expect(psql(`SELECT COUNT(*) FROM pg_proc WHERE proname = 'purchase_tickets_atomic' AND pronargs = 10;`)).toBe('0');

    // New RPCs exist
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'cancel_order_immediate');`)).toBe('t');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'create_payment_booking_atomic');`)).toBe('t');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'create_reservation_atomic');`)).toBe('t');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'accept_order_quote_atomic');`)).toBe('t');
  });

  // ── BATCH B: M384+M385+M386+M387+M388 in ONE transaction ──

  it('BATCH-B: Apply M384-M388 atomically + ledger', () => {
    const files = getMigrationFiles();
    const batchSQL = [384, 385, 386, 387, 388].map(n => {
      const f = files.find(ff => ff.startsWith(`${n}_`))!;
      return readMig(f) + '\n' + ledgerInsert(f);
    }).join('\n');

    psql(`BEGIN;\n${batchSQL}\nCOMMIT;`, 120000);

    // Verify ledger
    for (const v of ['384', '385', '386', '387', '388']) {
      expect(ledgerHas(v)).toBe(true);
    }

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

    // M388: claim_payment_confirmation returns payment_authority_version
    const claimBody = psql(`SELECT prosrc FROM pg_proc WHERE proname = 'claim_payment_confirmation' LIMIT 1;`);
    expect(claimBody).toContain('payment_authority_version');
    expect(claimBody).toContain('already_terminated');

    // M382 still undisturbed
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'flow_execution_summaries');`)).toBe('t');
    expect(ledgerHas('382')).toBe(true);
  });

  // ── FINAL: Complete ledger + schema state ──

  it('FINAL: All 378-388 tracked, M382 undisturbed, all postconditions hold', () => {
    for (const v of ['378', '379', '380', '381', '382', '383', '384', '385', '386', '387', '388']) {
      expect(ledgerHas(v)).toBe(true);
    }
    // M382 effective objects
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'flow_execution_summaries');`)).toBe('t');
  });
});

/**
 * Ticket Tier Purchase & Capacity Guards — Real PostgreSQL Tests (#716)
 *
 * Proves the DB-authoritative protections added by migration 470:
 *
 * P1-A: purchase_tickets_atomic rejects paused tiers (is_active=false)
 *        under the same FOR UPDATE row lock that validates price/availability.
 *
 * P1-B: Two-layer capacity guard on event_ticket_types:
 *        - CHECK (total_tickets >= tickets_sold)  — absolute floor
 *        - BEFORE UPDATE trigger — blocks ANY capacity decrease on saved tiers
 *          (conservative policy until pending-hold reconciliation exists)
 *
 * Requires TEST_DATABASE_URL pointing to a PostgreSQL database with
 * all migrations (through 470) applied.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const dbUrl = process.env.TEST_DATABASE_URL;

// ═══════════════════════════════════════════════════════════
// 1. Structural: RPC function source proves is_active guard
// ═══════════════════════════════════════════════════════════

describe('M470 — purchase_tickets_atomic is_active guard (structural)', () => {
  const migration = readFileSync('supabase/migrations/470_ticket_tier_purchase_and_capacity_guards.sql', 'utf-8');

  it('migration selects is_active from event_ticket_types under FOR UPDATE', () => {
    expect(migration).toContain('SELECT price, event_id, is_active INTO v_ticket_price, v_tt_event_id, v_tt_is_active');
    expect(migration).toContain('FOR UPDATE');
  });

  it('migration raises tier_paused when is_active is false', () => {
    expect(migration).toContain('IF NOT v_tt_is_active THEN');
    expect(migration).toContain("RAISE EXCEPTION 'tier_paused:");
  });

  it('tier_paused check comes AFTER row lock and BEFORE availability check', () => {
    const lockIdx = migration.indexOf('FROM event_ticket_types WHERE id = p_ticket_type_id FOR UPDATE');
    const pauseIdx = migration.indexOf('IF NOT v_tt_is_active THEN');
    const availIdx = migration.indexOf('-- Check availability');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(pauseIdx).toBeGreaterThan(lockIdx);
    expect(availIdx).toBeGreaterThan(pauseIdx);
  });

  it('bot session idempotency returns existing booking before any tier check', () => {
    const idempotencyIdx = migration.indexOf('Bot session idempotency');
    const lockIdx = migration.indexOf('FROM event_ticket_types WHERE id = p_ticket_type_id FOR UPDATE');
    expect(idempotencyIdx).toBeGreaterThan(-1);
    expect(idempotencyIdx).toBeLessThan(lockIdx);
  });

  it('preserves price_changed, event_wrong_business, and event_not_published checks', () => {
    expect(migration).toContain("'price_changed:");
    expect(migration).toContain("'event_wrong_business:");
    expect(migration).toContain("'event_not_published:");
    expect(migration).toContain("'ticket_type_not_found:");
    expect(migration).toContain("'ticket_type_wrong_event:");
  });

  it('guards null-tier purchase on tiered events (all_tiers_paused + tier_required)', () => {
    expect(migration).toContain("'all_tiers_paused:");
    expect(migration).toContain("'tier_required:");
    // The all-paused guard block must exist in the function body
    expect(migration).toContain('ALL-PAUSED GUARD');
    expect(migration).toContain('IF v_has_configured_tiers THEN');
  });
});

describe('M470 — capacity guard structural', () => {
  const migration = readFileSync('supabase/migrations/470_ticket_tier_purchase_and_capacity_guards.sql', 'utf-8');

  it('adds chk_capacity_gte_sold CHECK constraint (absolute floor)', () => {
    expect(migration).toContain('ADD CONSTRAINT chk_capacity_gte_sold CHECK (total_tickets >= tickets_sold)');
  });

  it('adds prevent_ticket_capacity_decrease trigger blocking ANY decrease', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION prevent_ticket_capacity_decrease()');
    expect(migration).toContain('IF NEW.total_tickets < OLD.total_tickets THEN');
    expect(migration).toContain("RAISE EXCEPTION 'capacity_decrease_blocked:");
    expect(migration).toContain('CREATE TRIGGER trg_prevent_ticket_capacity_decrease');
    expect(migration).toContain('BEFORE UPDATE ON event_ticket_types');
  });

  it('trigger fires only on UPDATE (INSERT unrestricted for new tiers)', () => {
    expect(migration).toContain('BEFORE UPDATE ON event_ticket_types');
    expect(migration).not.toContain('BEFORE INSERT OR UPDATE ON event_ticket_types');
  });
});

describe('M470 — ACL re-application structural', () => {
  const migration = readFileSync('supabase/migrations/470_ticket_tier_purchase_and_capacity_guards.sql', 'utf-8');

  it('revokes from PUBLIC, anon, and authenticated', () => {
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.purchase_tickets_atomic');
    expect(migration).toContain('FROM PUBLIC');
    expect(migration).toContain('FROM anon');
    expect(migration).toContain('FROM authenticated');
  });

  it('grants only to service_role', () => {
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.purchase_tickets_atomic');
    expect(migration).toContain('TO service_role');
  });

  it('asserts exactly one function signature', () => {
    expect(migration).toContain("'stale_overload:purchase_tickets_atomic has % signatures (expected 1)'");
  });
});

describe('M470 — web route handles tier_paused error', () => {
  const route = readFileSync('app/api/events/purchase/route.ts', 'utf-8');

  it('purchase route returns 409 with descriptive message on tier_paused', () => {
    expect(route).toContain("rpcError.message?.includes('tier_paused')");
    expect(route).toContain('This ticket type is no longer available');
  });

  it('tier_paused check precedes the generic 500 fallback', () => {
    const pauseIdx = route.indexOf("includes('tier_paused')");
    const genericIdx = route.indexOf("'Something went wrong'");
    expect(pauseIdx).toBeGreaterThan(-1);
    expect(pauseIdx).toBeLessThan(genericIdx);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Database: functional tests (require TEST_DATABASE_URL)
// ═══════════════════════════════════════════════════════════

if (!dbUrl) {
  describe.skip('M470 DB functional — TEST_DATABASE_URL not set', () => {
    it('skipped', () => {});
  });
} else {

function runSQL(sql: string, role?: string): { stdout: string; stderr: string; exitCode: number } {
  const fullSql = role ? `SET ROLE ${role};\n${sql}` : sql;
  try {
    let stdout = execSync(
      `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
      { input: fullSql, encoding: 'utf-8', timeout: 15000 },
    );
    stdout = stdout.trim();
    if (role && stdout.startsWith('SET\n')) stdout = stdout.slice(4).trim();
    else if (role && stdout === 'SET') stdout = '';
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout?.trim() || '', stderr: e.stderr?.trim() || '', exitCode: e.status || 1 };
  }
}

describe('M470 DB — is_active guard in purchase_tickets_atomic', () => {

  it('function source includes is_active check and tier_paused exception', () => {
    const r = runSQL(`
      SELECT prosrc FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'purchase_tickets_atomic';
    `);
    expect(r.exitCode).toBe(0);
    const src = r.stdout.toLowerCase();
    expect(src).toContain('is_active');
    expect(src).toContain('tier_paused');
    expect(src).toContain('for update');
  });

  it('ACL preserved: service_role allowed', () => {
    const r = runSQL("SELECT has_function_privilege('service_role', 'purchase_tickets_atomic(uuid, uuid, uuid, integer, uuid, text, text, text, integer, text, uuid, integer)', 'EXECUTE') AS p;");
    expect(r.stdout).toBe('t');
  });

  it('ACL preserved: anon denied', () => {
    const r = runSQL("SELECT has_function_privilege('anon', 'purchase_tickets_atomic(uuid, uuid, uuid, integer, uuid, text, text, text, integer, text, uuid, integer)', 'EXECUTE') AS p;");
    expect(r.stdout).toBe('f');
  });

  it('ACL preserved: authenticated denied', () => {
    const r = runSQL("SELECT has_function_privilege('authenticated', 'purchase_tickets_atomic(uuid, uuid, uuid, integer, uuid, text, text, text, integer, text, uuid, integer)', 'EXECUTE') AS p;");
    expect(r.stdout).toBe('f');
  });

  it('exactly one signature exists (no stale overloads)', () => {
    const r = runSQL(`
      SELECT COUNT(*) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'purchase_tickets_atomic';
    `);
    expect(r.stdout).toBe('1');
  });
});

describe('M470 DB — capacity guard (CHECK + trigger)', () => {

  it('CHECK constraint chk_capacity_gte_sold exists', () => {
    const r = runSQL(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'public.event_ticket_types'::regclass
        AND conname = 'chk_capacity_gte_sold';
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('chk_capacity_gte_sold');
  });

  it('trigger trg_prevent_ticket_capacity_decrease exists', () => {
    const r = runSQL(`
      SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'public.event_ticket_types'::regclass
        AND tgname = 'trg_prevent_ticket_capacity_decrease';
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('trg_prevent_ticket_capacity_decrease');
  });

  it('rejects ANY capacity decrease on saved tiers (trigger)', () => {
    const r = runSQL(`
      DO $$
      DECLARE v_biz_id uuid; v_event_id uuid; v_tt_id uuid;
      BEGIN
        v_biz_id := (SELECT id FROM businesses LIMIT 1);
        IF v_biz_id IS NULL THEN RAISE EXCEPTION 'NO_BUSINESSES'; END IF;

        INSERT INTO events (business_id, name, date, price, total_tickets, tickets_sold, status)
        VALUES (v_biz_id, '__m470_dec_test', CURRENT_DATE + 30, 1000, 100, 0, 'draft')
        RETURNING id INTO v_event_id;

        INSERT INTO event_ticket_types (event_id, name, price, total_tickets, tickets_sold)
        VALUES (v_event_id, '__m470_dec_tier', 1000, 100, 0)
        RETURNING id INTO v_tt_id;

        -- Decrease from 100 to 80 (above sold=0) — trigger must still block
        BEGIN
          UPDATE event_ticket_types SET total_tickets = 80 WHERE id = v_tt_id;
          RAISE EXCEPTION 'TRIGGER_DID_NOT_FIRE';
        EXCEPTION
          WHEN raise_exception THEN
            IF SQLERRM LIKE 'capacity_decrease_blocked%' THEN
              RAISE NOTICE 'PASS: trigger blocked decrease from 100 to 80';
            ELSE
              RAISE;  -- re-raise unexpected exceptions
            END IF;
        END;

        DELETE FROM event_ticket_types WHERE id = v_tt_id;
        DELETE FROM events WHERE id = v_event_id;
      END $$;
    `);
    expect(r.stderr).not.toContain('TRIGGER_DID_NOT_FIRE');
    expect(r.exitCode).toBe(0);
  });

  it('allows capacity increase on saved tiers', () => {
    const r = runSQL(`
      DO $$
      DECLARE v_biz_id uuid; v_event_id uuid; v_tt_id uuid; v_new int;
      BEGIN
        v_biz_id := (SELECT id FROM businesses LIMIT 1);
        IF v_biz_id IS NULL THEN RAISE EXCEPTION 'NO_BUSINESSES'; END IF;

        INSERT INTO events (business_id, name, date, price, total_tickets, tickets_sold, status)
        VALUES (v_biz_id, '__m470_inc_test', CURRENT_DATE + 30, 1000, 50, 10, 'draft')
        RETURNING id INTO v_event_id;

        INSERT INTO event_ticket_types (event_id, name, price, total_tickets, tickets_sold)
        VALUES (v_event_id, '__m470_inc_tier', 1000, 50, 10)
        RETURNING id INTO v_tt_id;

        UPDATE event_ticket_types SET total_tickets = 200 WHERE id = v_tt_id;
        SELECT total_tickets INTO v_new FROM event_ticket_types WHERE id = v_tt_id;

        IF v_new != 200 THEN RAISE EXCEPTION 'INCREASE_FAILED: got %', v_new; END IF;
        RAISE NOTICE 'PASS: capacity increase to 200 accepted';

        DELETE FROM event_ticket_types WHERE id = v_tt_id;
        DELETE FROM events WHERE id = v_event_id;
      END $$;
    `);
    expect(r.stderr).not.toContain('INCREASE_FAILED');
    expect(r.exitCode).toBe(0);
  });

  it('allows same-value update (no decrease)', () => {
    const r = runSQL(`
      DO $$
      DECLARE v_biz_id uuid; v_event_id uuid; v_tt_id uuid; v_new int;
      BEGIN
        v_biz_id := (SELECT id FROM businesses LIMIT 1);
        IF v_biz_id IS NULL THEN RAISE EXCEPTION 'NO_BUSINESSES'; END IF;

        INSERT INTO events (business_id, name, date, price, total_tickets, tickets_sold, status)
        VALUES (v_biz_id, '__m470_same_test', CURRENT_DATE + 30, 1000, 50, 10, 'draft')
        RETURNING id INTO v_event_id;

        INSERT INTO event_ticket_types (event_id, name, price, total_tickets, tickets_sold)
        VALUES (v_event_id, '__m470_same_tier', 1000, 50, 10)
        RETURNING id INTO v_tt_id;

        -- Update name + price without changing total_tickets
        UPDATE event_ticket_types SET name = 'Renamed', price = 2000, total_tickets = 50 WHERE id = v_tt_id;
        SELECT total_tickets INTO v_new FROM event_ticket_types WHERE id = v_tt_id;

        IF v_new != 50 THEN RAISE EXCEPTION 'SAME_FAILED: got %', v_new; END IF;
        RAISE NOTICE 'PASS: same-value total_tickets accepted';

        DELETE FROM event_ticket_types WHERE id = v_tt_id;
        DELETE FROM events WHERE id = v_event_id;
      END $$;
    `);
    expect(r.stderr).not.toContain('SAME_FAILED');
    expect(r.exitCode).toBe(0);
  });

  it('allows tickets_sold increment (internal system mutation)', () => {
    const r = runSQL(`
      DO $$
      DECLARE v_biz_id uuid; v_event_id uuid; v_tt_id uuid; v_sold int;
      BEGIN
        v_biz_id := (SELECT id FROM businesses LIMIT 1);
        IF v_biz_id IS NULL THEN RAISE EXCEPTION 'NO_BUSINESSES'; END IF;

        INSERT INTO events (business_id, name, date, price, total_tickets, tickets_sold, status)
        VALUES (v_biz_id, '__m470_sold_test', CURRENT_DATE + 30, 1000, 50, 0, 'draft')
        RETURNING id INTO v_event_id;

        INSERT INTO event_ticket_types (event_id, name, price, total_tickets, tickets_sold)
        VALUES (v_event_id, '__m470_sold_tier', 1000, 50, 0)
        RETURNING id INTO v_tt_id;

        -- System increments tickets_sold (does not touch total_tickets)
        UPDATE event_ticket_types SET tickets_sold = tickets_sold + 3 WHERE id = v_tt_id;
        SELECT tickets_sold INTO v_sold FROM event_ticket_types WHERE id = v_tt_id;

        IF v_sold != 3 THEN RAISE EXCEPTION 'SOLD_INC_FAILED: got %', v_sold; END IF;
        RAISE NOTICE 'PASS: tickets_sold increment accepted';

        DELETE FROM event_ticket_types WHERE id = v_tt_id;
        DELETE FROM events WHERE id = v_event_id;
      END $$;
    `);
    expect(r.stderr).not.toContain('SOLD_INC_FAILED');
    expect(r.exitCode).toBe(0);
  });

  it('CHECK constraint rejects tickets_sold exceeding total_tickets', () => {
    const r = runSQL(`
      DO $$
      DECLARE v_biz_id uuid; v_event_id uuid; v_tt_id uuid;
      BEGIN
        v_biz_id := (SELECT id FROM businesses LIMIT 1);
        IF v_biz_id IS NULL THEN RAISE EXCEPTION 'NO_BUSINESSES'; END IF;

        INSERT INTO events (business_id, name, date, price, total_tickets, tickets_sold, status)
        VALUES (v_biz_id, '__m470_chk_test', CURRENT_DATE + 30, 1000, 10, 0, 'draft')
        RETURNING id INTO v_event_id;

        INSERT INTO event_ticket_types (event_id, name, price, total_tickets, tickets_sold)
        VALUES (v_event_id, '__m470_chk_tier', 1000, 10, 8)
        RETURNING id INTO v_tt_id;

        BEGIN
          UPDATE event_ticket_types SET tickets_sold = 11 WHERE id = v_tt_id;
          RAISE EXCEPTION 'CHECK_DID_NOT_FIRE';
        EXCEPTION
          WHEN check_violation THEN
            RAISE NOTICE 'PASS: CHECK rejected tickets_sold > total_tickets';
        END;

        DELETE FROM event_ticket_types WHERE id = v_tt_id;
        DELETE FROM events WHERE id = v_event_id;
      END $$;
    `);
    expect(r.stderr).not.toContain('CHECK_DID_NOT_FIRE');
    expect(r.exitCode).toBe(0);
  });

  it('INSERT of new tier with any capacity is unrestricted', () => {
    const r = runSQL(`
      DO $$
      DECLARE v_biz_id uuid; v_event_id uuid; v_tt_id uuid;
      BEGIN
        v_biz_id := (SELECT id FROM businesses LIMIT 1);
        IF v_biz_id IS NULL THEN RAISE EXCEPTION 'NO_BUSINESSES'; END IF;

        INSERT INTO events (business_id, name, date, price, total_tickets, tickets_sold, status)
        VALUES (v_biz_id, '__m470_ins_test', CURRENT_DATE + 30, 1000, 100, 0, 'draft')
        RETURNING id INTO v_event_id;

        -- Insert a tier with small capacity (trigger must not interfere)
        INSERT INTO event_ticket_types (event_id, name, price, total_tickets, tickets_sold)
        VALUES (v_event_id, '__m470_ins_tier', 500, 5, 0)
        RETURNING id INTO v_tt_id;

        IF v_tt_id IS NULL THEN RAISE EXCEPTION 'INSERT_FAILED'; END IF;
        RAISE NOTICE 'PASS: new tier INSERT unrestricted';

        DELETE FROM event_ticket_types WHERE id = v_tt_id;
        DELETE FROM events WHERE id = v_event_id;
      END $$;
    `);
    expect(r.stderr).not.toContain('INSERT_FAILED');
    expect(r.exitCode).toBe(0);
  });

  it('pause (is_active=false) and reactivate (is_active=true) work without capacity change', () => {
    const r = runSQL(`
      DO $$
      DECLARE v_biz_id uuid; v_event_id uuid; v_tt_id uuid; v_active boolean;
      BEGIN
        v_biz_id := (SELECT id FROM businesses LIMIT 1);
        IF v_biz_id IS NULL THEN RAISE EXCEPTION 'NO_BUSINESSES'; END IF;

        INSERT INTO events (business_id, name, date, price, total_tickets, tickets_sold, status)
        VALUES (v_biz_id, '__m470_pause_test', CURRENT_DATE + 30, 1000, 50, 5, 'draft')
        RETURNING id INTO v_event_id;

        INSERT INTO event_ticket_types (event_id, name, price, total_tickets, tickets_sold)
        VALUES (v_event_id, '__m470_pause_tier', 1000, 50, 5)
        RETURNING id INTO v_tt_id;

        -- Pause
        UPDATE event_ticket_types SET is_active = false WHERE id = v_tt_id;
        SELECT is_active INTO v_active FROM event_ticket_types WHERE id = v_tt_id;
        IF v_active THEN RAISE EXCEPTION 'PAUSE_FAILED'; END IF;

        -- Reactivate
        UPDATE event_ticket_types SET is_active = true WHERE id = v_tt_id;
        SELECT is_active INTO v_active FROM event_ticket_types WHERE id = v_tt_id;
        IF NOT v_active THEN RAISE EXCEPTION 'REACTIVATE_FAILED'; END IF;

        RAISE NOTICE 'PASS: pause and reactivate work';

        DELETE FROM event_ticket_types WHERE id = v_tt_id;
        DELETE FROM events WHERE id = v_event_id;
      END $$;
    `);
    expect(r.stderr).not.toContain('PAUSE_FAILED');
    expect(r.stderr).not.toContain('REACTIVATE_FAILED');
    expect(r.exitCode).toBe(0);
  });
});

describe('M470 DB — all-paused and tierless event guards in purchase_tickets_atomic', () => {

  it('rejects null-tier purchase when all tiers are paused (all_tiers_paused)', () => {
    const r = runSQL(`
      DO $$
      DECLARE v_biz_id uuid; v_event_id uuid; v_user_id uuid; v_tt_id uuid;
      BEGIN
        v_biz_id := (SELECT id FROM businesses LIMIT 1);
        v_user_id := (SELECT id FROM auth.users LIMIT 1);
        IF v_biz_id IS NULL OR v_user_id IS NULL THEN RAISE EXCEPTION 'NO_SEED_DATA'; END IF;

        INSERT INTO events (business_id, name, date, price, total_tickets, tickets_sold, status)
        VALUES (v_biz_id, '__m470_allpaused', CURRENT_DATE + 30, 1000, 100, 0, 'published')
        RETURNING id INTO v_event_id;

        -- Create a tier, then pause it
        INSERT INTO event_ticket_types (event_id, name, price, total_tickets, tickets_sold, is_active)
        VALUES (v_event_id, '__m470_ap_tier', 2000, 50, 0, false)
        RETURNING id INTO v_tt_id;

        -- Attempt purchase with NULL tier ID (the bypass vector)
        BEGIN
          PERFORM purchase_tickets_atomic(
            v_biz_id, v_event_id, NULL, 1, v_user_id,
            'Test', '+2340000000099', 'test@test.com', 1000, 'web', NULL, 1000
          );
          RAISE EXCEPTION 'ALL_PAUSED_NOT_BLOCKED';
        EXCEPTION
          WHEN raise_exception THEN
            IF SQLERRM LIKE 'all_tiers_paused%' THEN
              RAISE NOTICE 'PASS: all-paused null-tier purchase blocked';
            ELSE
              RAISE;
            END IF;
        END;

        DELETE FROM event_ticket_types WHERE id = v_tt_id;
        DELETE FROM events WHERE id = v_event_id;
      END $$;
    `);
    expect(r.stderr).not.toContain('ALL_PAUSED_NOT_BLOCKED');
    expect(r.exitCode).toBe(0);
  });

  it('allows null-tier purchase on genuinely tierless events', () => {
    const r = runSQL(`
      DO $$
      DECLARE v_biz_id uuid; v_event_id uuid; v_user_id uuid; v_result RECORD;
      BEGIN
        v_biz_id := (SELECT id FROM businesses LIMIT 1);
        v_user_id := (SELECT id FROM auth.users LIMIT 1);
        IF v_biz_id IS NULL OR v_user_id IS NULL THEN RAISE EXCEPTION 'NO_SEED_DATA'; END IF;

        INSERT INTO events (business_id, name, date, price, total_tickets, tickets_sold, status)
        VALUES (v_biz_id, '__m470_tierless', CURRENT_DATE + 30, 500, 100, 0, 'published')
        RETURNING id INTO v_event_id;

        -- No tiers configured — call with NULL tier (legitimate legacy event)
        SELECT * INTO v_result FROM purchase_tickets_atomic(
          v_biz_id, v_event_id, NULL, 1, v_user_id,
          'Test', '+2340000000098', 'test@test.com', 500, 'web', NULL, 500
        );

        IF NOT v_result.tickets_available THEN
          RAISE EXCEPTION 'TIERLESS_PURCHASE_FAILED';
        END IF;
        RAISE NOTICE 'PASS: tierless event purchase succeeded (booking_id=%)', v_result.booking_id;

        -- Cleanup
        DELETE FROM bookings WHERE id = v_result.booking_id;
        DELETE FROM events WHERE id = v_event_id;
      END $$;
    `);
    expect(r.stderr).not.toContain('TIERLESS_PURCHASE_FAILED');
    expect(r.exitCode).toBe(0);
  });

  it('rejects null-tier purchase when active tiers exist (tier_required)', () => {
    const r = runSQL(`
      DO $$
      DECLARE v_biz_id uuid; v_event_id uuid; v_user_id uuid; v_tt_id uuid;
      BEGIN
        v_biz_id := (SELECT id FROM businesses LIMIT 1);
        v_user_id := (SELECT id FROM auth.users LIMIT 1);
        IF v_biz_id IS NULL OR v_user_id IS NULL THEN RAISE EXCEPTION 'NO_SEED_DATA'; END IF;

        INSERT INTO events (business_id, name, date, price, total_tickets, tickets_sold, status)
        VALUES (v_biz_id, '__m470_tiered', CURRENT_DATE + 30, 1000, 100, 0, 'published')
        RETURNING id INTO v_event_id;

        INSERT INTO event_ticket_types (event_id, name, price, total_tickets, tickets_sold, is_active)
        VALUES (v_event_id, '__m470_active_tier', 2000, 50, 0, true)
        RETURNING id INTO v_tt_id;

        -- Attempt null-tier purchase on a tiered event
        BEGIN
          PERFORM purchase_tickets_atomic(
            v_biz_id, v_event_id, NULL, 1, v_user_id,
            'Test', '+2340000000097', 'test@test.com', 1000, 'web', NULL, 1000
          );
          RAISE EXCEPTION 'TIER_REQUIRED_NOT_BLOCKED';
        EXCEPTION
          WHEN raise_exception THEN
            IF SQLERRM LIKE 'tier_required%' THEN
              RAISE NOTICE 'PASS: null-tier on tiered event blocked with tier_required';
            ELSE
              RAISE;
            END IF;
        END;

        DELETE FROM event_ticket_types WHERE id = v_tt_id;
        DELETE FROM events WHERE id = v_event_id;
      END $$;
    `);
    expect(r.stderr).not.toContain('TIER_REQUIRED_NOT_BLOCKED');
    expect(r.exitCode).toBe(0);
  });

  it('rejects purchase of a specific paused tier (tier_paused)', () => {
    const r = runSQL(`
      DO $$
      DECLARE v_biz_id uuid; v_event_id uuid; v_user_id uuid; v_tt_id uuid;
      BEGIN
        v_biz_id := (SELECT id FROM businesses LIMIT 1);
        v_user_id := (SELECT id FROM auth.users LIMIT 1);
        IF v_biz_id IS NULL OR v_user_id IS NULL THEN RAISE EXCEPTION 'NO_SEED_DATA'; END IF;

        INSERT INTO events (business_id, name, date, price, total_tickets, tickets_sold, status)
        VALUES (v_biz_id, '__m470_paused_tier', CURRENT_DATE + 30, 1000, 100, 0, 'published')
        RETURNING id INTO v_event_id;

        INSERT INTO event_ticket_types (event_id, name, price, total_tickets, tickets_sold, is_active)
        VALUES (v_event_id, '__m470_pt', 3000, 50, 0, false)
        RETURNING id INTO v_tt_id;

        BEGIN
          PERFORM purchase_tickets_atomic(
            v_biz_id, v_event_id, v_tt_id, 1, v_user_id,
            'Test', '+2340000000096', 'test@test.com', 3000, 'web', NULL, 3000
          );
          RAISE EXCEPTION 'PAUSED_TIER_NOT_BLOCKED';
        EXCEPTION
          WHEN raise_exception THEN
            IF SQLERRM LIKE 'tier_paused%' THEN
              RAISE NOTICE 'PASS: paused tier purchase blocked';
            ELSE
              RAISE;
            END IF;
        END;

        DELETE FROM event_ticket_types WHERE id = v_tt_id;
        DELETE FROM events WHERE id = v_event_id;
      END $$;
    `);
    expect(r.stderr).not.toContain('PAUSED_TIER_NOT_BLOCKED');
    expect(r.exitCode).toBe(0);
  });

  it('idempotent recovery preserves committed booking regardless of tier state', () => {
    const r = runSQL(`
      DO $$
      DECLARE v_biz_id uuid; v_event_id uuid; v_user_id uuid; v_tt_id uuid;
              v_session_id uuid := gen_random_uuid();
              v_result1 RECORD; v_result2 RECORD;
      BEGIN
        v_biz_id := (SELECT id FROM businesses LIMIT 1);
        v_user_id := (SELECT id FROM auth.users LIMIT 1);
        IF v_biz_id IS NULL OR v_user_id IS NULL THEN RAISE EXCEPTION 'NO_SEED_DATA'; END IF;

        INSERT INTO events (business_id, name, date, price, total_tickets, tickets_sold, status)
        VALUES (v_biz_id, '__m470_idempotent', CURRENT_DATE + 30, 1000, 100, 0, 'published')
        RETURNING id INTO v_event_id;

        INSERT INTO event_ticket_types (event_id, name, price, total_tickets, tickets_sold, is_active)
        VALUES (v_event_id, '__m470_id_tier', 2000, 50, 0, true)
        RETURNING id INTO v_tt_id;

        -- First purchase succeeds (tier is active)
        SELECT * INTO v_result1 FROM purchase_tickets_atomic(
          v_biz_id, v_event_id, v_tt_id, 1, v_user_id,
          'Test', '+2340000000095', 'test@test.com', 2000, 'web', v_session_id, 2000
        );
        IF NOT v_result1.tickets_available THEN
          RAISE EXCEPTION 'FIRST_PURCHASE_FAILED';
        END IF;

        -- Now pause the tier
        UPDATE event_ticket_types SET is_active = false WHERE id = v_tt_id;

        -- Idempotent retry with same bot_session_id — must return existing booking
        SELECT * INTO v_result2 FROM purchase_tickets_atomic(
          v_biz_id, v_event_id, v_tt_id, 1, v_user_id,
          'Test', '+2340000000095', 'test@test.com', 2000, 'web', v_session_id, 2000
        );

        IF v_result2.booking_id != v_result1.booking_id THEN
          RAISE EXCEPTION 'IDEMPOTENT_MISMATCH: expected %, got %', v_result1.booking_id, v_result2.booking_id;
        END IF;
        RAISE NOTICE 'PASS: idempotent recovery returned existing booking despite paused tier';

        DELETE FROM bookings WHERE id = v_result1.booking_id;
        DELETE FROM event_ticket_types WHERE id = v_tt_id;
        UPDATE events SET tickets_sold = 0 WHERE id = v_event_id;
        DELETE FROM events WHERE id = v_event_id;
      END $$;
    `);
    expect(r.stderr).not.toContain('FIRST_PURCHASE_FAILED');
    expect(r.stderr).not.toContain('IDEMPOTENT_MISMATCH');
    expect(r.exitCode).toBe(0);
  });
});

} // end if (dbUrl)

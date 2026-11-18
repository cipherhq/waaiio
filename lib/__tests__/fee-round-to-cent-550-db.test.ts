/**
 * M550 — Waaiio fee rounds to the cent/kobo in the database (Owner 2026-11-18).
 * Real PostgreSQL proof against the full migration history (every repo migration,
 * M550 included, applied by scripts/ci-bootstrap-test-db.sh).
 *
 * Runs in CI in "Migration validation (shard b)", step "Migration 550 fee
 * round-to-cent tests". It FAILS, never skips, when TEST_DATABASE_URL is missing.
 *
 * Covered here: catalog attributes after M550, re-building each function from its
 * pre-M550 statement, re-run no-op, fail-closed on unexpected bodies, and the
 * partial-refund fee reduction on both custody routes.
 * The Stripe recurring fee is proved in stripe-recurring-finalization-db.test.ts
 * (case s2) and the merchant-tax v0 fee in lib/tax/__tests__/finance-authority-db.test.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Disposable PostgreSQL required for M550 (TEST_DATABASE_URL)');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');

const m550 = readFileSync('supabase/migrations/550_fee_round_to_cent.sql', 'utf8');

function sql(statement: string): string {
  return execFileSync('psql', [url!, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], {
    input: statement, encoding: 'utf8', timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

const FUNCTIONS = {
  bind: 'public.bind_merchant_tax_fee_980(uuid)',
  stripe: 'public.finalize_stripe_recurring_charge(uuid,text,text,integer,text,text)',
  refund: 'accounting_private.finalize_refund_accounting_modern(uuid)',
} as const;

// The exact pre-M550 statements (M532 bind and refund, M339/M501 Stripe), so a
// transaction can put each function back the way it was before M550.
const REVERT_SQL = `
DO $revert$
DECLARE v_def text;
BEGIN
  v_def := pg_get_functiondef('${FUNCTIONS.bind}'::regprocedure);
  EXECUTE replace(v_def,
    'ELSE fee:=round(round(net*pct*100)/10000+effective_flat,2); /* M550: cent rounding, as v1 (Owner 2026-11-18) */',
    'ELSE fee:=round(net*pct/100)+effective_flat;');
  v_def := pg_get_functiondef('${FUNCTIONS.stripe}'::regprocedure);
  v_def := replace(v_def,
    'v_fee_total := ROUND(ROUND(v_amount * v_fee_pct * 100) / 10000 + v_fee_flat, 2); /* M550: cent rounding, as getPlatformFees (Owner 2026-11-18) */',
    'v_fee_total := ROUND(v_amount * v_fee_pct / 100) + v_fee_flat;');
  v_def := replace(v_def, '-- M550: rounds to the cent, as getPlatformFees (was whole units)',
    '-- Uses ROUND(x) = integer rounding to match Math.round in getPlatformFees');
  EXECUTE replace(v_def, '-- M550: cent rounding (was whole units)', '-- Integer rounding to match Math.round behavior');
  v_def := pg_get_functiondef('${FUNCTIONS.refund}'::regprocedure);
  EXECUTE replace(v_def, E', 2\\n        ); /* M550: cent rounding (Owner 2026-11-18) */', E'\\n        );');
END $revert$;`;

const SNAPSHOT_SQL = `SELECT json_object_agg(sig, json_build_object(
    'body', encode(sha256(convert_to(prosrc,'UTF8')),'hex'), 'marker', prosrc LIKE '%M550: cent rounding%',
    'schema', pronamespace::regnamespace::text, 'secdef', prosecdef, 'config', proconfig,
    'owner', pg_get_userbyid(proowner), 'acl', proacl::text))
  FROM (SELECT oid::regprocedure::text AS sig, * FROM pg_proc WHERE oid IN (
    '${FUNCTIONS.bind}'::regprocedure, '${FUNCTIONS.stripe}'::regprocedure, '${FUNCTIONS.refund}'::regprocedure)) p;`;

type Snapshot = Record<string, { body: string; marker: boolean; schema: string; secdef: boolean; config: string[]; owner: string; acl: string }>;

/** Run statements in one transaction that is always rolled back; return the last snapshot. */
function inRollback(statements: string): Snapshot {
  const out = sql(`BEGIN;\n${statements}\n${SNAPSHOT_SQL}\nROLLBACK;`);
  return JSON.parse(out.split('\n').filter(Boolean).at(-1)!);
}

describe('M550 fee rounds to the cent (real PostgreSQL, full migration history)', () => {
  let after: Snapshot;

  beforeAll(() => {
    after = JSON.parse(sql(SNAPSHOT_SQL));
  });

  it('final state: each function carries the cent statement and keeps schema, SECURITY DEFINER, search_path and grants', () => {
    expect(Object.keys(after).sort()).toEqual([
      'accounting_private.finalize_refund_accounting_modern(uuid)',
      'bind_merchant_tax_fee_980(uuid)',
      'finalize_stripe_recurring_charge(uuid,text,text,integer,text,text)',
    ]);
    const bind = after['bind_merchant_tax_fee_980(uuid)'];
    const stripe = after['finalize_stripe_recurring_charge(uuid,text,text,integer,text,text)'];
    const refund = after['accounting_private.finalize_refund_accounting_modern(uuid)'];
    for (const fn of [bind, stripe, refund]) {
      expect(fn.marker).toBe(true);
      expect(fn.secdef).toBe(true);
    }
    expect([bind.schema, stripe.schema, refund.schema]).toEqual(['public', 'public', 'accounting_private']);
    expect(bind.config).toEqual(['search_path=""']);
    expect(stripe.config).toEqual(['search_path=public']);
    expect(refund.config).toEqual(['search_path=""']);
    const exec = (role: string, sig: string) => sql(`SELECT has_function_privilege('${role}', '${sig}'::regprocedure, 'EXECUTE')`);
    for (const sig of Object.values(FUNCTIONS)) {
      expect(exec('anon', sig)).toBe('f');
      expect(exec('authenticated', sig)).toBe('f');
    }
    expect(exec('service_role', FUNCTIONS.bind)).toBe('t');
    expect(exec('service_role', FUNCTIONS.stripe)).toBe('t');
    expect(exec('service_role', FUNCTIONS.refund)).toBe('f');
    // Whole-unit statements are gone.
    expect(sql(`SELECT count(*) FROM pg_proc WHERE oid IN ('${FUNCTIONS.bind}'::regprocedure, '${FUNCTIONS.stripe}'::regprocedure)
      AND (prosrc ~ 'round\\(net\\*pct/100\\)' OR prosrc ~ 'ROUND\\(v_amount \\* v_fee_pct / 100\\)')`)).toBe('0');
  });

  it('DB-006 payment confirmation RPCs are untouched (search_path = public, extensions)', () => {
    const rows = sql(`SELECT proname || '=' || array_to_string(proconfig, ',') FROM pg_proc
      WHERE proname IN ('initialize_terminal_effects','finalize_payment_confirmation') ORDER BY 1`).split('\n');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toMatch(/=search_path=public, extensions$/);
  });

  it('rebuilds each function from its pre-M550 statement, keeping every other attribute', () => {
    const reverted = inRollback(REVERT_SQL);
    for (const sig of Object.keys(after)) {
      expect(reverted[sig].marker).toBe(false);
      expect(reverted[sig].body).not.toBe(after[sig].body);
    }
    const reapplied = inRollback(`${REVERT_SQL}\n${m550}`);
    expect(reapplied).toEqual(after);
  });

  it('a second run is a no-op', () => {
    expect(inRollback(m550)).toEqual(after);
  });

  it('fails closed when the whole-unit statement is not found exactly once', () => {
    // Pre-M550 body with the ELSE statement duplicated: ambiguous, so M550 must stop.
    const duplicated = `${REVERT_SQL}
      DO $dup$ BEGIN EXECUTE replace(pg_get_functiondef('${FUNCTIONS.bind}'::regprocedure),
        'ELSE fee:=round(net*pct/100)+effective_flat;',
        'ELSE fee:=round(net*pct/100)+effective_flat; IF fee IS NULL THEN NULL; ELSE fee:=round(net*pct/100)+effective_flat; END IF;'); END $dup$;`;
    expect(() => inRollback(`${duplicated}\n${m550}`)).toThrow(/M550: public\.bind_merchant_tax_fee_980\(uuid\) has 2 whole-unit fee statements, expected exactly 1/);
    // Another whole-unit statement of a different shape survives the rewrite: the final check stops it.
    const extra = `${REVERT_SQL}
      DO $extra$ BEGIN EXECUTE replace(pg_get_functiondef('${FUNCTIONS.bind}'::regprocedure),
        'ELSE fee:=round(net*pct/100)+effective_flat;',
        'ELSE fee:=round(net*pct/100)+effective_flat; fee:=round(net*pct/100)+effective_flat;'); END $extra$;`;
    expect(() => inRollback(`${extra}\n${m550}`)).toThrow(/M550: bind_merchant_tax_fee_980 still rounds the fee to whole units/);
    // Pre-M550 body without the statement at all (an unknown lineage).
    const missing = `${REVERT_SQL}
      DO $gone$ BEGIN EXECUTE replace(pg_get_functiondef('${FUNCTIONS.stripe}'::regprocedure),
        'v_fee_total := ROUND(v_amount * v_fee_pct / 100) + v_fee_flat;', 'v_fee_total := 0;'); END $gone$;`;
    expect(() => inRollback(`${missing}\n${m550}`)).toThrow(/finalize_stripe_recurring_charge.* has 0 whole-unit fee statements, expected exactly 1/);
  });

  describe('partial-refund fee reduction is at cent precision on both custody routes', () => {
    const owner = randomUUID();
    const other = randomUUID();

    /** A $50.00 USD payment with a 3% Waaiio fee ($1.50) on the given route. */
    function payment(business: string, isDirectTransfer: boolean) {
      const id = randomUUID();
      const fee = randomUUID();
      sql(`INSERT INTO public.payments (id, business_id, amount, currency, gateway, gateway_reference, status, paid_at)
             VALUES ('${id}', '${business}', 50, 'USD', 'stripe', 'm550-${id}', 'success', now());
           INSERT INTO public.platform_fees (id, business_id, payment_id, is_direct_transfer, transaction_amount, fee_percentage, fee_flat, fee_total, tier)
             VALUES ('${fee}', '${business}', '${id}', ${isDirectTransfer}, 50, 3, 0, 1.50, 'free');`);
      return { id, fee };
    }
    function refund(business: string, paymentId: string, amount: number) {
      const id = randomUUID();
      sql(`INSERT INTO public.refunds (id, payment_id, business_id, amount, status, gateway, refund_type, initiated_by, dispatched_at, gateway_refund_reference)
             VALUES ('${id}', '${paymentId}', '${business}', ${amount}, 'provider_success_unfinalized', 'stripe', 'partial', '${owner}', now(), 'm550-${id}');`);
      return JSON.parse(sql(`SELECT public.finalize_refund_execution('${id}')`));
    }
    const feeOf = (feeId: string) => sql(`SELECT fee_total::text || '|' || (refunded_at IS NOT NULL) FROM public.platform_fees WHERE id = '${feeId}'`);
    const adjustments = (paymentId: string) => sql(`SELECT COALESCE(sum(amount), 0)::text || '|' || count(*) FROM public.payout_adjustments WHERE payment_id = '${paymentId}'`);

    let waaiioHeld: string;
    let merchantConnected: string;

    beforeAll(() => {
      waaiioHeld = randomUUID();
      merchantConnected = randomUUID();
      sql(`ALTER TABLE auth.users DISABLE TRIGGER ALL;
        INSERT INTO auth.users (id) VALUES ('${owner}') ON CONFLICT DO NOTHING;
        ALTER TABLE auth.users ENABLE TRIGGER ALL;
        INSERT INTO public.profiles (id, first_name, last_name, email) VALUES ('${owner}', 'M550', 'Owner', 'm550-${owner}@test.local') ON CONFLICT DO NOTHING;
        INSERT INTO public.businesses (id, owner_id, name, slug, address, city, phone, status, subscription_tier, country_code, payout_mode) VALUES
          ('${waaiioHeld}', '${owner}', 'M550 Waaiio-held', 'm550-held-${waaiioHeld}', '1 St', 'Austin', '+15550000550', 'active', 'free', 'US', 'platform'),
          ('${merchantConnected}', '${owner}', 'M550 connected', 'm550-byo-${merchantConnected}', '1 St', 'Austin', '+15550000551', 'active', 'free', 'US', 'platform'),
          ('${other}', '${owner}', 'M550 other', 'm550-other-${other}', '1 St', 'Austin', '+15550000552', 'active', 'free', 'US', 'platform');
        -- A paid payout covering today, so the Waaiio-held refund is reflected in the merchant balance.
        INSERT INTO public.business_payouts (business_id, period_start, period_end, gross_amount, platform_fee, net_amount, status, currency)
          VALUES ('${waaiioHeld}', CURRENT_DATE - 1, CURRENT_DATE + 1, 50, 1.5, 48.5, 'paid', 'USD');`);
    });

    it('Waaiio-held route: $15.50 of $50 at 3% reduces the fee by $0.47 (was $0), the merchant balance by the refund only', () => {
      const p = payment(waaiioHeld, false);
      const otherBusiness = payment(other, false);

      expect(refund(waaiioHeld, p.id, 15.5)).toMatchObject({ finalized: true, fully_refunded: false });
      expect(feeOf(p.fee)).toBe('1.03|false');
      // Payout adjustment follows the refund amount, not the fee (unchanged by M550).
      expect(adjustments(p.id)).toBe('-15.50|1');

      // Second partial refund: 3% of $10.00 = $0.30 to the cent.
      refund(waaiioHeld, p.id, 10);
      expect(feeOf(p.fee)).toBe('0.73|false');
      expect(adjustments(p.id)).toBe('-25.50|2');

      // Final refund: the fee is reversed completely, as before.
      expect(refund(waaiioHeld, p.id, 24.5)).toMatchObject({ finalized: true, fully_refunded: true });
      expect(feeOf(p.fee)).toBe('0.00|true');

      // Another business's fee is never touched.
      expect(feeOf(otherBusiness.fee)).toBe('1.50|false');
    });

    it('merchant-connected route (byo/connect): same cent reduction, no Waaiio payout adjustment', () => {
      const p = payment(merchantConnected, true);
      expect(refund(merchantConnected, p.id, 15.5)).toMatchObject({ finalized: true, fully_refunded: false });
      expect(feeOf(p.fee)).toBe('1.03|false');
      expect(adjustments(p.id)).toBe('0|0');
    });

    it('replaying a finalized refund changes nothing (duplicate safety)', () => {
      const p = payment(waaiioHeld, false);
      const id = randomUUID();
      sql(`INSERT INTO public.refunds (id, payment_id, business_id, amount, status, gateway, refund_type, initiated_by, dispatched_at, gateway_refund_reference)
             VALUES ('${id}', '${p.id}', '${waaiioHeld}', 0.5, 'provider_success_unfinalized', 'stripe', 'partial', '${owner}', now(), 'm550-${id}');`);
      expect(JSON.parse(sql(`SELECT public.finalize_refund_execution('${id}')`))).toMatchObject({ finalized: true });
      // 3% of $0.50 = $0.015, which rounds to $0.02 (was $0).
      expect(feeOf(p.fee)).toBe('1.48|false');
      expect(JSON.parse(sql(`SELECT public.finalize_refund_execution('${id}')`))).toEqual({ finalized: true, reason: 'already_finalized' });
      expect(feeOf(p.fee)).toBe('1.48|false');
      expect(adjustments(p.id)).toBe('-0.50|1');
    });
  });
});

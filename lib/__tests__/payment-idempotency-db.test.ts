/**
 * Payment-level idempotency — Real PostgreSQL tests
 *
 * Requires TEST_DATABASE_URL:
 *   docker run --rm -d --name pay-idem-test -p 54324:5432 -e POSTGRES_PASSWORD=test postgres:16
 *   TEST_DATABASE_URL=postgresql://postgres:test@localhost:54324/postgres npx vitest run lib/__tests__/payment-idempotency-db.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as path from 'path';

const dbUrl = process.env.TEST_DATABASE_URL;
const BIZ1 = '00000000-0000-0000-0000-000000000001';
const BIZ2 = '00000000-0000-0000-0000-000000000002';

function psql(sql: string): string {
  const raw = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  });
  return raw.split('\n').filter(l => {
    const t = l.trim();
    return t !== '' && !/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|DO|SET|COMMENT)\b/.test(t);
  }).join('\n').trim();
}

function psqlJson(sql: string): any {
  const raw = psql(sql);
  return raw ? JSON.parse(raw) : null;
}

function psqlFile(f: string): void {
  execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "${f}"`, { encoding: 'utf-8', timeout: 30000 });
}

// Invoice IDs
const INV_FRESH  = '10000000-0000-0000-0000-000000000001';
const INV_EXACT  = '10000000-0000-0000-0000-000000000002';
const INV_UNEXP  = '10000000-0000-0000-0000-000000000003';
const INV_ANOM   = '10000000-0000-0000-0000-000000000004';
const INV_PAID   = '10000000-0000-0000-0000-000000000005';
const INV_NOROWS = '10000000-0000-0000-0000-000000000006';

// Historical payment IDs
const PAY_HIST_EXACT = '20000000-0000-0000-0000-000000000001';
const PAY_HIST_UNEXP = '20000000-0000-0000-0000-000000000002';
const PAY_HIST_ANOM  = '20000000-0000-0000-0000-000000000003';
const PAY_HIST_PAID  = '20000000-0000-0000-0000-000000000004';

describe.skipIf(!dbUrl)('Migration 310: Payment idempotency (real PostgreSQL)', () => {
  beforeAll(() => {
    if (!dbUrl) return;

    psql(`
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    `);

    // Clean slate
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DROP TABLE IF EXISTS invoice_payment_applications CASCADE;
      DROP TABLE IF EXISTS platform_fees CASCADE;
      DROP TABLE IF EXISTS campaign_donations CASCADE;
      DROP TABLE IF EXISTS payments CASCADE;
      DROP TABLE IF EXISTS invoices CASCADE;
      DROP TABLE IF EXISTS campaigns CASCADE;
      DROP TABLE IF EXISTS businesses CASCADE;
      DROP FUNCTION IF EXISTS apply_invoice_payment(uuid, uuid) CASCADE;
      DROP FUNCTION IF EXISTS apply_campaign_donation(uuid, uuid) CASCADE;

      CREATE TABLE businesses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);

      CREATE TABLE invoices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id uuid NOT NULL REFERENCES businesses(id),
        total_amount numeric(12,2) DEFAULT 0,
        amount_paid numeric(12,2) DEFAULT 0,
        status varchar(20) DEFAULT 'sent',
        paid_at timestamptz,
        updated_at timestamptz DEFAULT now()
      );

      CREATE TABLE payments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id uuid REFERENCES businesses(id),
        amount numeric(12,2) NOT NULL,
        status varchar(20) DEFAULT 'pending',
        invoice_id uuid REFERENCES invoices(id),
        campaign_id uuid,
        gateway_reference varchar(100) UNIQUE NOT NULL,
        created_at timestamptz DEFAULT now()
      );

      CREATE TABLE campaigns (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id uuid NOT NULL REFERENCES businesses(id),
        raised_amount numeric(12,2) DEFAULT 0,
        donor_count integer DEFAULT 0,
        status varchar(20) DEFAULT 'active'
      );

      CREATE TABLE campaign_donations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        campaign_id uuid NOT NULL REFERENCES campaigns(id),
        business_id uuid NOT NULL REFERENCES businesses(id),
        payment_id uuid REFERENCES payments(id),
        donor_phone text NOT NULL,
        amount integer NOT NULL,
        status varchar(20) DEFAULT 'pending',
        created_at timestamptz DEFAULT now()
      );

      CREATE TABLE platform_fees (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id uuid NOT NULL REFERENCES businesses(id),
        booking_id uuid, invoice_id uuid, campaign_id uuid,
        order_id uuid, reservation_id uuid,
        transaction_amount integer NOT NULL DEFAULT 0,
        fee_percentage decimal(5,2) DEFAULT 0,
        fee_flat integer DEFAULT 0, fee_total integer DEFAULT 0,
        tier text DEFAULT 'free', gateway_fee integer DEFAULT 0,
        refunded_at timestamptz, created_at timestamptz DEFAULT now()
      );

      GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
      GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
    `);

    // Pre-migration data
    psql(`
      INSERT INTO businesses VALUES ('${BIZ1}', 'Test Biz'), ('${BIZ2}', 'Other Biz');

      -- A: Fresh (amount_paid=0, no payments)
      INSERT INTO invoices (id, business_id, total_amount, amount_paid, status) VALUES ('${INV_FRESH}', '${BIZ1}', 1000, 0, 'sent');

      -- B: Exact match (amount_paid=500, historical=500)
      INSERT INTO invoices (id, business_id, total_amount, amount_paid, status) VALUES ('${INV_EXACT}', '${BIZ1}', 1000, 500, 'sent');
      INSERT INTO payments (id, business_id, amount, status, invoice_id, gateway_reference) VALUES ('${PAY_HIST_EXACT}', '${BIZ1}', 500, 'success', '${INV_EXACT}', 'hist-exact');

      -- C: Unexplained baseline (amount_paid=700, historical=500)
      INSERT INTO invoices (id, business_id, total_amount, amount_paid, status) VALUES ('${INV_UNEXP}', '${BIZ1}', 1000, 700, 'sent');
      INSERT INTO payments (id, business_id, amount, status, invoice_id, gateway_reference) VALUES ('${PAY_HIST_UNEXP}', '${BIZ1}', 500, 'success', '${INV_UNEXP}', 'hist-unexp');

      -- D: Anomalous (amount_paid=500, historical=700)
      INSERT INTO invoices (id, business_id, total_amount, amount_paid, status) VALUES ('${INV_ANOM}', '${BIZ1}', 1000, 500, 'sent');
      INSERT INTO payments (id, business_id, amount, status, invoice_id, gateway_reference) VALUES ('${PAY_HIST_ANOM}', '${BIZ1}', 700, 'success', '${INV_ANOM}', 'hist-anom');

      -- E: Already paid
      INSERT INTO invoices (id, business_id, total_amount, amount_paid, status, paid_at) VALUES ('${INV_PAID}', '${BIZ1}', 500, 500, 'paid', now());
      INSERT INTO payments (id, business_id, amount, status, invoice_id, gateway_reference) VALUES ('${PAY_HIST_PAID}', '${BIZ1}', 500, 'success', '${INV_PAID}', 'hist-paid');

      -- F: No historical payment rows (amount_paid=500)
      INSERT INTO invoices (id, business_id, total_amount, amount_paid, status) VALUES ('${INV_NOROWS}', '${BIZ1}', 1000, 500, 'sent');

      -- Legacy platform fee (no payment_id)
      INSERT INTO platform_fees (business_id, invoice_id, transaction_amount, fee_total) VALUES ('${BIZ1}', '${INV_EXACT}', 500, 25);
    `);

    // Capture pre-migration amount_paid for verification
    psqlFile(path.resolve('supabase/migrations/310_payment_level_idempotency.sql'));
  });

  afterAll(() => {
    if (!dbUrl) return;
    psql(`
      DROP TABLE IF EXISTS invoice_payment_applications CASCADE;
      DROP TABLE IF EXISTS platform_fees CASCADE;
      DROP TABLE IF EXISTS campaign_donations CASCADE;
      DROP TABLE IF EXISTS payments CASCADE;
      DROP TABLE IF EXISTS invoices CASCADE;
      DROP TABLE IF EXISTS campaigns CASCADE;
      DROP TABLE IF EXISTS businesses CASCADE;
      DROP FUNCTION IF EXISTS apply_invoice_payment(uuid, uuid) CASCADE;
      DROP FUNCTION IF EXISTS apply_campaign_donation(uuid, uuid) CASCADE;
    `);
  });

  // ═══════════════════════════════════════════════════════════════
  // PRIVILEGES
  // ═══════════════════════════════════════════════════════════════

  describe('Privileges', () => {
    it('anon cannot execute invoice RPC', () => { expect(psql(`SELECT has_function_privilege('anon', 'apply_invoice_payment(uuid, uuid)', 'EXECUTE');`)).toBe('f'); });
    it('authenticated cannot execute invoice RPC', () => { expect(psql(`SELECT has_function_privilege('authenticated', 'apply_invoice_payment(uuid, uuid)', 'EXECUTE');`)).toBe('f'); });
    it('service_role can execute invoice RPC', () => { expect(psql(`SELECT has_function_privilege('service_role', 'apply_invoice_payment(uuid, uuid)', 'EXECUTE');`)).toBe('t'); });
    it('anon cannot execute campaign RPC', () => { expect(psql(`SELECT has_function_privilege('anon', 'apply_campaign_donation(uuid, uuid)', 'EXECUTE');`)).toBe('f'); });
    it('authenticated cannot execute campaign RPC', () => { expect(psql(`SELECT has_function_privilege('authenticated', 'apply_campaign_donation(uuid, uuid)', 'EXECUTE');`)).toBe('f'); });
    it('service_role can execute campaign RPC', () => { expect(psql(`SELECT has_function_privilege('service_role', 'apply_campaign_donation(uuid, uuid)', 'EXECUTE');`)).toBe('t'); });
  });

  // ═══════════════════════════════════════════════════════════════
  // MIGRATION BASELINE VERIFICATION
  // ═══════════════════════════════════════════════════════════════

  describe('Migration preserves amount_paid exactly', () => {
    it('A: fresh → amount_paid=0, baseline=0', () => {
      const r = psql(`SELECT amount_paid, legacy_amount_paid_baseline FROM invoices WHERE id='${INV_FRESH}';`);
      const [ap, bl] = r.split('|');
      expect(Number(ap)).toBe(0);
      expect(Number(bl)).toBe(0);
    });
    it('B: exact match → amount_paid=500, baseline=500', () => {
      const r = psql(`SELECT amount_paid, legacy_amount_paid_baseline FROM invoices WHERE id='${INV_EXACT}';`);
      const [ap, bl] = r.split('|');
      expect(Number(ap)).toBe(500);
      expect(Number(bl)).toBe(500);
    });
    it('C: unexplained → amount_paid=700, baseline=700', () => {
      const r = psql(`SELECT amount_paid, legacy_amount_paid_baseline FROM invoices WHERE id='${INV_UNEXP}';`);
      const [ap, bl] = r.split('|');
      expect(Number(ap)).toBe(700);
      expect(Number(bl)).toBe(700);
    });
    it('D: anomalous → amount_paid=500, baseline=500', () => {
      const r = psql(`SELECT amount_paid, legacy_amount_paid_baseline FROM invoices WHERE id='${INV_ANOM}';`);
      const [ap, bl] = r.split('|');
      expect(Number(ap)).toBe(500);
      expect(Number(bl)).toBe(500);
    });
    it('E: already paid → status=paid preserved', () => {
      const r = psql(`SELECT amount_paid, status FROM invoices WHERE id='${INV_PAID}';`);
      const [ap, st] = r.split('|');
      expect(Number(ap)).toBe(500);
      expect(st).toBe('paid');
    });
    it('F: no payment rows → baseline=500', () => {
      const bl = psql(`SELECT legacy_amount_paid_baseline FROM invoices WHERE id='${INV_NOROWS}';`);
      expect(Number(bl)).toBe(500);
    });
    it('historical payments backfilled as legacy markers (amount_applied=0)', () => {
      const markers = psql(`SELECT COUNT(*) FROM invoice_payment_applications WHERE is_legacy_marker = true;`);
      expect(Number(markers)).toBeGreaterThanOrEqual(4); // 4 historical payments
      const nonZero = psql(`SELECT COUNT(*) FROM invoice_payment_applications WHERE is_legacy_marker = true AND amount_applied != 0;`);
      expect(Number(nonZero)).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // INVOICE APPLICATION — ALL CASES
  // ═══════════════════════════════════════════════════════════════

  describe('Invoice payment application', () => {
    it('A: fresh + 200 = 200', () => {
      const pid = psql(`INSERT INTO payments (business_id, amount, status, invoice_id, gateway_reference) VALUES ('${BIZ1}', 200, 'success', '${INV_FRESH}', 'new-A') RETURNING id;`);
      const r = psqlJson(`SELECT apply_invoice_payment('${INV_FRESH}', '${pid}');`);
      expect(r.applied).toBe(true);
      expect(Number(r.new_amount_paid)).toBe(200);
    });

    it('B: exact-match + 200 = 700', () => {
      const pid = psql(`INSERT INTO payments (business_id, amount, status, invoice_id, gateway_reference) VALUES ('${BIZ1}', 200, 'success', '${INV_EXACT}', 'new-B') RETURNING id;`);
      const r = psqlJson(`SELECT apply_invoice_payment('${INV_EXACT}', '${pid}');`);
      expect(r.applied).toBe(true);
      expect(Number(r.new_amount_paid)).toBe(700); // baseline 500 + new 200
    });

    it('C: unexplained + 200 = 900', () => {
      const pid = psql(`INSERT INTO payments (business_id, amount, status, invoice_id, gateway_reference) VALUES ('${BIZ1}', 200, 'success', '${INV_UNEXP}', 'new-C') RETURNING id;`);
      const r = psqlJson(`SELECT apply_invoice_payment('${INV_UNEXP}', '${pid}');`);
      expect(r.applied).toBe(true);
      expect(Number(r.new_amount_paid)).toBe(900); // baseline 700 + new 200
    });

    it('D: anomalous(500/700) + 200 = 700', () => {
      const pid = psql(`INSERT INTO payments (business_id, amount, status, invoice_id, gateway_reference) VALUES ('${BIZ1}', 200, 'success', '${INV_ANOM}', 'new-D') RETURNING id;`);
      const r = psqlJson(`SELECT apply_invoice_payment('${INV_ANOM}', '${pid}');`);
      expect(r.applied).toBe(true);
      expect(Number(r.new_amount_paid)).toBe(700); // baseline 500 + new 200 (NOT 900)
    });

    it('E: no payment rows + 200 = 700', () => {
      const pid = psql(`INSERT INTO payments (business_id, amount, status, invoice_id, gateway_reference) VALUES ('${BIZ1}', 200, 'success', '${INV_NOROWS}', 'new-E') RETURNING id;`);
      const r = psqlJson(`SELECT apply_invoice_payment('${INV_NOROWS}', '${pid}');`);
      expect(r.applied).toBe(true);
      expect(Number(r.new_amount_paid)).toBe(700); // baseline 500 + new 200
    });

    it('F: historical replay → no increment', () => {
      const r = psqlJson(`SELECT apply_invoice_payment('${INV_UNEXP}', '${PAY_HIST_UNEXP}');`);
      expect(r.applied).toBe(false);
      expect(r.already_applied).toBe(true);
      const ap = psql(`SELECT amount_paid FROM invoices WHERE id='${INV_UNEXP}';`);
      expect(Number(ap)).toBe(900); // unchanged from case C
    });

    it('replay same new payment → no increment', () => {
      const pid = psql(`SELECT id FROM payments WHERE gateway_reference='new-C';`);
      const r = psqlJson(`SELECT apply_invoice_payment('${INV_UNEXP}', '${pid}');`);
      expect(r.applied).toBe(false);
      expect(r.already_applied).toBe(true);
    });

    it('pending payment rejected', () => {
      const pid = psql(`INSERT INTO payments (business_id, amount, status, invoice_id, gateway_reference) VALUES ('${BIZ1}', 100, 'pending', '${INV_FRESH}', 'pend-x') RETURNING id;`);
      const r = psqlJson(`SELECT apply_invoice_payment('${INV_FRESH}', '${pid}');`);
      expect(r.reason).toBe('payment_not_successful');
    });

    it('wrong invoice rejected', () => {
      const pid = psql(`INSERT INTO payments (business_id, amount, status, invoice_id, gateway_reference) VALUES ('${BIZ1}', 100, 'success', '${INV_EXACT}', 'wrong-inv') RETURNING id;`);
      const r = psqlJson(`SELECT apply_invoice_payment('${INV_FRESH}', '${pid}');`);
      expect(r.reason).toBe('payment_invoice_mismatch');
    });

    it('business mismatch rejected', () => {
      const pid = psql(`INSERT INTO payments (business_id, amount, status, invoice_id, gateway_reference) VALUES ('${BIZ2}', 100, 'success', '${INV_FRESH}', 'biz-mis') RETURNING id;`);
      const r = psqlJson(`SELECT apply_invoice_payment('${INV_FRESH}', '${pid}');`);
      expect(r.reason).toBe('business_mismatch');
    });

    it('two distinct partial payments → both apply', () => {
      const inv = psql(`INSERT INTO invoices (business_id, total_amount, amount_paid, status) VALUES ('${BIZ1}', 1000, 0, 'sent') RETURNING id;`);
      const p1 = psql(`INSERT INTO payments (business_id, amount, status, invoice_id, gateway_reference) VALUES ('${BIZ1}', 400, 'success', '${inv}', 'partial-1') RETURNING id;`);
      const p2 = psql(`INSERT INTO payments (business_id, amount, status, invoice_id, gateway_reference) VALUES ('${BIZ1}', 600, 'success', '${inv}', 'partial-2') RETURNING id;`);
      psqlJson(`SELECT apply_invoice_payment('${inv}', '${p1}');`);
      const r2 = psqlJson(`SELECT apply_invoice_payment('${inv}', '${p2}');`);
      expect(r2.applied).toBe(true);
      expect(Number(r2.new_amount_paid)).toBe(1000);
      expect(r2.is_fully_paid).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // CAMPAIGN
  // ═══════════════════════════════════════════════════════════════

  describe('Campaign donation', () => {
    let campId: string;

    beforeAll(() => {
      campId = psql(`INSERT INTO campaigns (business_id, raised_amount, donor_count) VALUES ('${BIZ1}', 0, 0) RETURNING id;`);
    });

    it('valid payment applies', () => {
      const pid = psql(`INSERT INTO payments (business_id, amount, status, campaign_id, gateway_reference) VALUES ('${BIZ1}', 500, 'success', '${campId}', 'camp-1') RETURNING id;`);
      psql(`INSERT INTO campaign_donations (campaign_id, business_id, payment_id, donor_phone, amount, status) VALUES ('${campId}', '${BIZ1}', '${pid}', '+123', 500, 'pending');`);
      const r = psqlJson(`SELECT apply_campaign_donation('${campId}', '${pid}');`);
      expect(r.applied).toBe(true);
    });

    it('replay → already_applied', () => {
      const pid = psql(`SELECT id FROM payments WHERE gateway_reference='camp-1';`);
      const r = psqlJson(`SELECT apply_campaign_donation('${campId}', '${pid}');`);
      expect(r.already_applied).toBe(true);
      const stats = psql(`SELECT raised_amount, donor_count FROM campaigns WHERE id='${campId}';`);
      expect(stats).toBe('500.00|1');
    });

    it('two donations both count', () => {
      const pid = psql(`INSERT INTO payments (business_id, amount, status, campaign_id, gateway_reference) VALUES ('${BIZ1}', 300, 'success', '${campId}', 'camp-2') RETURNING id;`);
      psql(`INSERT INTO campaign_donations (campaign_id, business_id, payment_id, donor_phone, amount, status) VALUES ('${campId}', '${BIZ1}', '${pid}', '+456', 300, 'pending');`);
      psqlJson(`SELECT apply_campaign_donation('${campId}', '${pid}');`);
      const stats = psql(`SELECT raised_amount, donor_count FROM campaigns WHERE id='${campId}';`);
      expect(stats).toBe('800.00|2');
    });

    it('wrong campaign rejected', () => {
      const otherCamp = psql(`INSERT INTO campaigns (business_id) VALUES ('${BIZ1}') RETURNING id;`);
      const pid = psql(`INSERT INTO payments (business_id, amount, status, campaign_id, gateway_reference) VALUES ('${BIZ1}', 100, 'success', '${campId}', 'camp-wrong') RETURNING id;`);
      const r = psqlJson(`SELECT apply_campaign_donation('${otherCamp}', '${pid}');`);
      expect(r.reason).toBe('payment_campaign_mismatch');
    });

    it('business mismatch rejected', () => {
      const pid = psql(`INSERT INTO payments (business_id, amount, status, campaign_id, gateway_reference) VALUES ('${BIZ2}', 100, 'success', '${campId}', 'camp-biz') RETURNING id;`);
      const r = psqlJson(`SELECT apply_campaign_donation('${campId}', '${pid}');`);
      expect(r.reason).toBe('business_mismatch');
    });

    it('donation not found (no pending donation for payment) returns donation_not_found', () => {
      const pid = psql(`INSERT INTO payments (business_id, amount, status, campaign_id, gateway_reference) VALUES ('${BIZ1}', 100, 'success', '${campId}', 'camp-nodon') RETURNING id;`);
      // No donation row created for this payment
      const r = psqlJson(`SELECT apply_campaign_donation('${campId}', '${pid}');`);
      expect(r.reason).toBe('donation_not_found');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // PLATFORM FEE UNIQUENESS
  // ═══════════════════════════════════════════════════════════════

  describe('Platform fees', () => {
    it('same payment → one fee', () => {
      const pid = psql(`INSERT INTO payments (business_id, amount, status, gateway_reference) VALUES ('${BIZ1}', 1000, 'success', 'fee-1') RETURNING id;`);
      psql(`INSERT INTO platform_fees (business_id, payment_id, transaction_amount, fee_total) VALUES ('${BIZ1}', '${pid}', 1000, 50);`);
      let err = '';
      try { psql(`INSERT INTO platform_fees (business_id, payment_id, transaction_amount, fee_total) VALUES ('${BIZ1}', '${pid}', 1000, 50);`); } catch (e: any) { err = e.toString(); }
      expect(err).toContain('duplicate');
    });

    it('same payment after refund → still blocked', () => {
      const pid = psql(`INSERT INTO payments (business_id, amount, status, gateway_reference) VALUES ('${BIZ1}', 2000, 'success', 'fee-ref') RETURNING id;`);
      psql(`INSERT INTO platform_fees (business_id, payment_id, transaction_amount, fee_total) VALUES ('${BIZ1}', '${pid}', 2000, 100);`);
      psql(`UPDATE platform_fees SET refunded_at = now() WHERE payment_id = '${pid}';`);
      let err = '';
      try { psql(`INSERT INTO platform_fees (business_id, payment_id, transaction_amount, fee_total) VALUES ('${BIZ1}', '${pid}', 2000, 100);`); } catch (e: any) { err = e.toString(); }
      expect(err).toContain('duplicate');
    });

    it('two payments same invoice → two fees', () => {
      const inv = psql(`INSERT INTO invoices (business_id, total_amount) VALUES ('${BIZ1}', 1000) RETURNING id;`);
      const p1 = psql(`INSERT INTO payments (business_id, amount, status, invoice_id, gateway_reference) VALUES ('${BIZ1}', 400, 'success', '${inv}', 'fee-ip1') RETURNING id;`);
      const p2 = psql(`INSERT INTO payments (business_id, amount, status, invoice_id, gateway_reference) VALUES ('${BIZ1}', 600, 'success', '${inv}', 'fee-ip2') RETURNING id;`);
      psql(`INSERT INTO platform_fees (business_id, payment_id, invoice_id, transaction_amount, fee_total) VALUES ('${BIZ1}', '${p1}', '${inv}', 400, 20);`);
      psql(`INSERT INTO platform_fees (business_id, payment_id, invoice_id, transaction_amount, fee_total) VALUES ('${BIZ1}', '${p2}', '${inv}', 600, 30);`);
      expect(psql(`SELECT COUNT(*) FROM platform_fees WHERE invoice_id='${inv}' AND payment_id IS NOT NULL;`)).toBe('2');
    });

    it('legacy fee (no payment_id) coexists', () => {
      expect(Number(psql(`SELECT COUNT(*) FROM platform_fees WHERE invoice_id='${INV_EXACT}' AND payment_id IS NULL;`))).toBe(1);
    });

    it('deposit transaction_amount = actual collected', () => {
      const pid = psql(`INSERT INTO payments (business_id, amount, status, gateway_reference) VALUES ('${BIZ1}', 5000, 'success', 'fee-dep') RETURNING id;`);
      psql(`INSERT INTO platform_fees (business_id, payment_id, transaction_amount, fee_total) VALUES ('${BIZ1}', '${pid}', 5000, 250);`);
      expect(psql(`SELECT transaction_amount FROM platform_fees WHERE payment_id='${pid}';`)).toBe('5000');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // CAMPAIGN DONATION PAYMENT UNIQUENESS
  // ═══════════════════════════════════════════════════════════════

  describe('Campaign donation payment uniqueness', () => {
    it('one payment_id per donation enforced', () => {
      const campId = psql(`INSERT INTO campaigns (business_id) VALUES ('${BIZ1}') RETURNING id;`);
      const pid = psql(`INSERT INTO payments (business_id, amount, status, campaign_id, gateway_reference) VALUES ('${BIZ1}', 100, 'success', '${campId}', 'uniq-don') RETURNING id;`);
      psql(`INSERT INTO campaign_donations (campaign_id, business_id, payment_id, donor_phone, amount) VALUES ('${campId}', '${BIZ1}', '${pid}', '+111', 100);`);
      let err = '';
      try { psql(`INSERT INTO campaign_donations (campaign_id, business_id, payment_id, donor_phone, amount) VALUES ('${campId}', '${BIZ1}', '${pid}', '+222', 100);`); } catch (e: any) { err = e.toString(); }
      expect(err).toContain('duplicate');
    });

    it('NULL payment_id rows are allowed (multiple)', () => {
      const campId = psql(`INSERT INTO campaigns (business_id) VALUES ('${BIZ1}') RETURNING id;`);
      psql(`INSERT INTO campaign_donations (campaign_id, business_id, payment_id, donor_phone, amount) VALUES ('${campId}', '${BIZ1}', NULL, '+111', 100);`);
      psql(`INSERT INTO campaign_donations (campaign_id, business_id, payment_id, donor_phone, amount) VALUES ('${campId}', '${BIZ1}', NULL, '+222', 200);`);
      expect(psql(`SELECT COUNT(*) FROM campaign_donations WHERE campaign_id='${campId}' AND payment_id IS NULL;`)).toBe('2');
    });
  });
});

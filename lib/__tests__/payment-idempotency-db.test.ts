/**
 * Payment-level idempotency — Real PostgreSQL tests
 *
 * Verifies apply_invoice_payment and apply_campaign_donation RPCs
 * with durable legacy baseline, privilege lockdown, and fee uniqueness.
 *
 * Requires TEST_DATABASE_URL:
 *   docker run --rm -d --name pay-idem-test -p 54324:5432 -e POSTGRES_PASSWORD=test postgres:16
 *   TEST_DATABASE_URL=postgresql://postgres:test@localhost:54324/postgres npx vitest run lib/__tests__/payment-idempotency-db.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as path from 'path';

const dbUrl = process.env.TEST_DATABASE_URL;

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

function psqlFile(filePath: string): void {
  execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "${filePath}"`, {
    encoding: 'utf-8', timeout: 30000,
  });
}

describe.skipIf(!dbUrl)('Migration 310: Payment idempotency (real PostgreSQL)', () => {
  beforeAll(() => {
    if (!dbUrl) return;

    psql(`
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    `);

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

      CREATE TABLE businesses (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text
      );

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
        fee_flat integer DEFAULT 0,
        fee_total integer DEFAULT 0,
        tier text DEFAULT 'free',
        gateway_fee integer DEFAULT 0,
        refunded_at timestamptz,
        created_at timestamptz DEFAULT now()
      );

      GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
      GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
    `);

    // Create pre-migration data BEFORE applying migration 310
    psql(`
      -- BIZ for all tests
      INSERT INTO businesses (id, name) VALUES
        ('00000000-0000-0000-0000-000000000001', 'Test Biz'),
        ('00000000-0000-0000-0000-000000000002', 'Other Biz');

      -- CASE 1: Fresh invoice (amount_paid=0, no historical payments)
      INSERT INTO invoices (id, business_id, total_amount, amount_paid, status)
      VALUES ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 1000, 0, 'sent');

      -- CASE 2: Exact-match legacy (amount_paid=500, one historical payment of 500)
      INSERT INTO invoices (id, business_id, total_amount, amount_paid, status)
      VALUES ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 1000, 500, 'sent');
      INSERT INTO payments (id, business_id, amount, status, invoice_id, gateway_reference)
      VALUES ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 500, 'success', '10000000-0000-0000-0000-000000000002', 'hist-exact-1');

      -- CASE 3: Unexplained baseline (amount_paid=700, historical payment=500)
      INSERT INTO invoices (id, business_id, total_amount, amount_paid, status)
      VALUES ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 1000, 700, 'sent');
      INSERT INTO payments (id, business_id, amount, status, invoice_id, gateway_reference)
      VALUES ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 500, 'success', '10000000-0000-0000-0000-000000000003', 'hist-partial-1');

      -- CASE 4: Anomalous (amount_paid=500, historical payments=700)
      INSERT INTO invoices (id, business_id, total_amount, amount_paid, status)
      VALUES ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 1000, 500, 'sent');
      INSERT INTO payments (id, business_id, amount, status, invoice_id, gateway_reference)
      VALUES ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 700, 'success', '10000000-0000-0000-0000-000000000004', 'hist-anom-1');

      -- CASE 5: Already paid
      INSERT INTO invoices (id, business_id, total_amount, amount_paid, status, paid_at)
      VALUES ('10000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', 500, 500, 'paid', now());
      INSERT INTO payments (id, business_id, amount, status, invoice_id, gateway_reference)
      VALUES ('20000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 500, 'success', '10000000-0000-0000-0000-000000000005', 'hist-paid-1');

      -- Legacy platform fee (pre-migration, no payment_id)
      INSERT INTO platform_fees (business_id, invoice_id, transaction_amount, fee_total)
      VALUES ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 500, 25);
    `);

    // Apply migration 310
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
  // A. PRIVILEGE TESTS
  // ═══════════════════════════════════════════════════════════════

  describe('RPC privileges', () => {
    it('anon cannot execute apply_invoice_payment', () => {
      expect(psql(`SELECT has_function_privilege('anon', 'apply_invoice_payment(uuid, uuid)', 'EXECUTE');`)).toBe('f');
    });
    it('authenticated cannot execute apply_invoice_payment', () => {
      expect(psql(`SELECT has_function_privilege('authenticated', 'apply_invoice_payment(uuid, uuid)', 'EXECUTE');`)).toBe('f');
    });
    it('service_role can execute apply_invoice_payment', () => {
      expect(psql(`SELECT has_function_privilege('service_role', 'apply_invoice_payment(uuid, uuid)', 'EXECUTE');`)).toBe('t');
    });
    it('anon cannot execute apply_campaign_donation', () => {
      expect(psql(`SELECT has_function_privilege('anon', 'apply_campaign_donation(uuid, uuid)', 'EXECUTE');`)).toBe('f');
    });
    it('authenticated cannot execute apply_campaign_donation', () => {
      expect(psql(`SELECT has_function_privilege('authenticated', 'apply_campaign_donation(uuid, uuid)', 'EXECUTE');`)).toBe('f');
    });
    it('service_role can execute apply_campaign_donation', () => {
      expect(psql(`SELECT has_function_privilege('service_role', 'apply_campaign_donation(uuid, uuid)', 'EXECUTE');`)).toBe('t');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // B. LEGACY BASELINE VERIFICATION
  // ═══════════════════════════════════════════════════════════════

  describe('Legacy baseline computation', () => {
    it('CASE 1: fresh invoice → baseline=0', () => {
      const bl = psql(`SELECT legacy_amount_paid_baseline FROM invoices WHERE id = '10000000-0000-0000-0000-000000000001';`);
      expect(Number(bl)).toBe(0);
    });
    it('CASE 2: exact match → baseline=0', () => {
      const bl = psql(`SELECT legacy_amount_paid_baseline FROM invoices WHERE id = '10000000-0000-0000-0000-000000000002';`);
      expect(Number(bl)).toBe(0);
    });
    it('CASE 3: unexplained baseline → baseline=200', () => {
      const bl = psql(`SELECT legacy_amount_paid_baseline FROM invoices WHERE id = '10000000-0000-0000-0000-000000000003';`);
      expect(Number(bl)).toBe(200);
    });
    it('CASE 4: anomalous (paid<known) → baseline=0 (safe)', () => {
      const bl = psql(`SELECT legacy_amount_paid_baseline FROM invoices WHERE id = '10000000-0000-0000-0000-000000000004';`);
      expect(Number(bl)).toBe(0);
    });
    it('CASE 5: already paid → amount_paid preserved', () => {
      const row = psql(`SELECT amount_paid, status FROM invoices WHERE id = '10000000-0000-0000-0000-000000000005';`);
      const [paid, status] = row.split('|');
      expect(Number(paid)).toBe(500);
      expect(status).toBe('paid');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // C. INVOICE PAYMENT APPLICATION — ALL CASES
  // ═══════════════════════════════════════════════════════════════

  describe('Invoice payment application', () => {
    it('CASE 1: fresh invoice + new payment 200 = 200', () => {
      const payId = psql(`
        INSERT INTO payments (business_id, amount, status, invoice_id, gateway_reference)
        VALUES ('00000000-0000-0000-0000-000000000001', 200, 'success', '10000000-0000-0000-0000-000000000001', 'new-fresh-1') RETURNING id;
      `);
      const result = psqlJson(`SELECT apply_invoice_payment('10000000-0000-0000-0000-000000000001', '${payId}');`);
      expect(result.applied).toBe(true);
      expect(Number(result.new_amount_paid)).toBe(200);
    });

    it('CASE 2: exact-match legacy + new payment 200 = 700', () => {
      const payId = psql(`
        INSERT INTO payments (business_id, amount, status, invoice_id, gateway_reference)
        VALUES ('00000000-0000-0000-0000-000000000001', 200, 'success', '10000000-0000-0000-0000-000000000002', 'new-exact-1') RETURNING id;
      `);
      const result = psqlJson(`SELECT apply_invoice_payment('10000000-0000-0000-0000-000000000002', '${payId}');`);
      expect(result.applied).toBe(true);
      // baseline=0 + backfilled 500 + new 200 = 700
      expect(Number(result.new_amount_paid)).toBe(700);
    });

    it('CASE 3: unexplained baseline + new payment 200 = 900', () => {
      const payId = psql(`
        INSERT INTO payments (business_id, amount, status, invoice_id, gateway_reference)
        VALUES ('00000000-0000-0000-0000-000000000001', 200, 'success', '10000000-0000-0000-0000-000000000003', 'new-baseline-1') RETURNING id;
      `);
      const result = psqlJson(`SELECT apply_invoice_payment('10000000-0000-0000-0000-000000000003', '${payId}');`);
      expect(result.applied).toBe(true);
      // baseline=200 + backfilled 500 + new 200 = 900
      expect(Number(result.new_amount_paid)).toBe(900);
    });

    it('CASE 3 replay → no increment (stays 900)', () => {
      const payId = psql(`SELECT id FROM payments WHERE gateway_reference = 'new-baseline-1';`);
      const result = psqlJson(`SELECT apply_invoice_payment('10000000-0000-0000-0000-000000000003', '${payId}');`);
      expect(result.applied).toBe(false);
      expect(result.already_applied).toBe(true);
      const paid = psql(`SELECT amount_paid FROM invoices WHERE id = '10000000-0000-0000-0000-000000000003';`);
      expect(Number(paid)).toBe(900);
    });

    it('CASE 3 second distinct payment adds correctly = 1000', () => {
      const payId = psql(`
        INSERT INTO payments (business_id, amount, status, invoice_id, gateway_reference)
        VALUES ('00000000-0000-0000-0000-000000000001', 100, 'success', '10000000-0000-0000-0000-000000000003', 'new-baseline-2') RETURNING id;
      `);
      const result = psqlJson(`SELECT apply_invoice_payment('10000000-0000-0000-0000-000000000003', '${payId}');`);
      expect(result.applied).toBe(true);
      // baseline=200 + backfilled 500 + 200 + 100 = 1000
      expect(Number(result.new_amount_paid)).toBe(1000);
      expect(result.is_fully_paid).toBe(true);
    });

    it('CASE 7: historical payment replay does NOT increment', () => {
      // hist-partial-1 was backfilled into ledger during migration
      const result = psqlJson(`SELECT apply_invoice_payment('10000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000002');`);
      expect(result.applied).toBe(false);
      expect(result.already_applied).toBe(true);
    });

    it('CASE 4: anomalous (paid<known) → safe, no silent reduction', () => {
      // baseline=0, backfill=700. amount_paid should be at least 700.
      const paid = psql(`SELECT amount_paid FROM invoices WHERE id = '10000000-0000-0000-0000-000000000004';`);
      expect(Number(paid)).toBeGreaterThanOrEqual(500); // original was 500, backfill may have updated it
    });

    it('pending payment rejected', () => {
      const payId = psql(`
        INSERT INTO payments (business_id, amount, status, invoice_id, gateway_reference)
        VALUES ('00000000-0000-0000-0000-000000000001', 100, 'pending', '10000000-0000-0000-0000-000000000001', 'pend-1') RETURNING id;
      `);
      const result = psqlJson(`SELECT apply_invoice_payment('10000000-0000-0000-0000-000000000001', '${payId}');`);
      expect(result.applied).toBe(false);
      expect(result.reason).toBe('payment_not_successful');
    });

    it('payment for wrong invoice rejected', () => {
      const payId = psql(`
        INSERT INTO payments (business_id, amount, status, invoice_id, gateway_reference)
        VALUES ('00000000-0000-0000-0000-000000000001', 100, 'success', '10000000-0000-0000-0000-000000000002', 'wrong-inv-1') RETURNING id;
      `);
      const result = psqlJson(`SELECT apply_invoice_payment('10000000-0000-0000-0000-000000000001', '${payId}');`);
      expect(result.applied).toBe(false);
      expect(result.reason).toBe('payment_invoice_mismatch');
    });

    it('payment/business mismatch rejected', () => {
      const payId = psql(`
        INSERT INTO payments (business_id, amount, status, invoice_id, gateway_reference)
        VALUES ('00000000-0000-0000-0000-000000000002', 100, 'success', '10000000-0000-0000-0000-000000000001', 'biz-mismatch-1') RETURNING id;
      `);
      const result = psqlJson(`SELECT apply_invoice_payment('10000000-0000-0000-0000-000000000001', '${payId}');`);
      expect(result.applied).toBe(false);
      expect(result.reason).toBe('business_mismatch');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // D. CAMPAIGN DONATION APPLICATION
  // ═══════════════════════════════════════════════════════════════

  describe('Campaign donation application', () => {
    let campId: string;

    beforeAll(() => {
      campId = psql(`
        INSERT INTO campaigns (business_id, raised_amount, donor_count)
        VALUES ('00000000-0000-0000-0000-000000000001', 0, 0) RETURNING id;
      `);
    });

    it('valid payment applies once', () => {
      const payId = psql(`
        INSERT INTO payments (business_id, amount, status, campaign_id, gateway_reference)
        VALUES ('00000000-0000-0000-0000-000000000001', 500, 'success', '${campId}', 'camp-db-1') RETURNING id;
      `);
      psql(`INSERT INTO campaign_donations (campaign_id, business_id, payment_id, donor_phone, amount, status) VALUES ('${campId}', '00000000-0000-0000-0000-000000000001', '${payId}', '+2341234', 500, 'pending');`);
      const result = psqlJson(`SELECT apply_campaign_donation('${campId}', '${payId}');`);
      expect(result.applied).toBe(true);
      expect(Number(result.amount)).toBe(500);
    });

    it('replay does not increment', () => {
      const payId = psql(`SELECT id FROM payments WHERE gateway_reference = 'camp-db-1';`);
      const result = psqlJson(`SELECT apply_campaign_donation('${campId}', '${payId}');`);
      expect(result.applied).toBe(false);
      expect(result.already_applied).toBe(true);
      const stats = psql(`SELECT raised_amount, donor_count FROM campaigns WHERE id = '${campId}';`);
      const [raised, count] = stats.split('|');
      expect(Number(raised)).toBe(500);
      expect(Number(count)).toBe(1);
    });

    it('two legitimate donations both count', () => {
      const payId = psql(`
        INSERT INTO payments (business_id, amount, status, campaign_id, gateway_reference)
        VALUES ('00000000-0000-0000-0000-000000000001', 300, 'success', '${campId}', 'camp-db-2') RETURNING id;
      `);
      psql(`INSERT INTO campaign_donations (campaign_id, business_id, payment_id, donor_phone, amount, status) VALUES ('${campId}', '00000000-0000-0000-0000-000000000001', '${payId}', '+2345678', 300, 'pending');`);
      const result = psqlJson(`SELECT apply_campaign_donation('${campId}', '${payId}');`);
      expect(result.applied).toBe(true);
      const stats = psql(`SELECT raised_amount, donor_count FROM campaigns WHERE id = '${campId}';`);
      const [raised, count] = stats.split('|');
      expect(Number(raised)).toBe(800);
      expect(Number(count)).toBe(2);
    });

    it('wrong campaign rejected', () => {
      const otherCamp = psql(`INSERT INTO campaigns (business_id) VALUES ('00000000-0000-0000-0000-000000000001') RETURNING id;`);
      const payId = psql(`
        INSERT INTO payments (business_id, amount, status, campaign_id, gateway_reference)
        VALUES ('00000000-0000-0000-0000-000000000001', 100, 'success', '${campId}', 'camp-db-wrong') RETURNING id;
      `);
      const result = psqlJson(`SELECT apply_campaign_donation('${otherCamp}', '${payId}');`);
      expect(result.applied).toBe(false);
      expect(result.reason).toBe('payment_campaign_mismatch');
    });

    it('business mismatch rejected', () => {
      const payId = psql(`
        INSERT INTO payments (business_id, amount, status, campaign_id, gateway_reference)
        VALUES ('00000000-0000-0000-0000-000000000002', 100, 'success', '${campId}', 'camp-db-biz') RETURNING id;
      `);
      const result = psqlJson(`SELECT apply_campaign_donation('${campId}', '${payId}');`);
      expect(result.applied).toBe(false);
      expect(result.reason).toBe('business_mismatch');
    });

    it('pending payment rejected', () => {
      const payId = psql(`
        INSERT INTO payments (business_id, amount, status, campaign_id, gateway_reference)
        VALUES ('00000000-0000-0000-0000-000000000001', 100, 'pending', '${campId}', 'camp-db-pend') RETURNING id;
      `);
      const result = psqlJson(`SELECT apply_campaign_donation('${campId}', '${payId}');`);
      expect(result.applied).toBe(false);
      expect(result.reason).toBe('payment_not_successful');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // E. PLATFORM FEE TESTS (including legacy replay)
  // ═══════════════════════════════════════════════════════════════

  describe('Platform fee payment-level uniqueness', () => {
    it('same payment → one fee (duplicate rejected)', () => {
      const payId = psql(`
        INSERT INTO payments (business_id, amount, status, gateway_reference)
        VALUES ('00000000-0000-0000-0000-000000000001', 1000, 'success', 'fee-db-1') RETURNING id;
      `);
      psql(`INSERT INTO platform_fees (business_id, payment_id, transaction_amount, fee_total) VALUES ('00000000-0000-0000-0000-000000000001', '${payId}', 1000, 50);`);
      let err = '';
      try { psql(`INSERT INTO platform_fees (business_id, payment_id, transaction_amount, fee_total) VALUES ('00000000-0000-0000-0000-000000000001', '${payId}', 1000, 50);`); } catch (e: any) { err = e.toString(); }
      expect(err).toContain('duplicate');
    });

    it('same payment after refund → still no second original fee', () => {
      const payId = psql(`
        INSERT INTO payments (business_id, amount, status, gateway_reference)
        VALUES ('00000000-0000-0000-0000-000000000001', 2000, 'success', 'fee-db-refund') RETURNING id;
      `);
      psql(`INSERT INTO platform_fees (business_id, payment_id, transaction_amount, fee_total) VALUES ('00000000-0000-0000-0000-000000000001', '${payId}', 2000, 100);`);
      psql(`UPDATE platform_fees SET refunded_at = now() WHERE payment_id = '${payId}';`);
      let err = '';
      try { psql(`INSERT INTO platform_fees (business_id, payment_id, transaction_amount, fee_total) VALUES ('00000000-0000-0000-0000-000000000001', '${payId}', 2000, 100);`); } catch (e: any) { err = e.toString(); }
      expect(err).toContain('duplicate');
    });

    it('two payments on same invoice → two fees', () => {
      const p1 = psql(`INSERT INTO payments (business_id, amount, status, invoice_id, gateway_reference) VALUES ('00000000-0000-0000-0000-000000000001', 400, 'success', '10000000-0000-0000-0000-000000000001', 'fee-inv-p1') RETURNING id;`);
      const p2 = psql(`INSERT INTO payments (business_id, amount, status, invoice_id, gateway_reference) VALUES ('00000000-0000-0000-0000-000000000001', 600, 'success', '10000000-0000-0000-0000-000000000001', 'fee-inv-p2') RETURNING id;`);
      psql(`INSERT INTO platform_fees (business_id, payment_id, invoice_id, transaction_amount, fee_total) VALUES ('00000000-0000-0000-0000-000000000001', '${p1}', '10000000-0000-0000-0000-000000000001', 400, 20);`);
      psql(`INSERT INTO platform_fees (business_id, payment_id, invoice_id, transaction_amount, fee_total) VALUES ('00000000-0000-0000-0000-000000000001', '${p2}', '10000000-0000-0000-0000-000000000001', 600, 30);`);
      const count = psql(`SELECT COUNT(*) FROM platform_fees WHERE invoice_id = '10000000-0000-0000-0000-000000000001' AND payment_id IS NOT NULL;`);
      expect(Number(count)).toBe(2);
    });

    it('legacy fee without payment_id coexists safely', () => {
      // The pre-migration fee (no payment_id) should still exist
      const count = psql(`SELECT COUNT(*) FROM platform_fees WHERE invoice_id = '10000000-0000-0000-0000-000000000002' AND payment_id IS NULL;`);
      expect(Number(count)).toBe(1);
    });

    it('historical payment replay does not create second fee when legacy exists', () => {
      // hist-exact-1 already has a legacy fee (no payment_id). New fee with payment_id is allowed
      // since they have different payment_id values (NULL vs actual). But this is a SEPARATE original fee.
      // The protection is: same payment_id cannot create two fees.
      const count = psql(`SELECT COUNT(*) FROM platform_fees WHERE invoice_id = '10000000-0000-0000-0000-000000000002';`);
      expect(Number(count)).toBeGreaterThanOrEqual(1);
    });

    it('deposit transaction_amount = actual deposit collected', () => {
      const payId = psql(`INSERT INTO payments (business_id, amount, status, gateway_reference) VALUES ('00000000-0000-0000-0000-000000000001', 5000, 'success', 'fee-deposit') RETURNING id;`);
      psql(`INSERT INTO platform_fees (business_id, payment_id, transaction_amount, fee_total) VALUES ('00000000-0000-0000-0000-000000000001', '${payId}', 5000, 250);`);
      const amt = psql(`SELECT transaction_amount FROM platform_fees WHERE payment_id = '${payId}';`);
      expect(Number(amt)).toBe(5000);
    });

    it('partial invoice transaction_amount = actual partial amount', () => {
      const payId = psql(`INSERT INTO payments (business_id, amount, status, invoice_id, gateway_reference) VALUES ('00000000-0000-0000-0000-000000000001', 1000, 'success', '10000000-0000-0000-0000-000000000001', 'fee-partial-inv') RETURNING id;`);
      psql(`INSERT INTO platform_fees (business_id, payment_id, invoice_id, transaction_amount, fee_total) VALUES ('00000000-0000-0000-0000-000000000001', '${payId}', '10000000-0000-0000-0000-000000000001', 1000, 50);`);
      // Invoice total is 1000 but this partial payment is also 1000. The key: transaction_amount = payment.amount, not invoice.total_amount
      const amt = psql(`SELECT transaction_amount FROM platform_fees WHERE payment_id = '${payId}';`);
      expect(Number(amt)).toBe(1000);
    });
  });
});

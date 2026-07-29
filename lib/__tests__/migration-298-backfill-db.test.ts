/**
 * Migration 298 — Real PostgreSQL Behavioural Tests
 *
 * Verifies that Migration 298 correctly backfills payments.order_id from
 * metadata->>'order_id' for exactly 11 verified legacy rows, and that all
 * safety guards (count check, UUID validation, timestamp boundary, ownership
 * guard, postconditions) function correctly.
 *
 * Requires TEST_DATABASE_URL environment variable (NOT staging or production).
 *
 * Local:
 *   docker run --rm -d --name m298-test -p 54324:5432 -e POSTGRES_PASSWORD=test postgres:16
 *   TEST_DATABASE_URL=postgresql://postgres:test@localhost:54324/postgres npx vitest run lib/__tests__/migration-298-backfill-db.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const MIGRATION_PATH = path.resolve(
  'supabase/migrations/298_complete_order_payment_backfill.sql',
);
const dbUrl = process.env.TEST_DATABASE_URL;

if (!dbUrl) {
  describe.skip(
    'Migration 298: Real PostgreSQL backfill tests (TEST_DATABASE_URL not set)',
    () => {
      it('skipped — set TEST_DATABASE_URL to enable', () => {});
    },
  );
} else {
  function runSQL(sql: string): {
    stdout: string;
    stderr: string;
    exitCode: number;
  } {
    try {
      const stdout = execSync(`psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`, {
        input: sql,
        encoding: 'utf-8',
        timeout: 15000,
      });
      return { stdout: stdout.trim(), stderr: '', exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: err.stdout?.trim() || '',
        stderr: err.stderr?.trim() || '',
        exitCode: err.status || 1,
      };
    }
  }

  const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf-8');

  // Fixed UUIDs for test data
  const ORDER_IDS = Array.from(
    { length: 12 },
    (_, i) =>
      `a2980001-0001-0001-0001-${String(i + 1).padStart(12, '0')}`,
  );
  const PAYMENT_IDS = Array.from(
    { length: 12 },
    (_, i) =>
      `a2980002-0002-0002-0002-${String(i + 1).padStart(12, '0')}`,
  );
  const BIZ_ID_A = 'a2980003-0003-0003-0003-000000000001';
  const BIZ_ID_B = 'a2980003-0003-0003-0003-000000000002';
  const BEFORE_BOUNDARY = '2026-07-28T00:00:00+00:00';
  const AFTER_BOUNDARY = '2026-07-30T00:00:00+00:00';

  function createSchema() {
    runSQL(`
      CREATE TABLE IF NOT EXISTS public.orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS public.payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id UUID REFERENCES public.orders(id),
        business_id UUID,
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
  }

  function dropSchema() {
    runSQL(`
      DROP TABLE IF EXISTS public.payments CASCADE;
      DROP TABLE IF EXISTS public.orders CASCADE;
    `);
  }

  /**
   * Insert N orders and N payments with null order_id and metadata.order_id
   * pointing to the corresponding order. All created before boundary by default.
   */
  function insertTestData(
    count: number,
    opts?: {
      paymentBusinessId?: string | null;
      orderBusinessId?: string | null;
      createdAt?: string;
      invalidUuid?: number; // index of payment to give invalid UUID
      missingOrder?: number; // index of payment whose order to NOT insert
      crossBusinessAt?: number; // index of payment to give mismatching business_id
    },
  ) {
    const payBizId = opts?.paymentBusinessId ?? null;
    const orderBizId = opts?.orderBusinessId ?? BIZ_ID_A;
    const createdAt = opts?.createdAt ?? BEFORE_BOUNDARY;

    for (let i = 0; i < count; i++) {
      const orderId = ORDER_IDS[i];
      const paymentId = PAYMENT_IDS[i];

      // Skip order insertion for missing order test
      if (opts?.missingOrder !== i) {
        runSQL(`
          INSERT INTO public.orders (id, business_id, created_at)
          VALUES ('${orderId}', ${orderBizId ? `'${orderBizId}'` : 'NULL'}, '${createdAt}');
        `);
      }

      let metaOrderId = orderId;
      if (opts?.invalidUuid === i) {
        metaOrderId = 'not-a-valid-uuid-at-all' as any;
      }

      let thisBizId = payBizId;
      if (opts?.crossBusinessAt === i) {
        thisBizId = BIZ_ID_B;
      }

      runSQL(`
        INSERT INTO public.payments (id, order_id, business_id, metadata, created_at)
        VALUES (
          '${paymentId}',
          NULL,
          ${thisBizId ? `'${thisBizId}'` : 'NULL'},
          '${JSON.stringify({ order_id: metaOrderId })}'::jsonb,
          '${createdAt}'
        );
      `);
    }
  }

  describe('Migration 298: Real PostgreSQL backfill tests', () => {
    beforeEach(() => {
      dropSchema();
      createSchema();
    });

    afterEach(() => {
      dropSchema();
    });

    // ── Test 1: Happy path — exactly 11 valid rows with null business_id ──

    it('backfills order_id for exactly 11 valid rows with null business_id', () => {
      insertTestData(11, { paymentBusinessId: null });

      const result = runSQL(migrationSql);
      expect(result.exitCode).toBe(0);

      // Verify all 11 now have order_id set
      const updated = runSQL(
        `SELECT COUNT(*) FROM public.payments WHERE order_id IS NOT NULL;`,
      );
      expect(updated.stdout).toBe('11');

      // Verify each payment's order_id matches its metadata
      const mismatches = runSQL(`
        SELECT COUNT(*) FROM public.payments p
        WHERE p.order_id::text != TRIM(p.metadata->>'order_id');
      `);
      expect(mismatches.stdout).toBe('0');
    });

    // ── Test 2: 11 valid rows with matching non-null business_id ──

    it('succeeds when payment business_id matches order business_id', () => {
      insertTestData(11, {
        paymentBusinessId: BIZ_ID_A,
        orderBusinessId: BIZ_ID_A,
      });

      const result = runSQL(migrationSql);
      expect(result.exitCode).toBe(0);

      const updated = runSQL(
        `SELECT COUNT(*) FROM public.payments WHERE order_id IS NOT NULL;`,
      );
      expect(updated.stdout).toBe('11');
    });

    // ── Test 3: Cross-business mismatch ──

    it('aborts on cross-business ownership conflict with zero changes', () => {
      // 10 valid + 1 cross-business mismatch
      insertTestData(11, {
        paymentBusinessId: BIZ_ID_A,
        orderBusinessId: BIZ_ID_A,
        crossBusinessAt: 10,
      });

      const result = runSQL(migrationSql);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('ABORTED');

      // Verify zero changes
      const updated = runSQL(
        `SELECT COUNT(*) FROM public.payments WHERE order_id IS NOT NULL;`,
      );
      expect(updated.stdout).toBe('0');
    });

    // ── Test 4: Invalid UUID metadata ──

    it('aborts when metadata contains invalid UUID', () => {
      insertTestData(11, {
        paymentBusinessId: null,
        invalidUuid: 5,
      });

      const result = runSQL(migrationSql);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('ABORTED');

      const updated = runSQL(
        `SELECT COUNT(*) FROM public.payments WHERE order_id IS NOT NULL;`,
      );
      expect(updated.stdout).toBe('0');
    });

    // ── Test 5: Missing order ──

    it('aborts when metadata order_id references non-existent order', () => {
      insertTestData(11, {
        paymentBusinessId: null,
        missingOrder: 3,
      });

      const result = runSQL(migrationSql);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('ABORTED');

      const updated = runSQL(
        `SELECT COUNT(*) FROM public.payments WHERE order_id IS NOT NULL;`,
      );
      expect(updated.stdout).toBe('0');
    });

    // ── Test 6: Count != 11 ──

    it('aborts when pending count is not 11 (too few)', () => {
      insertTestData(5, { paymentBusinessId: null });

      const result = runSQL(migrationSql);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('expected 11 pending rows but found 5');

      const updated = runSQL(
        `SELECT COUNT(*) FROM public.payments WHERE order_id IS NOT NULL;`,
      );
      expect(updated.stdout).toBe('0');
    });

    it('aborts when pending count is not 11 (too many)', () => {
      insertTestData(12, { paymentBusinessId: null });

      const result = runSQL(migrationSql);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('expected 11 pending rows but found 12');

      const updated = runSQL(
        `SELECT COUNT(*) FROM public.payments WHERE order_id IS NOT NULL;`,
      );
      expect(updated.stdout).toBe('0');
    });

    // ── Test 7: Row created after timestamp boundary ──

    it('aborts when a pending row was created after the verification boundary', () => {
      // 10 before boundary, 1 after
      insertTestData(10, { paymentBusinessId: null });
      // Insert 11th with future timestamp
      const orderId = ORDER_IDS[10];
      const paymentId = PAYMENT_IDS[10];
      runSQL(`
        INSERT INTO public.orders (id, business_id, created_at)
        VALUES ('${orderId}', '${BIZ_ID_A}', '${AFTER_BOUNDARY}');
      `);
      runSQL(`
        INSERT INTO public.payments (id, order_id, business_id, metadata, created_at)
        VALUES ('${paymentId}', NULL, NULL,
          '${JSON.stringify({ order_id: orderId })}'::jsonb,
          '${AFTER_BOUNDARY}');
      `);

      const result = runSQL(migrationSql);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('after the verification boundary');

      const updated = runSQL(
        `SELECT COUNT(*) FROM public.payments WHERE order_id IS NOT NULL;`,
      );
      expect(updated.stdout).toBe('0');
    });

    // ── Test 8: Existing non-null order_id never overwritten ──

    it('does not overwrite existing non-null order_id', () => {
      // Insert 11 pending rows for the migration
      insertTestData(11, { paymentBusinessId: null });

      // Also insert a payment that already has order_id set
      const existingOrderId = 'a2980099-0099-0099-0099-000000000099';
      const existingPayId = 'a2980099-0099-0099-0099-000000000098';
      const differentOrderId = ORDER_IDS[0]; // points to a different order via metadata
      runSQL(`
        INSERT INTO public.orders (id, business_id, created_at)
        VALUES ('${existingOrderId}', '${BIZ_ID_A}', '${BEFORE_BOUNDARY}');
      `);
      runSQL(`
        INSERT INTO public.payments (id, order_id, business_id, metadata, created_at)
        VALUES ('${existingPayId}', '${existingOrderId}', NULL,
          '${JSON.stringify({ order_id: differentOrderId })}'::jsonb,
          '${BEFORE_BOUNDARY}');
      `);

      const result = runSQL(migrationSql);
      expect(result.exitCode).toBe(0);

      // Verify the pre-existing payment still has its original order_id
      const preserved = runSQL(
        `SELECT order_id::text FROM public.payments WHERE id = '${existingPayId}';`,
      );
      expect(preserved.stdout).toBe(existingOrderId);
    });

    // ── Test 9: Rows without metadata.order_id are untouched ──

    it('does not touch rows without metadata order_id', () => {
      insertTestData(11, { paymentBusinessId: null });

      // Insert a payment with no metadata order_id
      const noMetaPayId = 'a2980099-0099-0099-0099-000000000097';
      runSQL(`
        INSERT INTO public.payments (id, order_id, business_id, metadata, created_at)
        VALUES ('${noMetaPayId}', NULL, NULL, '{}'::jsonb, '${BEFORE_BOUNDARY}');
      `);

      const result = runSQL(migrationSql);
      expect(result.exitCode).toBe(0);

      // Verify the no-metadata payment still has null order_id
      const untouched = runSQL(
        `SELECT order_id IS NULL FROM public.payments WHERE id = '${noMetaPayId}';`,
      );
      expect(untouched.stdout).toBe('t');
    });

    // ── Test 10: Idempotent — second execution succeeds with zero changes ──

    it('second execution succeeds with zero changes (idempotent)', () => {
      insertTestData(11, { paymentBusinessId: null });

      // First run
      const first = runSQL(migrationSql);
      expect(first.exitCode).toBe(0);

      // Second run — should exit cleanly (0 pending rows)
      const second = runSQL(migrationSql);
      expect(second.exitCode).toBe(0);

      // All 11 still have order_id set
      const count = runSQL(
        `SELECT COUNT(*) FROM public.payments WHERE order_id IS NOT NULL;`,
      );
      expect(count.stdout).toBe('11');
    });

    // ── Test 11: Failure cases leave business_id unchanged ──

    it('failure cases leave business_id completely unchanged', () => {
      // Set up 11 rows but with invalid UUID at index 5 to trigger abort
      insertTestData(11, {
        paymentBusinessId: BIZ_ID_A,
        orderBusinessId: BIZ_ID_A,
        invalidUuid: 5,
      });

      // Record business_ids before
      const beforeBizIds = runSQL(`
        SELECT business_id::text FROM public.payments ORDER BY id;
      `);

      const result = runSQL(migrationSql);
      expect(result.exitCode).not.toBe(0);

      // Verify business_ids unchanged
      const afterBizIds = runSQL(`
        SELECT business_id::text FROM public.payments ORDER BY id;
      `);
      expect(afterBizIds.stdout).toBe(beforeBizIds.stdout);

      // Verify zero order_ids set
      const updated = runSQL(
        `SELECT COUNT(*) FROM public.payments WHERE order_id IS NOT NULL;`,
      );
      expect(updated.stdout).toBe('0');
    });
  });
} // end of if (dbUrl)

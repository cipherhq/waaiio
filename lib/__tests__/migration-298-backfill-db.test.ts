/**
 * Migration 298 — Real PostgreSQL Behavioural Tests
 *
 * Verifies that Migration 298 correctly backfills payments.order_id from
 * metadata->>'order_id' for exactly 11 verified legacy rows, and that all
 * safety guards (count check, UUID validation, timestamp boundary, ownership
 * guard, postconditions, immutability snapshot) function correctly.
 *
 * SAFETY REQUIREMENTS:
 *   - TEST_DATABASE_URL must point to localhost or 127.0.0.1
 *   - Database name must be exactly waaiio_m298_test (or end in _m298_test)
 *   - Must NOT contain any Supabase production hostname
 *   - The test suite will FAIL (not skip) if these checks are violated
 *
 * CI:
 *   The GitHub Actions workflow creates a dedicated waaiio_m298_test database
 *   for this test file only. It is dropped after the test completes.
 *
 * Local:
 *   createdb waaiio_m298_test
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/waaiio_m298_test \
 *     npx vitest run lib/__tests__/migration-298-backfill-db.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const MIGRATION_PATH = path.resolve(
  'supabase/migrations/298_complete_order_payment_backfill.sql',
);
const dbUrl = process.env.TEST_DATABASE_URL;

// ══════════════════════════════════════════════════════════════
// DATABASE URL SAFETY GUARD
// ══════════════════════════════════════════════════════════════

function validateDatabaseUrl(url: string | undefined): url is string {
  if (!url) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const hostname = parsed.hostname;
  const isLocal =
    hostname === 'localhost' || hostname === '127.0.0.1';

  // Extract database name from path (e.g., /waaiio_m298_test → waaiio_m298_test)
  const dbName = parsed.pathname.replace(/^\//, '');
  const isDedicatedDb = dbName === 'waaiio_m298_test' || dbName.endsWith('_m298_test');

  const containsSupabase = url.includes('supabase.co') || url.includes('supabase.in');

  return isLocal && isDedicatedDb && !containsSupabase;
}

// No URL → skip (the dedicated CI step sets it; main-app job does not)
// Unsafe URL → fail immediately (not skip)
if (!dbUrl) {
  describe.skip(
    'Migration 298: Real PostgreSQL backfill tests (TEST_DATABASE_URL not set)',
    () => {
      it('skipped — set TEST_DATABASE_URL to enable', () => {});
    },
  );
} else if (!validateDatabaseUrl(dbUrl)) {
  describe('Migration 298: Database URL safety check', () => {
    it('REFUSES to run against an unsafe database URL', () => {
      throw new Error(
        `TEST_DATABASE_URL is unsafe for destructive operations. ` +
        `Required: hostname=localhost|127.0.0.1, database name ending in _m298_test, ` +
        `no Supabase production hostname. Got: ${dbUrl.replace(/\/\/[^@]*@/, '//***@')}`,
      );
    });
  });
} else {
  // ── URL validated — proceed with tests ──

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
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return {
        stdout: (e.stdout ?? '').trim(),
        stderr: (e.stderr ?? '').trim(),
        exitCode: e.status ?? 1,
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

  function createSchema(): void {
    const result = runSQL(`
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
    if (result.exitCode !== 0) {
      throw new Error(`Schema creation failed: ${result.stderr}`);
    }
  }

  function dropSchema(): void {
    const result = runSQL(`
      DROP TABLE IF EXISTS public.payments CASCADE;
      DROP TABLE IF EXISTS public.orders CASCADE;
    `);
    if (result.exitCode !== 0) {
      throw new Error(`Schema drop failed: ${result.stderr}`);
    }
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
  ): void {
    const payBizId = opts?.paymentBusinessId ?? null;
    const orderBizId = opts?.orderBusinessId ?? BIZ_ID_A;
    const createdAt = opts?.createdAt ?? BEFORE_BOUNDARY;

    for (let i = 0; i < count; i++) {
      const orderId = ORDER_IDS[i];
      const paymentId = PAYMENT_IDS[i];

      // Skip order insertion for missing order test
      if (opts?.missingOrder !== i) {
        const orderResult = runSQL(`
          INSERT INTO public.orders (id, business_id, created_at)
          VALUES ('${orderId}', ${orderBizId ? `'${orderBizId}'` : 'NULL'}, '${createdAt}');
        `);
        if (orderResult.exitCode !== 0) {
          throw new Error(`Order insert failed at index ${i}: ${orderResult.stderr}`);
        }
      }

      let metaOrderId: string = orderId;
      if (opts?.invalidUuid === i) {
        metaOrderId = 'not-a-valid-uuid-at-all';
      }

      let thisBizId = payBizId;
      if (opts?.crossBusinessAt === i) {
        thisBizId = BIZ_ID_B;
      }

      const payResult = runSQL(`
        INSERT INTO public.payments (id, order_id, business_id, metadata, created_at)
        VALUES (
          '${paymentId}',
          NULL,
          ${thisBizId ? `'${thisBizId}'` : 'NULL'},
          '${JSON.stringify({ order_id: metaOrderId })}'::jsonb,
          '${createdAt}'
        );
      `);
      if (payResult.exitCode !== 0) {
        throw new Error(`Payment insert failed at index ${i}: ${payResult.stderr}`);
      }
    }
  }

  describe('Migration 298: Real PostgreSQL backfill tests', () => {
    beforeEach(() => {
      dropSchema();
      createSchema();
    });

    afterEach(() => {
      // Clean up triggers that tests may have installed
      runSQL(`DROP FUNCTION IF EXISTS _m298_test_trigger_fn() CASCADE;`);
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

    // ── Test 3: Null business_id snapshot immutability ──

    it('preserves all non-order_id columns for null-business-id rows', () => {
      insertTestData(11, { paymentBusinessId: null });

      // Snapshot all columns except order_id before migration
      const beforeSnapshot = runSQL(`
        SELECT jsonb_agg(to_jsonb(p) - 'order_id' ORDER BY p.id)::text
        FROM public.payments p;
      `);

      const result = runSQL(migrationSql);
      expect(result.exitCode).toBe(0);

      // Same snapshot after migration
      const afterSnapshot = runSQL(`
        SELECT jsonb_agg(to_jsonb(p) - 'order_id' ORDER BY p.id)::text
        FROM public.payments p;
      `);

      expect(afterSnapshot.stdout).toBe(beforeSnapshot.stdout);
    });

    // ── Test 4: Cross-business mismatch ──

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

    // ── Test 5: Invalid UUID metadata ──

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

    // ── Test 6: Missing order ──

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

    // ── Test: Null order business_id ──

    it('aborts when a referenced order has NULL business_id', () => {
      // Insert 11 rows, but make one order have NULL business_id
      insertTestData(11, { paymentBusinessId: null });
      // Set one order's business_id to NULL
      runSQL(`UPDATE public.orders SET business_id = NULL WHERE id = (SELECT id FROM public.orders LIMIT 1);`);

      const result = runSQL(migrationSql);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('NULL business_id');

      // Zero rows changed
      const updated = runSQL(
        `SELECT COUNT(*) FROM public.payments WHERE order_id IS NOT NULL;`,
      );
      expect(updated.stdout).toBe('0');
    });

    // ── Test 7: Count != 11 ──

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

    // ── Test 8: Row created after timestamp boundary ──

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

    // ── Test 9: Existing non-null order_id never overwritten ──

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

    // ── Test 10: Rows without metadata.order_id are untouched ──

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

    // ── Test 11: Idempotent — second execution succeeds with zero changes ──

    it('second execution succeeds with zero changes (idempotent)', () => {
      insertTestData(11, { paymentBusinessId: null });

      // First run — changes exactly 11 order_id values
      const first = runSQL(migrationSql);
      expect(first.exitCode).toBe(0);

      const afterFirst = runSQL(
        `SELECT COUNT(*) FROM public.payments WHERE order_id IS NOT NULL;`,
      );
      expect(afterFirst.stdout).toBe('11');

      // Second run — should exit cleanly (0 pending rows)
      const second = runSQL(migrationSql);
      expect(second.exitCode).toBe(0);

      // All 11 still have order_id set
      const afterSecond = runSQL(
        `SELECT COUNT(*) FROM public.payments WHERE order_id IS NOT NULL;`,
      );
      expect(afterSecond.stdout).toBe('11');
    });

    // ── Test 12: Trigger side-effect detection ──

    it('aborts when a trigger modifies business_id during order_id update', () => {
      insertTestData(11, { paymentBusinessId: null });

      // Install a synthetic trigger that changes business_id when order_id changes
      const triggerResult = runSQL(`
        CREATE OR REPLACE FUNCTION _m298_test_trigger_fn()
        RETURNS TRIGGER AS $tr$
        BEGIN
          IF NEW.order_id IS DISTINCT FROM OLD.order_id THEN
            NEW.business_id := 'a2980099-0099-0099-0099-000000000001'::uuid;
          END IF;
          RETURN NEW;
        END;
        $tr$ LANGUAGE plpgsql;

        CREATE TRIGGER _m298_test_side_effect
          BEFORE UPDATE ON public.payments
          FOR EACH ROW
          EXECUTE FUNCTION _m298_test_trigger_fn();
      `);
      expect(triggerResult.exitCode).toBe(0);

      // Run migration — should detect the immutability violation
      const result = runSQL(migrationSql);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('immutability violation');

      // Verify complete rollback — zero order_id values changed
      const updated = runSQL(
        `SELECT COUNT(*) FROM public.payments WHERE order_id IS NOT NULL;`,
      );
      expect(updated.stdout).toBe('0');
    });

    // ── Test 13: Trigger side-effect on metadata ──

    it('aborts when a trigger modifies metadata during order_id update', () => {
      insertTestData(11, { paymentBusinessId: null });

      // Trigger that adds a key to metadata when order_id changes
      const triggerResult = runSQL(`
        CREATE OR REPLACE FUNCTION _m298_test_trigger_fn()
        RETURNS TRIGGER AS $tr$
        BEGIN
          IF NEW.order_id IS DISTINCT FROM OLD.order_id THEN
            NEW.metadata := NEW.metadata || '{"_migrated": true}'::jsonb;
          END IF;
          RETURN NEW;
        END;
        $tr$ LANGUAGE plpgsql;

        CREATE TRIGGER _m298_test_side_effect
          BEFORE UPDATE ON public.payments
          FOR EACH ROW
          EXECUTE FUNCTION _m298_test_trigger_fn();
      `);
      expect(triggerResult.exitCode).toBe(0);

      const result = runSQL(migrationSql);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('immutability violation');

      // Verify complete rollback
      const updated = runSQL(
        `SELECT COUNT(*) FROM public.payments WHERE order_id IS NOT NULL;`,
      );
      expect(updated.stdout).toBe('0');

      // Verify metadata unchanged (no _migrated key)
      const metadataCheck = runSQL(`
        SELECT COUNT(*) FROM public.payments
        WHERE metadata ? '_migrated';
      `);
      expect(metadataCheck.stdout).toBe('0');
    });

    // ── Test 14: Failure cases leave all rows byte-for-byte equivalent ──

    it('failure cases preserve all target row data exactly', () => {
      // Set up 11 rows with invalid UUID at index 5 to trigger abort
      insertTestData(11, {
        paymentBusinessId: BIZ_ID_A,
        orderBusinessId: BIZ_ID_A,
        invalidUuid: 5,
      });

      // Full snapshot before
      const beforeSnapshot = runSQL(`
        SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id)::text
        FROM public.payments p;
      `);

      const result = runSQL(migrationSql);
      expect(result.exitCode).not.toBe(0);

      // Full snapshot after — must be identical
      const afterSnapshot = runSQL(`
        SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id)::text
        FROM public.payments p;
      `);
      expect(afterSnapshot.stdout).toBe(beforeSnapshot.stdout);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // DATABASE URL SAFETY GUARD — unit tests
  // ══════════════════════════════════════════════════════════════

  describe('Migration 298: Database URL safety guard', () => {
    it('accepts localhost with waaiio_m298_test', () => {
      expect(
        validateDatabaseUrl('postgresql://postgres:postgres@localhost:5432/waaiio_m298_test'),
      ).toBe(true);
    });

    it('accepts 127.0.0.1 with waaiio_m298_test', () => {
      expect(
        validateDatabaseUrl('postgresql://postgres:postgres@127.0.0.1:5432/waaiio_m298_test'),
      ).toBe(true);
    });

    it('accepts custom database name ending in _m298_test', () => {
      expect(
        validateDatabaseUrl('postgresql://postgres:postgres@localhost:5432/my_m298_test'),
      ).toBe(true);
    });

    it('rejects Supabase production URL', () => {
      expect(
        validateDatabaseUrl('postgresql://postgres:pass@db.synthetic-project.supabase.co:5432/postgres'),
      ).toBe(false);
    });

    it('rejects non-local hostname', () => {
      expect(
        validateDatabaseUrl('postgresql://postgres:pass@db.example.com:5432/waaiio_m298_test'),
      ).toBe(false);
    });

    it('rejects wrong database name', () => {
      expect(
        validateDatabaseUrl('postgresql://postgres:postgres@localhost:5432/waaiio_test'),
      ).toBe(false);
    });

    it('rejects undefined URL', () => {
      expect(validateDatabaseUrl(undefined)).toBe(false);
    });

    it('rejects empty string', () => {
      expect(validateDatabaseUrl('')).toBe(false);
    });
  });
} // end of if (dbUrl)

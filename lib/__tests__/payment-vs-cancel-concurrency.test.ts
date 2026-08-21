/**
 * Payment finalization vs payment-step cancellation — real PostgreSQL concurrency test.
 * Requires TEST_DATABASE_URL.
 *
 * Proves that when a customer taps Cancel while the Payment Authority
 * is confirming their booking, one side wins safely and the loser
 * cannot overwrite the winner.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execSync, spawn } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  }).trim();
}
function psqlJson(sql: string): Record<string, unknown> {
  const r = psql(sql);
  return r ? JSON.parse(r) : {};
}

const BIZ = '00000000-0000-0000-0160-000000000001';
const BOOKING = '00000000-0000-0000-0160-000000000010';
const PAY = '00000000-0000-0000-0160-000000000020';

describe.skipIf(!canRun)('Payment finalization vs cancellation concurrency', () => {
  beforeAll(() => {
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE TYPE booking_status AS ENUM ('pending','confirmed','in_progress','completed','no_show','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role;

      CREATE TABLE IF NOT EXISTS businesses (id UUID PRIMARY KEY, name TEXT DEFAULT 'Test');
      CREATE TABLE IF NOT EXISTS bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID, status booking_status DEFAULT 'pending',
        deposit_status TEXT DEFAULT 'pending',
        reference_code TEXT DEFAULT 'BK-TEST',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        booking_id UUID, status TEXT DEFAULT 'pending',
        amount INT DEFAULT 0, gateway_reference TEXT,
        finalization_processing_at TIMESTAMPTZ
      );

      INSERT INTO businesses (id, name) VALUES ('${BIZ}', 'ConcurrencyTest') ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(() => {
    if (!canRun) return;
    psql(`
      DELETE FROM payments WHERE id = '${PAY}';
      DELETE FROM bookings WHERE id = '${BOOKING}';
      DELETE FROM businesses WHERE id = '${BIZ}';
    `);
  });

  beforeEach(() => {
    psql(`
      DELETE FROM payments WHERE id = '${PAY}';
      DELETE FROM bookings WHERE id = '${BOOKING}';
    `);
  });

  function psqlAsync(sql: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
      const child = spawn('psql', [dbUrl, '-tAXq', '-v', 'ON_ERROR_STOP=1'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('close', (code: number) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 0 }));
      child.stdin.write(sql);
      child.stdin.end();
    });
  }

  it('1. payment confirmation wins → cancellation has no effect', () => {
    psql(`
      INSERT INTO bookings (id, business_id, status, deposit_status)
        VALUES ('${BOOKING}', '${BIZ}', 'pending', 'pending');
    `);

    // Payment Authority confirms booking (simulates processSuccessfulPayment)
    psql(`
      UPDATE bookings SET status = 'confirmed', deposit_status = 'paid'
      WHERE id = '${BOOKING}' AND status IN ('pending');
    `);

    // Customer taps Cancel — CAS-style guard prevents overwriting confirmed booking
    const cancelResult = psql(`
      UPDATE bookings SET status = 'cancelled'
      WHERE id = '${BOOKING}' AND status IN ('pending')
      RETURNING id;
    `);
    // No rows returned — booking is no longer pending
    expect(cancelResult).toBe('');

    // Booking remains confirmed
    const status = psql(`SELECT status FROM bookings WHERE id = '${BOOKING}';`);
    expect(status).toBe('confirmed');
    const deposit = psql(`SELECT deposit_status FROM bookings WHERE id = '${BOOKING}';`);
    expect(deposit).toBe('paid');
  });

  it('2. cancellation wins → payment confirmation has no effect', () => {
    psql(`
      INSERT INTO bookings (id, business_id, status, deposit_status)
        VALUES ('${BOOKING}', '${BIZ}', 'pending', 'pending');
    `);

    // Customer cancels first
    psql(`
      UPDATE bookings SET status = 'cancelled'
      WHERE id = '${BOOKING}' AND status IN ('pending');
    `);

    // Payment Authority tries to confirm — but booking is cancelled
    const confirmResult = psql(`
      UPDATE bookings SET status = 'confirmed', deposit_status = 'paid'
      WHERE id = '${BOOKING}' AND status IN ('pending')
      RETURNING id;
    `);
    // No rows returned — booking is no longer pending
    expect(confirmResult).toBe('');

    // Booking remains cancelled
    const status = psql(`SELECT status FROM bookings WHERE id = '${BOOKING}';`);
    expect(status).toBe('cancelled');
  });

  it('3. REAL concurrency: payment confirmation holds lock, cancellation waits then fails', async () => {
    psql(`
      INSERT INTO bookings (id, business_id, status, deposit_status)
        VALUES ('${BOOKING}', '${BIZ}', 'pending', 'pending');
    `);

    // Session A (payment confirmation): lock booking row, confirm, hold for 2s
    const sessionA = psqlAsync(`
      BEGIN;
      UPDATE bookings SET status = 'confirmed', deposit_status = 'paid'
      WHERE id = '${BOOKING}' AND status IN ('pending');
      SELECT pg_sleep(2);
      COMMIT;
    `);

    await new Promise(r => setTimeout(r, 300));

    // Session B (cancellation): tries to cancel — blocks on row lock
    const bStart = Date.now();
    const sessionB = psqlAsync(`
      UPDATE bookings SET status = 'cancelled'
      WHERE id = '${BOOKING}' AND status IN ('pending')
      RETURNING id;
    `);

    const [resultA, resultB] = await Promise.all([sessionA, sessionB]);
    const bDuration = Date.now() - bStart;

    // Prove contention: B waited >1s
    expect(bDuration).toBeGreaterThan(1000);
    expect(resultA.code).toBe(0);

    // B's cancellation returned 0 rows (booking already confirmed)
    const bLines = resultB.stdout.split('\n').filter((l: string) => l.trim());
    const cancelledId = bLines.some((l: string) => l.match(/^[0-9a-f-]{36}$/));
    expect(cancelledId).toBe(false);

    // Final state: confirmed, not cancelled
    const status = psql(`SELECT status FROM bookings WHERE id = '${BOOKING}';`);
    expect(status).toBe('confirmed');
  }, 15000);

  it('4. REAL concurrency: cancellation holds lock, payment confirmation waits then fails', async () => {
    psql(`
      INSERT INTO bookings (id, business_id, status, deposit_status)
        VALUES ('${BOOKING}', '${BIZ}', 'pending', 'pending');
    `);

    // Session A (cancellation): lock row, cancel, hold for 2s
    const sessionA = psqlAsync(`
      BEGIN;
      UPDATE bookings SET status = 'cancelled'
      WHERE id = '${BOOKING}' AND status IN ('pending');
      SELECT pg_sleep(2);
      COMMIT;
    `);

    await new Promise(r => setTimeout(r, 300));

    // Session B (payment confirmation): blocks on row lock
    const bStart = Date.now();
    const sessionB = psqlAsync(`
      UPDATE bookings SET status = 'confirmed', deposit_status = 'paid'
      WHERE id = '${BOOKING}' AND status IN ('pending')
      RETURNING id;
    `);

    const [resultA, resultB] = await Promise.all([sessionA, sessionB]);
    const bDuration = Date.now() - bStart;

    expect(bDuration).toBeGreaterThan(1000);
    expect(resultA.code).toBe(0);

    // B's confirmation returned 0 rows
    const bLines = resultB.stdout.split('\n').filter((l: string) => l.trim());
    const confirmedId = bLines.some((l: string) => l.match(/^[0-9a-f-]{36}$/));
    expect(confirmedId).toBe(false);

    // Final state: cancelled
    const status = psql(`SELECT status FROM bookings WHERE id = '${BOOKING}';`);
    expect(status).toBe('cancelled');
  }, 15000);
});

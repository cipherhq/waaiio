/**
 * M464: Atomic Customer Subscription Failure — Real PostgreSQL Tests
 *
 * Requires TEST_DATABASE_URL environment variable.
 *
 * Local:
 *   docker run --rm -d --name m464-test -p 54324:5432 -e POSTGRES_PASSWORD=test postgres:16
 *   TEST_DATABASE_URL=postgresql://postgres:test@localhost:54324/postgres npx vitest run lib/__tests__/464-atomic-failure-db.test.ts
 *
 * Proves against REAL PostgreSQL with true concurrent connections:
 *   1. Single call: one charge record + exactly one failure_count increment
 *   2. Idempotent replay: already_processed=true, no mutation
 *   3. TRUE CONCURRENT calls via two psql sessions with pg_sleep contention
 *   4. TRUE ROLLBACK: explicit ROLLBACK mid-transaction, verify cleanup, then retry
 *   5. Terminal status: accepted without mutation
 *   6. Input validation: null subscription_id / empty gateway_reference
 *   7. Escalation at threshold
 *   8. UNIQUE index prevents duplicate charge records
 *   9. NULL gateway_reference not constrained by partial UNIQUE index
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const dbUrl = process.env.TEST_DATABASE_URL;

function psql(sql: string): string {
  const raw = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 30000,
  });
  return raw.split('\n').filter(l => {
    const t = l.trim();
    return t !== '' && !/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|DO|SET|COMMENT)\b/.test(t);
  }).join('\n').trim();
}

function psqlJson(sql: string): unknown {
  const raw = psql(sql);
  return raw ? JSON.parse(raw) : null;
}

/** Spawn an independent psql connection (for true concurrent testing) */
function psqlAsync(sql: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn('psql', [dbUrl!, '-tAXq', '-v', 'ON_ERROR_STOP=1'], {
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

const describePg = dbUrl ? describe : describe.skip;

describePg('M464: Atomic customer subscription failure (real PG)', () => {
  beforeAll(() => {
    // Create minimal schema
    psql(`
      CREATE TABLE IF NOT EXISTS customer_subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL DEFAULT gen_random_uuid(),
        service_id UUID,
        amount NUMERIC DEFAULT 0,
        currency VARCHAR DEFAULT 'NGN',
        frequency VARCHAR DEFAULT 'monthly',
        status VARCHAR NOT NULL DEFAULT 'active',
        gateway VARCHAR DEFAULT 'paystack',
        gateway_subscription_code TEXT,
        failure_count INT DEFAULT 0,
        customer_name TEXT,
        customer_phone TEXT,
        cancelled_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS subscription_charges (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        subscription_id UUID NOT NULL,
        business_id UUID NOT NULL DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL DEFAULT gen_random_uuid(),
        amount NUMERIC DEFAULT 0,
        currency VARCHAR DEFAULT 'NGN',
        status VARCHAR DEFAULT 'failed',
        gateway VARCHAR DEFAULT 'paystack',
        gateway_reference TEXT,
        failure_reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Apply M464 migration
    const migrationSql = readFileSync(
      resolve(__dirname, '../../docs/migrations/pending/464_atomic_customer_subscription_failure.sql'),
      'utf-8',
    );
    psql(migrationSql);
  });

  afterAll(() => {
    psql(`
      DROP FUNCTION IF EXISTS record_customer_subscription_failure(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INT);
      DROP INDEX IF EXISTS idx_subscription_charges_gateway_ref_unique;
      DROP TABLE IF EXISTS subscription_charges CASCADE;
      DROP TABLE IF EXISTS customer_subscriptions CASCADE;
    `);
  });

  it('1. Single call: one charge + exactly one increment', () => {
    const subId = psql(`INSERT INTO customer_subscriptions (status, failure_count) VALUES ('active', 0) RETURNING id`);
    const result = psqlJson(`
      SELECT record_customer_subscription_failure(
        '${subId}'::uuid, gen_random_uuid(), gen_random_uuid(),
        'NGN', 'paystack', 'evt-single-001', 'Insufficient funds', 3
      )
    `) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.already_processed).toBe(false);
    expect(result.new_failure_count).toBe(1);
    expect(result.escalated).toBe(false);

    const failCount = psql(`SELECT failure_count FROM customer_subscriptions WHERE id = '${subId}'`);
    expect(failCount).toBe('1');
    const chargeCount = psql(`SELECT count(*) FROM subscription_charges WHERE gateway_reference = 'evt-single-001'`);
    expect(chargeCount).toBe('1');
  });

  it('2. Idempotent replay: already_processed, no mutation', () => {
    const subId = psql(`INSERT INTO customer_subscriptions (status, failure_count) VALUES ('active', 0) RETURNING id`);

    // First call
    psql(`SELECT record_customer_subscription_failure('${subId}'::uuid, gen_random_uuid(), gen_random_uuid(), 'NGN', 'paystack', 'evt-replay-001', 'Failed', 3)`);

    // Second call (replay)
    const result = psqlJson(`
      SELECT record_customer_subscription_failure(
        '${subId}'::uuid, gen_random_uuid(), gen_random_uuid(),
        'NGN', 'paystack', 'evt-replay-001', 'Failed', 3
      )
    `) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.already_processed).toBe(true);

    const failCount = psql(`SELECT failure_count FROM customer_subscriptions WHERE id = '${subId}'`);
    expect(failCount).toBe('1');
    const chargeCount = psql(`SELECT count(*) FROM subscription_charges WHERE gateway_reference = 'evt-replay-001'`);
    expect(chargeCount).toBe('1');
  });

  it('3. TRUE CONCURRENT: two psql sessions, same gateway_reference, one winner', async () => {
    // Create a subscription
    const subId = psql(`INSERT INTO customer_subscriptions (status, failure_count) VALUES ('active', 0) RETURNING id`);
    const ref = 'evt-concurrent-real-001';

    // Session A: call RPC inside a transaction with pg_sleep(2) to hold the FOR UPDATE lock
    const sessionA = psqlAsync(`
      BEGIN;
      SELECT record_customer_subscription_failure(
        '${subId}'::uuid, gen_random_uuid(), gen_random_uuid(),
        'NGN', 'paystack', '${ref}', 'Session A', 3
      );
      SELECT pg_sleep(2);
      COMMIT;
    `);

    // Session B: fires 300ms after A, same gateway_reference.
    // B will block on FOR UPDATE until A releases the lock after pg_sleep.
    // After A commits: B acquires the lock, but INSERT ON CONFLICT finds A's charge → already_processed.
    await new Promise(r => setTimeout(r, 300));
    const bStart = Date.now();
    const sessionB = psqlAsync(`
      SELECT record_customer_subscription_failure(
        '${subId}'::uuid, gen_random_uuid(), gen_random_uuid(),
        'NGN', 'paystack', '${ref}', 'Session B', 3
      );
    `);

    const [resultA, resultB] = await Promise.all([sessionA, sessionB]);
    const bDuration = Date.now() - bStart;

    // Prove real contention: B waited >1s (blocked on A's FOR UPDATE during pg_sleep)
    expect(bDuration).toBeGreaterThan(1000);

    // A succeeded (committed)
    expect(resultA.code).toBe(0);
    expect(resultA.stdout).toContain('"success": true');
    expect(resultA.stdout).toContain('"already_processed": false');

    // B got already_processed (A's charge record detected)
    expect(resultB.code).toBe(0);
    expect(resultB.stdout).toContain('"already_processed": true');

    // Exactly one failure_count increment
    const failCount = psql(`SELECT failure_count FROM customer_subscriptions WHERE id = '${subId}'`);
    expect(failCount).toBe('1');

    // Exactly one charge record
    const chargeCount = psql(`SELECT count(*) FROM subscription_charges WHERE gateway_reference = '${ref}'`);
    expect(chargeCount).toBe('1');
  }, 15000); // 15s timeout for pg_sleep contention

  it('4. TRUE ROLLBACK: explicit ROLLBACK cleans up, retry succeeds', () => {
    const subId = psql(`INSERT INTO customer_subscriptions (status, failure_count) VALUES ('active', 0) RETURNING id`);
    const ref = 'evt-rollback-001';

    // Call RPC inside a transaction that we explicitly ROLLBACK
    // The ROLLBACK undoes both the charge insert and the failure_count increment.
    psql(`
      BEGIN;
      SELECT record_customer_subscription_failure(
        '${subId}'::uuid, gen_random_uuid(), gen_random_uuid(),
        'NGN', 'paystack', '${ref}', 'Will be rolled back', 3
      );
      ROLLBACK;
    `);

    // Verify ROLLBACK actually cleaned up: no charge, failure_count still 0
    const chargeAfterRollback = psql(`SELECT count(*) FROM subscription_charges WHERE gateway_reference = '${ref}'`);
    expect(chargeAfterRollback).toBe('0');
    const failAfterRollback = psql(`SELECT failure_count FROM customer_subscriptions WHERE id = '${subId}'`);
    expect(failAfterRollback).toBe('0');

    // Now retry — should succeed as if first time
    const result = psqlJson(`
      SELECT record_customer_subscription_failure(
        '${subId}'::uuid, gen_random_uuid(), gen_random_uuid(),
        'NGN', 'paystack', '${ref}', 'Retry after rollback', 3
      )
    `) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.already_processed).toBe(false);
    expect(result.new_failure_count).toBe(1);

    // Verify: one charge, failure_count = 1
    const chargeAfterRetry = psql(`SELECT count(*) FROM subscription_charges WHERE gateway_reference = '${ref}'`);
    expect(chargeAfterRetry).toBe('1');
    const failAfterRetry = psql(`SELECT failure_count FROM customer_subscriptions WHERE id = '${subId}'`);
    expect(failAfterRetry).toBe('1');
  });

  it('5. Terminal status: accepted without mutation', () => {
    const subId = psql(`INSERT INTO customer_subscriptions (status, failure_count) VALUES ('cancelled', 3) RETURNING id`);

    const result = psqlJson(`
      SELECT record_customer_subscription_failure(
        '${subId}'::uuid, gen_random_uuid(), gen_random_uuid(),
        'NGN', 'paystack', 'evt-terminal-001', 'Should not increment', 3
      )
    `) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.reason).toBe('terminal_status');
    const failCount = psql(`SELECT failure_count FROM customer_subscriptions WHERE id = '${subId}'`);
    expect(failCount).toBe('3');
  });

  it('6. Input validation: null subscription_id rejected', () => {
    const result = psqlJson(`
      SELECT record_customer_subscription_failure(
        NULL, gen_random_uuid(), gen_random_uuid(),
        'NGN', 'paystack', 'evt-null-001', 'Null test', 3
      )
    `) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.reason).toBe('null_subscription_id');
  });

  it('6b. Input validation: empty gateway_reference rejected', () => {
    const subId = psql(`INSERT INTO customer_subscriptions (status, failure_count) VALUES ('active', 0) RETURNING id`);

    const result = psqlJson(`
      SELECT record_customer_subscription_failure(
        '${subId}'::uuid, gen_random_uuid(), gen_random_uuid(),
        'NGN', 'paystack', '', 'Empty ref', 3
      )
    `) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.reason).toBe('null_gateway_reference');
  });

  it('7. Escalation at threshold (failure_count reaches 3)', () => {
    const subId = psql(`INSERT INTO customer_subscriptions (status, failure_count) VALUES ('active', 2) RETURNING id`);

    const result = psqlJson(`
      SELECT record_customer_subscription_failure(
        '${subId}'::uuid, gen_random_uuid(), gen_random_uuid(),
        'NGN', 'paystack', 'evt-escalate-001', 'Third failure', 3
      )
    `) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.new_failure_count).toBe(3);
    expect(result.new_status).toBe('past_due');
    expect(result.escalated).toBe(true);

    const status = psql(`SELECT status FROM customer_subscriptions WHERE id = '${subId}'`);
    expect(status).toBe('past_due');
  });

  it('8. UNIQUE index prevents duplicate charge records', () => {
    psql(`INSERT INTO subscription_charges (subscription_id, gateway_reference) VALUES (gen_random_uuid(), 'evt-unique-test-001')`);

    try {
      psql(`INSERT INTO subscription_charges (subscription_id, gateway_reference) VALUES (gen_random_uuid(), 'evt-unique-test-001')`);
      expect.unreachable('Should have thrown unique violation');
    } catch (e) {
      expect(String(e)).toContain('idx_subscription_charges_gateway_ref_unique');
    }
  });

  it('9. NULL gateway_reference is not constrained by UNIQUE index', () => {
    psql(`INSERT INTO subscription_charges (subscription_id, gateway_reference) VALUES (gen_random_uuid(), NULL)`);
    psql(`INSERT INTO subscription_charges (subscription_id, gateway_reference) VALUES (gen_random_uuid(), NULL)`);
    const count = psql(`SELECT count(*) FROM subscription_charges WHERE gateway_reference IS NULL`);
    expect(parseInt(count)).toBeGreaterThanOrEqual(2);
  });
});

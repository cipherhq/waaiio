/**
 * P1-QUEUE-1 + P1-QUEUE-2 — Real PostgreSQL Schema Contract Tests
 *
 * Requires TEST_DATABASE_URL environment variable.
 *
 * Local:
 *   docker run --rm -d --name queue-test -p 54323:5432 -e POSTGRES_PASSWORD=test postgres:16
 *   TEST_DATABASE_URL=postgresql://postgres:test@localhost:54323/postgres npx vitest run lib/__tests__/p1-queue-schema-contracts-db.test.ts
 *
 * Proves against REAL schema:
 * P1-QUEUE-1:
 *   1. 'cancelled' is accepted by queue_entries CHECK constraint
 *   2. Customer can leave queue (waiting → cancelled)
 *   3. Cancelled entry not counted as waiting
 *   4. Customer can rejoin after cancellation (unique index allows it)
 *   5. Repeated cancellation is idempotent
 *   6. Original statuses still valid (waiting, serving, completed, no_show)
 *
 * P1-QUEUE-2:
 *   7. queue_reopen_subscriptions table exists with correct schema
 *   8. Can insert a reopen subscription
 *   9. Duplicate active subscription is prevented (unique index)
 *   10. Can mark subscription as notified
 *   11. After notifying, same customer can subscribe again
 *   12. Cross-business isolation — subscriptions are business-scoped
 *   13. Normal waitlist_entries behavior is unaffected
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

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

function psqlSafe(sql: string): { stdout: string; error: boolean } {
  try {
    const stdout = psql(sql);
    return { stdout, error: false };
  } catch (e: any) {
    return { stdout: e.stderr || e.message || '', error: true };
  }
}

function applyMigrations(): void {
  const migrationsDir = path.resolve('supabase/migrations');
  const files = fs.readdirSync(migrationsDir).sort();
  for (const file of files) {
    if (!file.endsWith('.sql')) continue;
    const filePath = path.join(migrationsDir, file);
    try {
      execSync(`psql "${dbUrl}" -v ON_ERROR_STOP=1 -f "${filePath}"`, {
        encoding: 'utf-8', timeout: 30000, stdio: 'pipe',
      });
    } catch {
      // Some migrations may fail due to missing extensions/functions — continue
    }
  }
}

const BIZ_ID = '0a300000-0000-0000-0000-000000000001';
const BIZ_ID_2 = '0a300000-0000-0000-0000-000000000002';
const TODAY = new Date().toISOString().split('T')[0];

const describeDb = dbUrl ? describe : describe.skip;

describeDb('P1-QUEUE: Real PostgreSQL schema contract tests', () => {
  beforeAll(() => {
    applyMigrations();

    // Create prerequisite data — auth.users → profiles → businesses (FK chain)
    const OWNER_1 = '0a300000-0000-0000-0000-000000aa0001';
    const OWNER_2 = '0a300000-0000-0000-0000-000000aa0002';

    psql(`
      ALTER TABLE auth.users DISABLE TRIGGER ALL;
      INSERT INTO auth.users (id) VALUES ('${OWNER_1}'), ('${OWNER_2}') ON CONFLICT DO NOTHING;
      ALTER TABLE auth.users ENABLE TRIGGER ALL;

      INSERT INTO profiles (id, first_name, last_name, email)
      VALUES
        ('${OWNER_1}', 'Q1', 'Test', 'q1@test.local'),
        ('${OWNER_2}', 'Q2', 'Test', 'q2@test.local')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone, status, country_code, category, subscription_tier)
      VALUES
        ('${BIZ_ID}', 'Queue Test Biz', 'queue-test-1', '${OWNER_1}', '1 Test', 'Lagos', 'VI', '+2341111111111', 'active', 'NG', 'salon', 'growth'),
        ('${BIZ_ID_2}', 'Queue Test Biz 2', 'queue-test-2', '${OWNER_2}', '2 Test', 'Lagos', 'VI', '+2342222222222', 'active', 'NG', 'salon', 'growth')
      ON CONFLICT (id) DO NOTHING;
    `);
  });

  afterAll(() => {
    psql(`
      DELETE FROM queue_entries WHERE business_id IN ('${BIZ_ID}', '${BIZ_ID_2}');
      DELETE FROM queue_reopen_subscriptions WHERE business_id IN ('${BIZ_ID}', '${BIZ_ID_2}');
      DELETE FROM businesses WHERE id IN ('${BIZ_ID}', '${BIZ_ID_2}');
      DELETE FROM profiles WHERE id IN ('0a300000-0000-0000-0000-000000aa0001', '0a300000-0000-0000-0000-000000aa0002');
      ALTER TABLE auth.users DISABLE TRIGGER ALL;
      DELETE FROM auth.users WHERE id IN ('0a300000-0000-0000-0000-000000aa0001', '0a300000-0000-0000-0000-000000aa0002');
      ALTER TABLE auth.users ENABLE TRIGGER ALL;
    `);
  });

  describe('P1-QUEUE-1: queue_entries cancelled status', () => {
    it('1. cancelled is accepted by CHECK constraint', () => {
      psql(`
        INSERT INTO queue_entries (business_id, customer_phone, queue_number, queue_date, status, channel)
        VALUES ('${BIZ_ID}', '+2348011111111', 1, '${TODAY}', 'cancelled', 'whatsapp');
      `);

      const status = psql(`
        SELECT status FROM queue_entries
        WHERE business_id = '${BIZ_ID}' AND customer_phone = '+2348011111111' AND queue_date = '${TODAY}';
      `);
      expect(status).toBe('cancelled');

      psql(`DELETE FROM queue_entries WHERE business_id = '${BIZ_ID}' AND customer_phone = '+2348011111111';`);
    });

    it('2. waiting → cancelled transition succeeds', () => {
      psql(`
        INSERT INTO queue_entries (business_id, customer_phone, queue_number, queue_date, status, channel)
        VALUES ('${BIZ_ID}', '+2348022222222', 2, '${TODAY}', 'waiting', 'whatsapp');
      `);

      psql(`
        UPDATE queue_entries SET status = 'cancelled'
        WHERE business_id = '${BIZ_ID}' AND customer_phone = '+2348022222222'
          AND queue_date = '${TODAY}' AND status = 'waiting';
      `);

      const status = psql(`
        SELECT status FROM queue_entries
        WHERE business_id = '${BIZ_ID}' AND customer_phone = '+2348022222222' AND queue_date = '${TODAY}';
      `);
      expect(status).toBe('cancelled');

      psql(`DELETE FROM queue_entries WHERE business_id = '${BIZ_ID}' AND customer_phone = '+2348022222222';`);
    });

    it('3. cancelled entry is NOT counted as waiting', () => {
      psql(`
        INSERT INTO queue_entries (business_id, customer_phone, queue_number, queue_date, status, channel)
        VALUES
          ('${BIZ_ID}', '+2348033333333', 3, '${TODAY}', 'waiting', 'whatsapp'),
          ('${BIZ_ID}', '+2348044444444', 4, '${TODAY}', 'cancelled', 'whatsapp');
      `);

      const waitingCount = psql(`
        SELECT COUNT(*) FROM queue_entries
        WHERE business_id = '${BIZ_ID}' AND queue_date = '${TODAY}' AND status = 'waiting';
      `);
      expect(parseInt(waitingCount)).toBe(1);

      psql(`DELETE FROM queue_entries WHERE business_id = '${BIZ_ID}' AND customer_phone IN ('+2348033333333', '+2348044444444');`);
    });

    it('4. customer can rejoin after cancellation (unique index allows it)', () => {
      psql(`
        INSERT INTO queue_entries (business_id, customer_phone, queue_number, queue_date, status, channel)
        VALUES ('${BIZ_ID}', '+2348055555555', 5, '${TODAY}', 'cancelled', 'whatsapp');
      `);

      psql(`
        INSERT INTO queue_entries (business_id, customer_phone, queue_number, queue_date, status, channel)
        VALUES ('${BIZ_ID}', '+2348055555555', 6, '${TODAY}', 'waiting', 'whatsapp');
      `);

      const count = psql(`
        SELECT COUNT(*) FROM queue_entries
        WHERE business_id = '${BIZ_ID}' AND customer_phone = '+2348055555555' AND queue_date = '${TODAY}';
      `);
      expect(parseInt(count)).toBe(2);

      psql(`DELETE FROM queue_entries WHERE business_id = '${BIZ_ID}' AND customer_phone = '+2348055555555';`);
    });

    it('5. repeated cancellation UPDATE is idempotent (0 rows affected if already cancelled)', () => {
      psql(`
        INSERT INTO queue_entries (business_id, customer_phone, queue_number, queue_date, status, channel)
        VALUES ('${BIZ_ID}', '+2348066666666', 7, '${TODAY}', 'cancelled', 'whatsapp');
      `);

      const result = psqlSafe(`
        UPDATE queue_entries SET status = 'cancelled'
        WHERE business_id = '${BIZ_ID}' AND customer_phone = '+2348066666666'
          AND queue_date = '${TODAY}' AND status = 'waiting';
      `);

      expect(result.error).toBe(false);

      const status = psql(`
        SELECT status FROM queue_entries
        WHERE business_id = '${BIZ_ID}' AND customer_phone = '+2348066666666' AND queue_date = '${TODAY}';
      `);
      expect(status).toBe('cancelled');

      psql(`DELETE FROM queue_entries WHERE business_id = '${BIZ_ID}' AND customer_phone = '+2348066666666';`);
    });

    it('6. original statuses still valid', () => {
      for (const status of ['waiting', 'serving', 'completed', 'no_show']) {
        const phone = `+23480${status.length}${status.length}${status.length}${status.length}${status.length}${status.length}${status.length}`;
        psql(`
          INSERT INTO queue_entries (business_id, customer_phone, queue_number, queue_date, status, channel)
          VALUES ('${BIZ_ID}', '${phone}', ${10 + status.length}, '${TODAY}', '${status}', 'whatsapp');
        `);

        const result = psql(`
          SELECT status FROM queue_entries WHERE business_id = '${BIZ_ID}' AND customer_phone = '${phone}';
        `);
        expect(result).toBe(status);

        psql(`DELETE FROM queue_entries WHERE business_id = '${BIZ_ID}' AND customer_phone = '${phone}';`);
      }
    });

    it('7. invalid status still rejected by CHECK constraint', () => {
      const result = psqlSafe(`
        INSERT INTO queue_entries (business_id, customer_phone, queue_number, queue_date, status, channel)
        VALUES ('${BIZ_ID}', '+2348099999999', 99, '${TODAY}', 'invalid_status', 'whatsapp');
      `);
      expect(result.error).toBe(true);
      expect(result.stdout).toContain('queue_entries_status_check');
    });
  });

  describe('P1-QUEUE-2: queue_reopen_subscriptions', () => {
    it('8. table exists with correct columns', () => {
      const cols = psql(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'queue_reopen_subscriptions'
        ORDER BY ordinal_position;
      `);
      expect(cols).toContain('id');
      expect(cols).toContain('business_id');
      expect(cols).toContain('customer_phone');
      expect(cols).toContain('status');
      expect(cols).toContain('created_at');
      expect(cols).toContain('notified_at');
    });

    it('9. can insert a reopen subscription', () => {
      psql(`
        INSERT INTO queue_reopen_subscriptions (business_id, customer_phone, status)
        VALUES ('${BIZ_ID}', '+2348011111111', 'waiting');
      `);

      const status = psql(`
        SELECT status FROM queue_reopen_subscriptions
        WHERE business_id = '${BIZ_ID}' AND customer_phone = '+2348011111111';
      `);
      expect(status).toBe('waiting');

      psql(`DELETE FROM queue_reopen_subscriptions WHERE business_id = '${BIZ_ID}' AND customer_phone = '+2348011111111';`);
    });

    it('10. duplicate active subscription is prevented by unique index', () => {
      psql(`
        INSERT INTO queue_reopen_subscriptions (business_id, customer_phone, status)
        VALUES ('${BIZ_ID}', '+2348022222222', 'waiting');
      `);

      const result = psqlSafe(`
        INSERT INTO queue_reopen_subscriptions (business_id, customer_phone, status)
        VALUES ('${BIZ_ID}', '+2348022222222', 'waiting');
      `);
      expect(result.error).toBe(true);
      expect(result.stdout).toContain('idx_queue_reopen_sub_active');

      psql(`DELETE FROM queue_reopen_subscriptions WHERE business_id = '${BIZ_ID}' AND customer_phone = '+2348022222222';`);
    });

    it('11. can mark subscription as notified', () => {
      psql(`
        INSERT INTO queue_reopen_subscriptions (business_id, customer_phone, status)
        VALUES ('${BIZ_ID}', '+2348033333333', 'waiting');
      `);

      psql(`
        UPDATE queue_reopen_subscriptions
        SET status = 'notified', notified_at = now()
        WHERE business_id = '${BIZ_ID}' AND customer_phone = '+2348033333333';
      `);

      const status = psql(`
        SELECT status FROM queue_reopen_subscriptions
        WHERE business_id = '${BIZ_ID}' AND customer_phone = '+2348033333333';
      `);
      expect(status).toBe('notified');

      psql(`DELETE FROM queue_reopen_subscriptions WHERE business_id = '${BIZ_ID}' AND customer_phone = '+2348033333333';`);
    });

    it('12. after notifying, same customer can subscribe again', () => {
      psql(`
        INSERT INTO queue_reopen_subscriptions (business_id, customer_phone, status)
        VALUES ('${BIZ_ID}', '+2348044444444', 'notified');
      `);

      psql(`
        INSERT INTO queue_reopen_subscriptions (business_id, customer_phone, status)
        VALUES ('${BIZ_ID}', '+2348044444444', 'waiting');
      `);

      const count = psql(`
        SELECT COUNT(*) FROM queue_reopen_subscriptions
        WHERE business_id = '${BIZ_ID}' AND customer_phone = '+2348044444444';
      `);
      expect(parseInt(count)).toBe(2);

      psql(`DELETE FROM queue_reopen_subscriptions WHERE business_id = '${BIZ_ID}' AND customer_phone = '+2348044444444';`);
    });

    it('13. cross-business isolation — same phone different business succeeds', () => {
      psql(`
        INSERT INTO queue_reopen_subscriptions (business_id, customer_phone, status)
        VALUES
          ('${BIZ_ID}', '+2348055555555', 'waiting'),
          ('${BIZ_ID_2}', '+2348055555555', 'waiting');
      `);

      const count = psql(`
        SELECT COUNT(*) FROM queue_reopen_subscriptions
        WHERE customer_phone = '+2348055555555' AND status = 'waiting';
      `);
      expect(parseInt(count)).toBe(2);

      psql(`DELETE FROM queue_reopen_subscriptions WHERE customer_phone = '+2348055555555';`);
    });

    it('14. invalid status rejected by CHECK constraint', () => {
      const result = psqlSafe(`
        INSERT INTO queue_reopen_subscriptions (business_id, customer_phone, status)
        VALUES ('${BIZ_ID}', '+2348066666666', 'invalid');
      `);
      expect(result.error).toBe(true);
    });

    it('15. RLS is enabled on queue_reopen_subscriptions', () => {
      const rls = psql(`
        SELECT relrowsecurity FROM pg_class WHERE relname = 'queue_reopen_subscriptions';
      `);
      expect(rls).toBe('t');
    });

    it('16. waitlist_entries still has no type column (P1-QUEUE-2 does not pollute it)', () => {
      const cols = psql(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'waitlist_entries' AND column_name = 'type';
      `);
      expect(cols).toBe('');
    });
  });
});

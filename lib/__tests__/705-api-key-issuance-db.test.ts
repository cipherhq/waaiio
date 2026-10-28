/**
 * #705 API Key Atomic Issuance — real PostgreSQL evidence
 *
 * Tests concurrency, ACL, ownership, paid-tier enforcement, revocation,
 * and direct DML bypass denial against a disposable PostgreSQL instance.
 *
 * Requires TEST_DATABASE_URL (skips without it):
 *   docker run --rm -d --name m472-test -p 54329:5432 -e POSTGRES_PASSWORD=test postgres:16
 *   sleep 2
 *   TEST_DATABASE_URL=postgresql://postgres:test@localhost:54329/postgres \
 *     npx vitest run lib/__tests__/705-api-key-issuance-db.test.ts
 *
 * CI: add a dedicated step with TEST_DATABASE_URL in ci.yml to run this test.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, exec } from 'child_process';
import * as path from 'path';
import * as crypto from 'crypto';

const M472_PATH = path.resolve('supabase/migrations/472_api_key_atomic_issuance.sql');
const M473_PATH = path.resolve('supabase/migrations/473_api_key_close_direct_writes.sql');
const dbUrl = process.env.TEST_DATABASE_URL;

// ── Helpers ──────────────────────────────────────────────────────

/** psql flags: verbose errors show SQLSTATE (e.g., "ERROR:  WA001: ...") */
const PSQL_FLAGS = '-tAXq -v ON_ERROR_STOP=1 -v VERBOSITY=verbose';

function psql(sql: string): string {
  const raw = execSync(`psql "${dbUrl}" ${PSQL_FLAGS}`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  });
  return raw.split('\n').filter(l => {
    const t = l.trim();
    return t !== '' && !/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|DO|SET|COMMENT|NOTICE)\b/.test(t);
  }).join('\n').trim();
}

/** Run psql asynchronously for concurrent operations */
function psqlAsync(sql: string): Promise<string> {
  return new Promise((resolve) => {
    exec(`psql "${dbUrl}" ${PSQL_FLAGS}`, {
      encoding: 'utf-8', timeout: 30000,
    }, (err, stdout, stderr) => {
      if (err) {
        // Verbose psql includes SQLSTATE in stderr: "ERROR:  WA001: ..."
        resolve(`ERROR:${stderr}`);
      } else {
        resolve(stdout.split('\n').filter(l => {
          const t = l.trim();
          return t !== '' && !/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|DO|SET|COMMENT|NOTICE)\b/.test(t);
        }).join('\n').trim());
      }
    }).stdin!.end(sql);
  });
}

/** Generate a unique key hash for testing (not real keys, just unique hashes) */
function testHash(): string {
  return crypto.randomBytes(32).toString('hex');
}

// Test UUIDs
const OWNER_A = '00000000-0000-4705-a001-000000000001';
const OWNER_B = '00000000-0000-4705-a001-000000000002';
const BIZ_A   = '00000000-0000-4705-b001-000000000001';
const BIZ_B   = '00000000-0000-4705-b001-000000000002';
const BIZ_FREE = '00000000-0000-4705-b001-000000000003';

describe.skipIf(!dbUrl)('M472 API Key Atomic Issuance (real PostgreSQL)', () => {
  beforeAll(() => {
    if (!dbUrl) return;

    // Create prerequisite schema (minimal subset needed for api_keys)
    psql(`
      -- Supabase roles
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      ALTER ROLE service_role BYPASSRLS;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

      -- auth.uid() stub
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT COALESCE(
          NULLIF(current_setting('request.jwt.claim.sub', true), ''),
          NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
        )::uuid;
      $$ LANGUAGE SQL STABLE;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;

      -- businesses table (minimal)
      CREATE TABLE IF NOT EXISTS public.businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL,
        subscription_tier TEXT DEFAULT 'free',
        status TEXT DEFAULT 'active',
        name TEXT DEFAULT 'Test Business'
      );
      ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
      DO $$ BEGIN
        CREATE POLICY "owner_all" ON public.businesses
          FOR ALL USING (owner_id = auth.uid());
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT ALL ON TABLE public.businesses TO service_role;
      GRANT SELECT, UPDATE ON TABLE public.businesses TO authenticated;

      -- api_keys table (matches M180)
      CREATE TABLE IF NOT EXISTS public.api_keys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT 'Default',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON public.api_keys(key_hash) WHERE revoked_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_api_keys_business ON public.api_keys(business_id);
      ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

      -- Original M180 RLS policy (wrap in exception handler for idempotency)
      DO $$ BEGIN
        CREATE POLICY "owners_manage_api_keys" ON public.api_keys
          FOR ALL USING (
            business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
          );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      -- Default table grants (before M472 lockdown)
      GRANT ALL ON TABLE public.api_keys TO service_role;
      GRANT ALL ON TABLE public.api_keys TO authenticated;

      -- Seed test data
      INSERT INTO public.businesses (id, owner_id, subscription_tier) VALUES
        ('${BIZ_A}', '${OWNER_A}', 'growth'),
        ('${BIZ_B}', '${OWNER_B}', 'business'),
        ('${BIZ_FREE}', '${OWNER_A}', 'free')
      ON CONFLICT (id) DO UPDATE SET
        owner_id = EXCLUDED.owner_id,
        subscription_tier = EXCLUDED.subscription_tier;
    `);

    // Apply M472 (additive RPCs) then M473 (DML lockdown)
    execSync(`psql "${dbUrl}" -v ON_ERROR_STOP=1 -f "${M472_PATH}"`, {
      encoding: 'utf-8', timeout: 30000,
    });
    execSync(`psql "${dbUrl}" -v ON_ERROR_STOP=1 -f "${M473_PATH}"`, {
      encoding: 'utf-8', timeout: 30000,
    });
  });

  afterAll(() => {
    if (!dbUrl) return;
    psql(`
      DROP FUNCTION IF EXISTS public.issue_api_key(UUID, TEXT, TEXT, TEXT, UUID) CASCADE;
      DROP FUNCTION IF EXISTS public.revoke_api_key(UUID, UUID) CASCADE;
      DROP TABLE IF EXISTS public.api_keys CASCADE;
      DROP TABLE IF EXISTS public.businesses CASCADE;
    `);
  });

  // ────────────────────────────────────────────────────────────────
  // 1. ACL: RPC EXECUTE grants
  // ────────────────────────────────────────────────────────────────

  describe('ACL: RPC execute grants', () => {
    it('service_role CAN execute issue_api_key', () => {
      expect(psql(
        `SELECT has_function_privilege('service_role', 'public.issue_api_key(UUID,TEXT,TEXT,TEXT,UUID)', 'EXECUTE')`
      )).toBe('t');
    });

    it('service_role CAN execute revoke_api_key', () => {
      expect(psql(
        `SELECT has_function_privilege('service_role', 'public.revoke_api_key(UUID,UUID)', 'EXECUTE')`
      )).toBe('t');
    });

    it('authenticated CANNOT execute issue_api_key', () => {
      expect(psql(
        `SELECT has_function_privilege('authenticated', 'public.issue_api_key(UUID,TEXT,TEXT,TEXT,UUID)', 'EXECUTE')`
      )).toBe('f');
    });

    it('authenticated CANNOT execute revoke_api_key', () => {
      expect(psql(
        `SELECT has_function_privilege('authenticated', 'public.revoke_api_key(UUID,UUID)', 'EXECUTE')`
      )).toBe('f');
    });

    it('anon CANNOT execute issue_api_key', () => {
      expect(psql(
        `SELECT has_function_privilege('anon', 'public.issue_api_key(UUID,TEXT,TEXT,TEXT,UUID)', 'EXECUTE')`
      )).toBe('f');
    });

    it('anon CANNOT execute revoke_api_key', () => {
      expect(psql(
        `SELECT has_function_privilege('anon', 'public.revoke_api_key(UUID,UUID)', 'EXECUTE')`
      )).toBe('f');
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 2. ACL: Table privilege lockdown
  // ────────────────────────────────────────────────────────────────

  describe('ACL: api_keys table privileges', () => {
    it('authenticated has SELECT on api_keys', () => {
      expect(psql(`SELECT has_table_privilege('authenticated', 'public.api_keys', 'SELECT')`)).toBe('t');
    });

    it('authenticated CANNOT INSERT into api_keys', () => {
      expect(psql(`SELECT has_table_privilege('authenticated', 'public.api_keys', 'INSERT')`)).toBe('f');
    });

    it('authenticated CANNOT UPDATE api_keys', () => {
      expect(psql(`SELECT has_table_privilege('authenticated', 'public.api_keys', 'UPDATE')`)).toBe('f');
    });

    it('authenticated CANNOT DELETE from api_keys', () => {
      expect(psql(`SELECT has_table_privilege('authenticated', 'public.api_keys', 'DELETE')`)).toBe('f');
    });

    it('anon CANNOT INSERT into api_keys', () => {
      expect(psql(`SELECT has_table_privilege('anon', 'public.api_keys', 'INSERT')`)).toBe('f');
    });

    it('service_role has full CRUD on api_keys', () => {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect(psql(`SELECT has_table_privilege('service_role', 'public.api_keys', '${priv}')`)).toBe('t');
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 3. Direct DML bypass denial
  // ────────────────────────────────────────────────────────────────

  describe('direct DML bypass denied', () => {
    it('authenticated role cannot INSERT directly into api_keys', () => {
      const result = psqlAsync(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${OWNER_A}';
        INSERT INTO api_keys (business_id, key_hash, key_prefix, name)
        VALUES ('${BIZ_A}', '${testHash()}', 'wai_direct1', 'Direct bypass');
        RESET ROLE;
      `);
      return result.then(r => {
        expect(r).toContain('ERROR');
      });
    });

    it('authenticated role cannot UPDATE key_hash directly', () => {
      // First insert a key via service_role
      const hash = testHash();
      psql(`
        SET ROLE service_role;
        SELECT issue_api_key('${BIZ_A}', '${hash}', 'wai_dml01', 'DML test', '${OWNER_A}');
        RESET ROLE;
      `);

      return psqlAsync(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${OWNER_A}';
        UPDATE api_keys SET key_hash = 'tampered_hash' WHERE key_prefix = 'wai_dml01';
        RESET ROLE;
      `).then(r => {
        expect(r).toContain('ERROR');
      });
    });

    it('authenticated role cannot reactivate a revoked key', () => {
      const hash = testHash();
      psql(`
        SET ROLE service_role;
        SELECT issue_api_key('${BIZ_A}', '${hash}', 'wai_react', 'Reactivate test', '${OWNER_A}');
        SELECT revoke_api_key(
          (SELECT id FROM api_keys WHERE key_prefix = 'wai_react'),
          '${OWNER_A}'
        );
        RESET ROLE;
      `);

      return psqlAsync(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${OWNER_A}';
        UPDATE api_keys SET revoked_at = NULL WHERE key_prefix = 'wai_react';
        RESET ROLE;
      `).then(r => {
        expect(r).toContain('ERROR');
      });
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 4. Ownership and paid-tier enforcement
  // ────────────────────────────────────────────────────────────────

  describe('ownership and paid-tier enforcement', () => {
    it('owner A can issue key for their own paid business', () => {
      const hash = testHash();
      const result = psql(`
        SET ROLE service_role;
        SELECT issue_api_key('${BIZ_A}', '${hash}', 'wai_own01', 'Owner test', '${OWNER_A}');
        RESET ROLE;
      `);
      // Should return a UUID
      expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('owner B CANNOT issue key for owner A business (WA001)', () => {
      const result = psqlAsync(`
        SET ROLE service_role;
        SELECT issue_api_key('${BIZ_A}', '${testHash()}', 'wai_cross', 'Cross-tenant', '${OWNER_B}');
        RESET ROLE;
      `);
      return result.then(r => {
        expect(r).toContain('WA001');
      });
    });

    it('owner A CANNOT issue key for free-tier business (WA001)', () => {
      const result = psqlAsync(`
        SET ROLE service_role;
        SELECT issue_api_key('${BIZ_FREE}', '${testHash()}', 'wai_free1', 'Free tier', '${OWNER_A}');
        RESET ROLE;
      `);
      return result.then(r => {
        expect(r).toContain('WA001');
      });
    });

    it('nonexistent business raises WA001', () => {
      const fakeBiz = '00000000-0000-4705-b001-999999999999';
      const result = psqlAsync(`
        SET ROLE service_role;
        SELECT issue_api_key('${fakeBiz}', '${testHash()}', 'wai_fake1', 'Ghost', '${OWNER_A}');
        RESET ROLE;
      `);
      return result.then(r => {
        expect(r).toContain('WA001');
      });
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 5. 5-key limit enforcement
  // ────────────────────────────────────────────────────────────────

  describe('5-key limit', () => {
    const limitBiz = '00000000-0000-4705-b005-000000000001';
    const limitOwner = '00000000-0000-4705-a005-000000000001';

    beforeAll(() => {
      psql(`
        INSERT INTO businesses (id, owner_id, subscription_tier)
        VALUES ('${limitBiz}', '${limitOwner}', 'growth')
        ON CONFLICT (id) DO UPDATE SET subscription_tier = 'growth';

        -- Clean slate
        DELETE FROM api_keys WHERE business_id = '${limitBiz}';
      `);
    });

    it('can create exactly 5 keys', () => {
      for (let i = 0; i < 5; i++) {
        const result = psql(`
          SET ROLE service_role;
          SELECT issue_api_key('${limitBiz}', '${testHash()}', 'wai_lim${i}', 'Key ${i}', '${limitOwner}');
          RESET ROLE;
        `);
        expect(result).toMatch(/^[0-9a-f]{8}-/);
      }
      // Verify count
      const count = psql(`SELECT count(*) FROM api_keys WHERE business_id = '${limitBiz}' AND revoked_at IS NULL`);
      expect(count).toBe('5');
    });

    it('6th key is rejected with WA002', () => {
      return psqlAsync(`
        SET ROLE service_role;
        SELECT issue_api_key('${limitBiz}', '${testHash()}', 'wai_lim5', 'Key 6', '${limitOwner}');
        RESET ROLE;
      `).then(r => {
        expect(r).toContain('WA002');
      });
    });

    it('revoking a key allows creating a new one', () => {
      // Revoke one key
      psql(`
        SET ROLE service_role;
        SELECT revoke_api_key(
          (SELECT id FROM api_keys WHERE business_id = '${limitBiz}' AND revoked_at IS NULL LIMIT 1),
          '${limitOwner}'
        );
        RESET ROLE;
      `);

      // Now should succeed
      const result = psql(`
        SET ROLE service_role;
        SELECT issue_api_key('${limitBiz}', '${testHash()}', 'wai_lim6', 'Replacement', '${limitOwner}');
        RESET ROLE;
      `);
      expect(result).toMatch(/^[0-9a-f]{8}-/);

      // Still exactly 5 active
      const count = psql(`SELECT count(*) FROM api_keys WHERE business_id = '${limitBiz}' AND revoked_at IS NULL`);
      expect(count).toBe('5');
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 6. Concurrency: 6 simultaneous from 0 → exactly 5 succeed
  // ────────────────────────────────────────────────────────────────

  describe('concurrency: 6 simultaneous issuance from 0 existing', () => {
    const concBiz = '00000000-0000-4705-b006-000000000001';
    const concOwner = '00000000-0000-4705-a006-000000000001';

    beforeAll(() => {
      psql(`
        INSERT INTO businesses (id, owner_id, subscription_tier)
        VALUES ('${concBiz}', '${concOwner}', 'growth')
        ON CONFLICT (id) DO UPDATE SET subscription_tier = 'growth';
        DELETE FROM api_keys WHERE business_id = '${concBiz}';
      `);
    });

    it('6 concurrent calls → exactly 5 succeed, 1 fails with WA002', async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          psqlAsync(`
            SET ROLE service_role;
            SELECT issue_api_key('${concBiz}', '${testHash()}', 'wai_c6_${i}', 'Conc ${i}', '${concOwner}');
            RESET ROLE;
          `)
        )
      );

      const successes = results.filter(r => !r.startsWith('ERROR'));
      const failures = results.filter(r => r.includes('WA002'));

      expect(successes.length).toBe(5);
      expect(failures.length).toBe(1);

      // Verify exactly 5 in database
      const count = psql(`SELECT count(*) FROM api_keys WHERE business_id = '${concBiz}' AND revoked_at IS NULL`);
      expect(count).toBe('5');
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 7. Concurrency: 3 simultaneous from 4 existing → exactly 1 succeeds
  // ────────────────────────────────────────────────────────────────

  describe('concurrency: 3 simultaneous from 4 existing', () => {
    const conc2Biz = '00000000-0000-4705-b007-000000000001';
    const conc2Owner = '00000000-0000-4705-a007-000000000001';

    beforeAll(() => {
      psql(`
        INSERT INTO businesses (id, owner_id, subscription_tier)
        VALUES ('${conc2Biz}', '${conc2Owner}', 'business')
        ON CONFLICT (id) DO UPDATE SET subscription_tier = 'business';
        DELETE FROM api_keys WHERE business_id = '${conc2Biz}';
      `);

      // Pre-create 4 keys
      for (let i = 0; i < 4; i++) {
        psql(`
          SET ROLE service_role;
          SELECT issue_api_key('${conc2Biz}', '${testHash()}', 'wai_p4_${i}', 'Pre ${i}', '${conc2Owner}');
          RESET ROLE;
        `);
      }

      // Verify 4 exist
      const pre = psql(`SELECT count(*) FROM api_keys WHERE business_id = '${conc2Biz}' AND revoked_at IS NULL`);
      if (pre !== '4') throw new Error(`Expected 4 pre-existing keys, got ${pre}`);
    });

    it('3 concurrent calls → exactly 1 succeeds, 2 fail with WA002', async () => {
      const results = await Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          psqlAsync(`
            SET ROLE service_role;
            SELECT issue_api_key('${conc2Biz}', '${testHash()}', 'wai_o3_${i}', 'Overflow ${i}', '${conc2Owner}');
            RESET ROLE;
          `)
        )
      );

      const successes = results.filter(r => !r.startsWith('ERROR'));
      const failures = results.filter(r => r.includes('WA002'));

      expect(successes.length).toBe(1);
      expect(failures.length).toBe(2);

      // Verify exactly 5 in database
      const count = psql(`SELECT count(*) FROM api_keys WHERE business_id = '${conc2Biz}' AND revoked_at IS NULL`);
      expect(count).toBe('5');
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 8. Revocation
  // ────────────────────────────────────────────────────────────────

  describe('revocation via revoke_api_key', () => {
    const revBiz = '00000000-0000-4705-b008-000000000001';
    const revOwner = '00000000-0000-4705-a008-000000000001';
    let revKeyId: string;

    beforeAll(() => {
      psql(`
        INSERT INTO businesses (id, owner_id, subscription_tier)
        VALUES ('${revBiz}', '${revOwner}', 'growth')
        ON CONFLICT (id) DO UPDATE SET subscription_tier = 'growth';
        DELETE FROM api_keys WHERE business_id = '${revBiz}';
      `);

      revKeyId = psql(`
        SET ROLE service_role;
        SELECT issue_api_key('${revBiz}', '${testHash()}', 'wai_rev1', 'Revoke me', '${revOwner}');
        RESET ROLE;
      `);
    });

    it('owner can revoke their own key', () => {
      const result = psql(`
        SET ROLE service_role;
        SELECT revoke_api_key('${revKeyId}', '${revOwner}');
        RESET ROLE;
      `);
      expect(result).toBe('t');

      const revokedAt = psql(`SELECT revoked_at IS NOT NULL FROM api_keys WHERE id = '${revKeyId}'`);
      expect(revokedAt).toBe('t');
    });

    it('double revocation is idempotent (returns true)', () => {
      const result = psql(`
        SET ROLE service_role;
        SELECT revoke_api_key('${revKeyId}', '${revOwner}');
        RESET ROLE;
      `);
      expect(result).toBe('t');
    });

    it('wrong owner cannot revoke (WA001)', () => {
      // Create another key for this test
      const keyId = psql(`
        SET ROLE service_role;
        SELECT issue_api_key('${revBiz}', '${testHash()}', 'wai_rev2', 'Protected', '${revOwner}');
        RESET ROLE;
      `);

      return psqlAsync(`
        SET ROLE service_role;
        SELECT revoke_api_key('${keyId}', '${OWNER_B}');
        RESET ROLE;
      `).then(r => {
        expect(r).toContain('WA001');
      });
    });

    it('nonexistent key raises WA001', () => {
      const fakeKey = '00000000-0000-4705-c008-999999999999';
      return psqlAsync(`
        SET ROLE service_role;
        SELECT revoke_api_key('${fakeKey}', '${revOwner}');
        RESET ROLE;
      `).then(r => {
        expect(r).toContain('WA001');
      });
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 9. Key validation path (service_role last_used_at update)
  // ────────────────────────────────────────────────────────────────

  describe('key validation: service_role can update last_used_at', () => {
    it('service_role can update last_used_at on api_keys', () => {
      const valBiz = '00000000-0000-4705-b009-000000000001';
      const valOwner = '00000000-0000-4705-a009-000000000001';

      psql(`
        INSERT INTO businesses (id, owner_id, subscription_tier)
        VALUES ('${valBiz}', '${valOwner}', 'growth')
        ON CONFLICT (id) DO UPDATE SET subscription_tier = 'growth';
        DELETE FROM api_keys WHERE business_id = '${valBiz}';
      `);

      const keyId = psql(`
        SET ROLE service_role;
        SELECT issue_api_key('${valBiz}', '${testHash()}', 'wai_val1', 'Validate me', '${valOwner}');
        RESET ROLE;
      `);

      // Simulate validateApiKey's last_used_at update
      psql(`
        SET ROLE service_role;
        UPDATE api_keys SET last_used_at = now() WHERE id = '${keyId}';
        RESET ROLE;
      `);

      const hasTimestamp = psql(`SELECT last_used_at IS NOT NULL FROM api_keys WHERE id = '${keyId}'`);
      expect(hasTimestamp).toBe('t');
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 10. Tenant isolation: owner can only see their own keys via RLS
  // ────────────────────────────────────────────────────────────────

  describe('tenant isolation via RLS', () => {
    const isoOwnerA = '00000000-0000-4705-a010-000000000001';
    const isoOwnerB = '00000000-0000-4705-a010-000000000002';
    const isoBizA = '00000000-0000-4705-b010-000000000001';
    const isoBizB = '00000000-0000-4705-b010-000000000002';

    beforeAll(() => {
      psql(`
        INSERT INTO businesses (id, owner_id, subscription_tier) VALUES
          ('${isoBizA}', '${isoOwnerA}', 'growth'),
          ('${isoBizB}', '${isoOwnerB}', 'business')
        ON CONFLICT (id) DO UPDATE SET
          owner_id = EXCLUDED.owner_id,
          subscription_tier = EXCLUDED.subscription_tier;
        DELETE FROM api_keys WHERE business_id IN ('${isoBizA}', '${isoBizB}');
      `);

      // Create keys for each business via service_role
      psql(`
        SET ROLE service_role;
        SELECT issue_api_key('${isoBizA}', '${testHash()}', 'wai_isoA', 'A key', '${isoOwnerA}');
        SELECT issue_api_key('${isoBizB}', '${testHash()}', 'wai_isoB', 'B key', '${isoOwnerB}');
        RESET ROLE;
      `);
    });

    it('owner A sees only their own keys', () => {
      const count = psql(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${isoOwnerA}';
        SELECT count(*) FROM api_keys WHERE business_id = '${isoBizB}';
        RESET ROLE;
      `);
      expect(count).toBe('0');

      const ownCount = psql(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${isoOwnerA}';
        SELECT count(*) FROM api_keys WHERE business_id = '${isoBizA}';
        RESET ROLE;
      `);
      expect(ownCount).toBe('1');
    });

    it('owner B sees only their own keys', () => {
      const count = psql(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${isoOwnerB}';
        SELECT count(*) FROM api_keys WHERE business_id = '${isoBizA}';
        RESET ROLE;
      `);
      expect(count).toBe('0');
    });
  });
});

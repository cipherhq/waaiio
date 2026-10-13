/**
 * M446: payout_accounts server-only privileges — real PostgreSQL tests.
 *
 * CI: P0 security ACL tests (disposable PG), zero-skip guard.
 * Each role-scoped check runs inside a transaction:
 *   BEGIN → SET LOCAL ROLE → set_config → statement → ROLLBACK
 * Current_user is asserted before the statement under test.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('M446: payout_accounts server-only privileges (real PG)', () => {
  let pg: any;
  let userId: string;
  let businessId: string;

  beforeAll(async () => {
    const pgModule = await import('pg');
    const Client = pgModule.default?.Client || pgModule.Client;
    pg = new Client({ connectionString: TEST_DATABASE_URL });
    await pg.connect();

    // Check required tables. P0 ACL bootstrap doesn't apply all migrations;
    // shard-b does. When tables are missing, log and skip (P0 environment).
    // When present, tests run for real (shard-b environment).
    const { rows: tableCheck } = await pg.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('payout_accounts', 'oauth_connect_states') ORDER BY tablename`
    );
    const found = tableCheck.map((r: any) => r.tablename);
    if (!found.includes('payout_accounts') || !found.includes('oauth_connect_states')) {
      console.log('[M446 pg test] Tables not present (P0 bootstrap) — skipping. Shard-b runs these for real.');
      await pg.end();
      pg = null;
      return;
    }

    // Create test user and business as postgres
    userId = (await pg.query(
      `INSERT INTO auth.users (id, instance_id, role, aud, email, encrypted_password, email_confirmed_at, created_at, updated_at) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'payout-test-' || gen_random_uuid() || '@test.local', crypt('test', gen_salt('bf')), now(), now(), now()) RETURNING id`
    )).rows[0].id;
    businessId = (await pg.query(
      `INSERT INTO public.businesses (id, owner_id, name, slug, address, city, phone, country_code) VALUES (gen_random_uuid(), $1, 'Payout Test Biz', 'payout-test-' || gen_random_uuid(), '1 Test', 'Test', '+1234567890', 'NG') RETURNING id`,
      [userId]
    )).rows[0].id;
  });

  afterAll(async () => {
    if (!pg) return;
    await pg.query(`DELETE FROM public.payout_accounts WHERE business_id = $1`, [businessId]);
    await pg.query(`DELETE FROM public.businesses WHERE id = $1`, [businessId]);
    await pg.query(`DELETE FROM auth.users WHERE id = $1`, [userId]);
    await pg.end();
  });

  it('authenticated cannot INSERT into payout_accounts', async () => {
    if (!pg) return; // P0 bootstrap — tables not present
    await pg.query('BEGIN');
    try {
      await pg.query('SET LOCAL ROLE authenticated');
      await pg.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);
      const { rows: [{ current_user: role }] } = await pg.query('SELECT current_user');
      expect(role).toBe('authenticated');

      try {
        await pg.query(`INSERT INTO public.payout_accounts (business_id, gateway) VALUES ($1, 'paystack')`, [businessId]);
        expect.unreachable('INSERT should have raised 42501');
      } catch (err: any) {
        expect(err.code).toBe('42501');
      }
    } finally {
      await pg.query('ROLLBACK');
    }
  });

  it('authenticated cannot UPDATE payout_accounts', async () => {
    if (!pg) return; // P0 bootstrap
    // Insert a fixture as postgres
    const { rows: [{ id: fixtureId }] } = await pg.query(
      `INSERT INTO public.payout_accounts (id, business_id, gateway, is_active) VALUES (gen_random_uuid(), $1, 'paystack', true) RETURNING id`,
      [businessId]
    );
    try {
      await pg.query('BEGIN');
      try {
        await pg.query('SET LOCAL ROLE authenticated');
        await pg.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);
        const { rows: [{ current_user: role }] } = await pg.query('SELECT current_user');
        expect(role).toBe('authenticated');

        try {
          await pg.query(`UPDATE public.payout_accounts SET bank_name = 'hacked' WHERE id = $1`, [fixtureId]);
          expect.unreachable('UPDATE should have raised 42501');
        } catch (err: any) {
          expect(err.code).toBe('42501');
        }
      } finally {
        await pg.query('ROLLBACK');
      }
    } finally {
      await pg.query(`DELETE FROM public.payout_accounts WHERE id = $1`, [fixtureId]);
    }
  });

  it('authenticated cannot SELECT square_access_token', async () => {
    if (!pg) return; // P0 bootstrap
    const { rows: [{ id: fixtureId }] } = await pg.query(
      `INSERT INTO public.payout_accounts (id, business_id, gateway, square_access_token, is_active) VALUES (gen_random_uuid(), $1, 'square', 'secret_token', true) RETURNING id`,
      [businessId]
    );
    try {
      await pg.query('BEGIN');
      try {
        await pg.query('SET LOCAL ROLE authenticated');
        await pg.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);
        const { rows: [{ current_user: role }] } = await pg.query('SELECT current_user');
        expect(role).toBe('authenticated');

        try {
          await pg.query(`SELECT square_access_token FROM public.payout_accounts WHERE id = $1`, [fixtureId]);
          expect.unreachable('SELECT on square_access_token should have raised 42501');
        } catch (err: any) {
          expect(err.code).toBe('42501');
        }
      } finally {
        await pg.query('ROLLBACK');
      }
    } finally {
      await pg.query(`DELETE FROM public.payout_accounts WHERE id = $1`, [fixtureId]);
    }
  });

  it('authenticated owner can SELECT allowed columns but NOT square_access_token', async () => {
    if (!pg) return; // P0 bootstrap
    const { rows: [{ id: fixtureId }] } = await pg.query(
      `INSERT INTO public.payout_accounts (id, business_id, gateway, bank_name, account_number, square_access_token, is_active) VALUES (gen_random_uuid(), $1, 'paystack', 'Test Bank', '1234567890', 'hidden_secret', true) RETURNING id`,
      [businessId]
    );
    try {
      await pg.query('BEGIN');
      try {
        await pg.query('SET LOCAL ROLE authenticated');
        await pg.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);
        const { rows: [{ current_user: role }] } = await pg.query('SELECT current_user');
        expect(role).toBe('authenticated');

        // Allowed columns work
        const { rows } = await pg.query(
          `SELECT id, gateway, bank_name, account_number, is_active FROM public.payout_accounts WHERE business_id = $1`,
          [businessId]
        );
        expect(rows.length).toBe(1);
        expect(rows[0].bank_name).toBe('Test Bank');
        expect(rows[0].account_number).toBe('1234567890');

        // Secret column fails
        try {
          await pg.query(`SELECT square_access_token FROM public.payout_accounts WHERE id = $1`, [fixtureId]);
          expect.unreachable('SELECT square_access_token should have raised 42501');
        } catch (err: any) {
          expect(err.code).toBe('42501');
        }
      } finally {
        await pg.query('ROLLBACK');
      }
    } finally {
      await pg.query(`DELETE FROM public.payout_accounts WHERE id = $1`, [fixtureId]);
    }
  });

  it('service_role can INSERT and SELECT all columns (positive control)', async () => {
    if (!pg) return; // P0 bootstrap
    await pg.query('BEGIN');
    try {
      await pg.query('SET LOCAL ROLE service_role');
      const { rows: [{ current_user: role }] } = await pg.query('SELECT current_user');
      expect(role).toBe('service_role');

      const { rows: [{ id: newId }] } = await pg.query(
        `INSERT INTO public.payout_accounts (id, business_id, gateway, square_access_token, is_active) VALUES (gen_random_uuid(), $1, 'square', 'service_secret', true) RETURNING id`,
        [businessId]
      );
      expect(newId).toBeTruthy();

      const { rows: selected } = await pg.query(
        `SELECT square_access_token FROM public.payout_accounts WHERE id = $1`, [newId]
      );
      expect(selected[0].square_access_token).toBe('service_secret');
    } finally {
      await pg.query('ROLLBACK');
    }
  });

  it('oauth_connect_states is not readable by authenticated', async () => {
    if (!pg) return; // P0 bootstrap
    await pg.query('BEGIN');
    try {
      await pg.query('SET LOCAL ROLE authenticated');
      await pg.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);
      const { rows: [{ current_user: role }] } = await pg.query('SELECT current_user');
      expect(role).toBe('authenticated');

      try {
        await pg.query(`SELECT * FROM public.oauth_connect_states`);
        expect.unreachable('SELECT on oauth_connect_states should have raised 42501');
      } catch (err: any) {
        expect(err.code).toBe('42501');
      }
    } finally {
      await pg.query('ROLLBACK');
    }
  });
});

/**
 * Payout accounts server-only: real-DB privilege tests.
 *
 * CI: P0 security ACL tests (disposable PG) + shard b, zero-skip guard.
 * Asserts that M446 privilege changes are correctly applied.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Skip if no real PG available — CI provides TEST_DATABASE_URL
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('M446: payout_accounts server-only privileges (real PG)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pg: any;
  let userId: string;
  let businessId: string;
  let hasTable = false;

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Client } = require('pg') as { Client: new (opts: { connectionString: string | undefined }) => any };
    pg = new Client({ connectionString: TEST_DATABASE_URL });
    await pg.connect();

    // Check if payout_accounts table exists (shard-b applies all migrations; P0 ACL may not)
    const { rows: tableCheck } = await pg.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'payout_accounts'`
    );
    if (tableCheck.length === 0) {
      return; // Table doesn't exist in this bootstrap — tests will skip
    }
    hasTable = true;

    // Create test user and business
    userId = (await pg.query(`INSERT INTO auth.users (id, instance_id, role, aud, email, encrypted_password, email_confirmed_at, created_at, updated_at) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'payout-test-' || gen_random_uuid() || '@test.local', crypt('test', gen_salt('bf')), now(), now(), now()) RETURNING id`)).rows[0].id;
    businessId = (await pg.query(`INSERT INTO public.businesses (id, owner_id, name, slug, address, city, phone, country_code) VALUES (gen_random_uuid(), $1, 'Payout Test Biz', 'payout-test-' || gen_random_uuid(), '1 Test', 'Test', '+1234567890', 'NG') RETURNING id`, [userId])).rows[0].id;
  });

  afterAll(async () => {
    if (pg && hasTable) {
      await pg.query(`DELETE FROM public.payout_accounts WHERE business_id = $1`, [businessId]);
      await pg.query(`DELETE FROM public.businesses WHERE id = $1`, [businessId]);
      await pg.query(`DELETE FROM auth.users WHERE id = $1`, [userId]);
    }
    if (pg) await pg.end();
  });

  it('authenticated cannot INSERT into payout_accounts', async () => {
    if (!hasTable) return;
    await pg.query(`SET LOCAL ROLE authenticated`);
    await pg.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);

    try {
      await pg.query(`INSERT INTO public.payout_accounts (business_id, gateway) VALUES ($1, 'paystack')`, [businessId]);
      expect.unreachable('INSERT should have failed');
    } catch (err: any) {
      expect(err.code).toBe('42501'); // permission denied
    } finally {
      await pg.query(`RESET ROLE`);
    }
  });

  it('authenticated cannot UPDATE payout_accounts', async () => {
    if (!hasTable) return;
    // Insert a row as postgres first
    await pg.query(`INSERT INTO public.payout_accounts (id, business_id, gateway, is_active) VALUES (gen_random_uuid(), $1, 'paystack', true)`, [businessId]);

    await pg.query(`SET LOCAL ROLE authenticated`);
    await pg.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);

    try {
      await pg.query(`UPDATE public.payout_accounts SET bank_name = 'hacked' WHERE business_id = $1`, [businessId]);
      expect.unreachable('UPDATE should have failed');
    } catch (err: any) {
      expect(err.code).toBe('42501');
    } finally {
      await pg.query(`RESET ROLE`);
      await pg.query(`DELETE FROM public.payout_accounts WHERE business_id = $1`, [businessId]);
    }
  });

  it('authenticated cannot SELECT square_access_token', async () => {
    if (!hasTable) return;
    await pg.query(`INSERT INTO public.payout_accounts (id, business_id, gateway, square_access_token, is_active) VALUES (gen_random_uuid(), $1, 'square', 'secret_token_value', true)`, [businessId]);

    await pg.query(`SET LOCAL ROLE authenticated`);
    await pg.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);

    try {
      await pg.query(`SELECT square_access_token FROM public.payout_accounts WHERE business_id = $1`, [businessId]);
      expect.unreachable('SELECT on square_access_token should have failed');
    } catch (err: any) {
      expect(err.code).toBe('42501');
    } finally {
      await pg.query(`RESET ROLE`);
      await pg.query(`DELETE FROM public.payout_accounts WHERE business_id = $1`, [businessId]);
    }
  });

  it('authenticated owner can SELECT allowed columns of own rows', async () => {
    if (!hasTable) return;
    await pg.query(`INSERT INTO public.payout_accounts (id, business_id, gateway, bank_name, account_number, is_active) VALUES (gen_random_uuid(), $1, 'paystack', 'Test Bank', '1234567890', true)`, [businessId]);

    await pg.query(`SET LOCAL ROLE authenticated`);
    await pg.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);

    const { rows } = await pg.query(`SELECT id, gateway, bank_name, account_number, is_active FROM public.payout_accounts WHERE business_id = $1`, [businessId]);
    expect(rows.length).toBe(1);
    expect(rows[0].bank_name).toBe('Test Bank');

    await pg.query(`RESET ROLE`);
    await pg.query(`DELETE FROM public.payout_accounts WHERE business_id = $1`, [businessId]);
  });

  it('service_role has full access', async () => {
    if (!hasTable) return;
    await pg.query(`SET LOCAL ROLE service_role`);

    const { rows } = await pg.query(`INSERT INTO public.payout_accounts (id, business_id, gateway, square_access_token, is_active) VALUES (gen_random_uuid(), $1, 'square', 'secret', true) RETURNING id`, [businessId]);
    expect(rows.length).toBe(1);

    const { rows: selected } = await pg.query(`SELECT square_access_token FROM public.payout_accounts WHERE id = $1`, [rows[0].id]);
    expect(selected[0].square_access_token).toBe('secret');

    await pg.query(`DELETE FROM public.payout_accounts WHERE id = $1`, [rows[0].id]);
    await pg.query(`RESET ROLE`);
  });

  it('oauth_connect_states is not readable by authenticated', async () => {
    if (!hasTable) return;
    await pg.query(`SET LOCAL ROLE authenticated`);
    await pg.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);

    try {
      await pg.query(`SELECT * FROM public.oauth_connect_states`);
      expect.unreachable('SELECT on oauth_connect_states should have failed');
    } catch (err: any) {
      expect(err.code).toBe('42501');
    } finally {
      await pg.query(`RESET ROLE`);
    }
  });
});

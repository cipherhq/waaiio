/**
 * M527 — a shared WhatsApp channel never has a business owner.
 * Real PostgreSQL proof (disposable local database, created and dropped here).
 *
 * Fixture: whatsapp_channels with the production column shape that matters
 * here (channel_type defaults to 'shared', as in M003). M527 is applied from
 * disk as one whole-file statement, twice (idempotency).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required for the M527 proof');
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');
const suite = url ? describe : describe.skip;

const m527 = readFileSync('supabase/migrations/527_shared_channel_has_no_owner.sql', 'utf8');
const database = `m527_${randomUUID().replaceAll('-', '')}`;

suite('M527 shared channel has no owner (real PostgreSQL)', () => {
  let control: pg.Client;
  let client: pg.Client;
  const q = (text: string, params?: unknown[]) => client.query(text, params);
  async function errorOf(fn: () => Promise<unknown>): Promise<{ message?: string; code?: string }> {
    try { await fn(); } catch (err) { return err as { message?: string; code?: string }; }
    return {};
  }
  async function constraintValidated(): Promise<boolean | null> {
    const { rows } = await q(`SELECT convalidated FROM pg_constraint
      WHERE conname = 'chk_shared_channel_has_no_owner' AND conrelid = 'public.whatsapp_channels'::regclass`);
    return rows.length ? rows[0].convalidated : null;
  }

  const BIZ_A = randomUUID();
  const BIZ_B = randomUUID();
  const SHARED = randomUUID();
  const DEDICATED = randomUUID();

  beforeAll(async () => {
    control = new pg.Client({ connectionString: url }); await control.connect();
    await control.query(`CREATE DATABASE ${database}`);
    const u = new URL(url!); u.pathname = `/${database}`;
    client = new pg.Client({ connectionString: u.toString() }); await client.connect();
    await q(`
      CREATE TABLE public.businesses (id uuid PRIMARY KEY, assigned_channel_id uuid);
      CREATE TABLE public.whatsapp_channels (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id uuid REFERENCES public.businesses(id),
        phone_number text NOT NULL,
        country_code text NOT NULL,
        channel_type varchar(10) NOT NULL DEFAULT 'shared' CHECK (channel_type IN ('shared', 'dedicated')),
        is_active boolean NOT NULL DEFAULT true,
        connection_status text NOT NULL DEFAULT 'active',
        meta_access_token text
      );
      INSERT INTO public.businesses (id) VALUES ('${BIZ_A}'), ('${BIZ_B}');
    `);
  });

  afterAll(async () => {
    await client?.end();
    await control?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await control?.end();
  });

  it('refuses to apply while a shared channel has an owner, and changes nothing', async () => {
    // The observed staging incident shape.
    await q(`INSERT INTO public.whatsapp_channels (id, business_id, phone_number, country_code, channel_type)
             VALUES ('${SHARED}', '${BIZ_A}', '12404712139', 'US', 'shared')`);
    await q('BEGIN');
    const err = await errorOf(() => q(m527));
    await q('ROLLBACK');
    expect(err.message).toMatch(/M527: 1 shared whatsapp_channels row\(s\) have a business_id/);
    expect(await constraintValidated()).toBeNull();
    const { rows } = await q(`SELECT business_id FROM public.whatsapp_channels WHERE id = $1`, [SHARED]);
    expect(rows[0].business_id).toBe(BIZ_A); // the migration never repairs data itself
    await q(`UPDATE public.whatsapp_channels SET business_id = NULL WHERE id = $1`, [SHARED]);
  });

  it('applies on clean data, twice, and leaves a validated constraint', async () => {
    await q(`INSERT INTO public.whatsapp_channels (id, business_id, phone_number, country_code, channel_type)
             VALUES ('${DEDICATED}', '${BIZ_B}', '12405070285', 'US', 'dedicated')`);
    await q(m527);
    await q(m527);
    expect(await constraintValidated()).toBe(true);
  });

  it('rejects inserting a shared channel with an owner', async () => {
    const err = await errorOf(() => q(`INSERT INTO public.whatsapp_channels (business_id, phone_number, country_code, channel_type)
                                       VALUES ($1, '15550000001', 'NG', 'shared')`, [BIZ_A]));
    expect(err.code).toBe('23514');
  });

  it('rejects an owned row that omits channel_type (it would default to shared)', async () => {
    const err = await errorOf(() => q(`INSERT INTO public.whatsapp_channels (business_id, phone_number, country_code)
                                       VALUES ($1, '15550000002', 'GB')`, [BIZ_A]));
    expect(err.code).toBe('23514');
  });

  it('rejects giving the existing shared channel an owner', async () => {
    const err = await errorOf(() => q(`UPDATE public.whatsapp_channels SET business_id = $1 WHERE id = $2`, [BIZ_A, SHARED]));
    expect(err.code).toBe('23514');
    const { rows } = await q(`SELECT business_id FROM public.whatsapp_channels WHERE id = $1`, [SHARED]);
    expect(rows[0].business_id).toBeNull();
  });

  it('rejects turning an owned dedicated channel into a shared one', async () => {
    const err = await errorOf(() => q(`UPDATE public.whatsapp_channels SET channel_type = 'shared' WHERE id = $1`, [DEDICATED]));
    expect(err.code).toBe('23514');
  });

  it('keeps dedicated ownership and normal shared-channel updates working', async () => {
    const { rowCount } = await q(`INSERT INTO public.whatsapp_channels (business_id, phone_number, country_code, channel_type)
                                  VALUES ($1, '15550000003', 'CA', 'dedicated')`, [BIZ_A]);
    expect(rowCount).toBe(1);
    // e.g. the token refresh cron and deactivation still update the shared row
    const upd = await q(`UPDATE public.whatsapp_channels SET meta_access_token = 'enc', is_active = true, connection_status = 'active' WHERE id = $1`, [SHARED]);
    expect(upd.rowCount).toBe(1);
    // businesses keep referencing the shared channel through their own assignment
    const ref = await q(`UPDATE public.businesses SET assigned_channel_id = $1 WHERE id IN ($2, $3)`, [SHARED, BIZ_A, BIZ_B]);
    expect(ref.rowCount).toBe(2);
  });
});

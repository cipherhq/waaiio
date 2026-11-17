/** #1070 / M545 PostgreSQL proof: whatsapp_delivery_waits is server-only. CI runs this after migration bootstrap. */
import { execSync } from 'child_process';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const dbUrl = process.env.TEST_DATABASE_URL || '';
function sql(statement: string) {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function sqlError(statement: string): string {
  try {
    sql(statement);
  } catch (e) {
    return String((e as { stderr?: string }).stderr || e);
  }
  return '';
}

describe.skipIf(!dbUrl)('M545 whatsapp_delivery_waits', () => {
  it('has RLS on, no policies, and only service_role table privileges', () => {
    expect(sql(`SELECT relrowsecurity FROM pg_class WHERE oid='public.whatsapp_delivery_waits'::regclass`)).toBe('t');
    expect(sql(`SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='whatsapp_delivery_waits'`)).toBe('0');
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      expect(sql(`SELECT has_table_privilege('anon','public.whatsapp_delivery_waits','${p}')`)).toBe('f');
      expect(sql(`SELECT has_table_privilege('authenticated','public.whatsapp_delivery_waits','${p}')`)).toBe('f');
    }
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(sql(`SELECT has_table_privilege('service_role','public.whatsapp_delivery_waits','${p}')`)).toBe('t');
    }
    expect(sql(`SELECT has_table_privilege('service_role','public.whatsapp_delivery_waits','TRUNCATE')`)).toBe('f');
  });

  it('client roles cannot read or write rows', () => {
    const wamid = `wamid.acl-${randomUUID()}`;
    sql(`INSERT INTO public.whatsapp_delivery_waits (wamid) VALUES ('${wamid}')`);
    for (const role of ['anon', 'authenticated']) {
      expect(sqlError(`SET ROLE ${role}; SELECT * FROM public.whatsapp_delivery_waits`)).toContain('permission denied');
      expect(sqlError(`SET ROLE ${role}; INSERT INTO public.whatsapp_delivery_waits (wamid) VALUES ('wamid.x-${role}')`)).toContain('permission denied');
      expect(sqlError(`SET ROLE ${role}; UPDATE public.whatsapp_delivery_waits SET status='delivered'`)).toContain('permission denied');
    }
    sql(`DELETE FROM public.whatsapp_delivery_waits WHERE wamid='${wamid}'`);
  });

  it('service_role lifecycle: register keeps an advanced status, forward-only advance, failed wins, delete', () => {
    const wamid = `wamid.flow-${randomUUID()}`;
    const asService = (statement: string) => sql(`SET ROLE service_role; ${statement}; RESET ROLE`);
    const status = () => sql(`SELECT status FROM public.whatsapp_delivery_waits WHERE wamid='${wamid}'`);
    // Same statements the app issues (upsert ignoreDuplicates / guarded update / delete).
    const register = `INSERT INTO public.whatsapp_delivery_waits (wamid, status) VALUES ('${wamid}','sent') ON CONFLICT (wamid) DO NOTHING`;
    const advance = (to: string, from: string[]) =>
      `UPDATE public.whatsapp_delivery_waits SET status='${to}', updated_at=now() WHERE wamid='${wamid}' AND status IN (${from.map(s => `'${s}'`).join(',')})`;

    asService(register);
    expect(sql(`SELECT status, created_at <= now(), updated_at <= now() FROM public.whatsapp_delivery_waits WHERE wamid='${wamid}'`)).toBe('sent|t|t');
    asService(advance('read', ['sent', 'delivered']));
    asService(register); // a second registration never resets the status
    expect(status()).toBe('read');
    asService(advance('delivered', ['sent'])); // late out-of-order callback
    expect(status()).toBe('read');
    asService(advance('failed', ['sent', 'delivered', 'read']));
    expect(status()).toBe('failed');
    // An unknown WAMID is never created by the webhook advance.
    asService(`UPDATE public.whatsapp_delivery_waits SET status='delivered' WHERE wamid='wamid.unknown-${wamid}' AND status IN ('sent')`);
    expect(sql(`SELECT count(*) FROM public.whatsapp_delivery_waits WHERE wamid='wamid.unknown-${wamid}'`)).toBe('0');
    asService(`DELETE FROM public.whatsapp_delivery_waits WHERE wamid IN ('${wamid}')`);
    expect(sql(`SELECT count(*) FROM public.whatsapp_delivery_waits WHERE wamid='${wamid}'`)).toBe('0');
  });

  it('rejects statuses outside the contract and blank WAMIDs', () => {
    expect(sqlError(`INSERT INTO public.whatsapp_delivery_waits (wamid, status) VALUES ('wamid.bad-${randomUUID()}','accepted')`))
      .toContain('whatsapp_delivery_waits_status_check');
    expect(sqlError(`INSERT INTO public.whatsapp_delivery_waits (wamid) VALUES ('   ')`)).toContain('whatsapp_delivery_waits_wamid_check');
  });
});

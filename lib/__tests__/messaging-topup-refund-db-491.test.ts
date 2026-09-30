/**
 * Messaging Top-Up Refund DB Tests (#491 / Migration 416)
 *
 * Real PostgreSQL proofs for process_topup_refund() RPC.
 * Requires TEST_DATABASE_URL pointing to a fully migrated test DB.
 * CI wires this via M416 migration shard step in migration-shard-b.
 */
import { execSync } from 'child_process';
import { describe, it, expect, beforeAll } from 'vitest';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  }).trim();
}

const OWNER_ID = '00000000-0000-4491-a000-000000000001';
const BIZ_A    = '00000000-0000-4491-b000-000000000001';
const BIZ_B    = '00000000-0000-4491-b000-000000000002';

describe.skipIf(!canRun)('M416 process_topup_refund DB regression (#491)', () => {
  let allowanceA: string;
  let purchaseA: string;
  let allowanceB: string;
  let purchaseB: string;

  beforeAll(() => {
    // Auth user (hard-fail, ON CONFLICT for reruns)
    psql(`INSERT INTO auth.users (id,instance_id,role,aud,email,encrypted_password,created_at,updated_at)
      VALUES ('${OWNER_ID}','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
        'test491@waaiio.test',crypt('pw491',gen_salt('bf')),NOW(),NOW())
      ON CONFLICT (id) DO UPDATE SET updated_at=NOW();`);

    psql(`INSERT INTO profiles (id,email,full_name)
      VALUES ('${OWNER_ID}','test491@waaiio.test','Test491')
      ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email;`);

    psql(`INSERT INTO businesses (id,name,slug,owner_id,address,city,neighborhood,phone,country_code)
      VALUES ('${BIZ_A}','T491A','t491a','${OWNER_ID}','1 T','L','V','+234800000491','NG'),
             ('${BIZ_B}','T491B','t491b','${OWNER_ID}','2 T','L','V','+234800000492','NG')
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name;`);

    // Allowance A (100000 NGN)
    const gA = JSON.parse(psql(`SELECT public.grant_messaging_allowance('${BIZ_A}'::UUID,'purchased',100000,'NGN','refund_491_a',NULL,NULL);`));
    if (!gA.granted && !gA.idempotent) throw new Error(`Grant A failed: ${JSON.stringify(gA)}`);
    allowanceA = gA.allowance_id || psql(`SELECT id FROM messaging_allowances WHERE business_id='${BIZ_A}' AND source_ref='refund_491_a';`);

    purchaseA = psql(`INSERT INTO messaging_topup_purchases (business_id,owner_id,package_amount_minor,currency_code,gateway,provider_reference,status,allowance_id,grant_source_ref,completed_at)
      VALUES ('${BIZ_A}','${OWNER_ID}',100000,'NGN','stripe','pi_refA','completed','${allowanceA}','stripe:pi_refA',NOW())
      ON CONFLICT (business_id,gateway,provider_reference) DO UPDATE SET status='completed',refund_amount_minor=NULL,refund_clawback_minor=NULL,consumed_shortfall_minor=NULL,refunded_at=NULL
      RETURNING id;`);
    psql(`UPDATE messaging_allowances SET remaining_minor=100000 WHERE id='${allowanceA}';`);
    psql(`DELETE FROM messaging_allowance_events WHERE allowance_id='${allowanceA}' AND event_type='adjust';`);

    // Allowance B (50000 NGN, 10000 remaining = 40000 consumed)
    const gB = JSON.parse(psql(`SELECT public.grant_messaging_allowance('${BIZ_B}'::UUID,'purchased',50000,'NGN','refund_491_b',NULL,NULL);`));
    if (!gB.granted && !gB.idempotent) throw new Error(`Grant B failed: ${JSON.stringify(gB)}`);
    allowanceB = gB.allowance_id || psql(`SELECT id FROM messaging_allowances WHERE business_id='${BIZ_B}' AND source_ref='refund_491_b';`);
    psql(`UPDATE messaging_allowances SET remaining_minor=10000 WHERE id='${allowanceB}';`);

    purchaseB = psql(`INSERT INTO messaging_topup_purchases (business_id,owner_id,package_amount_minor,currency_code,gateway,provider_reference,status,allowance_id,grant_source_ref,completed_at)
      VALUES ('${BIZ_B}','${OWNER_ID}',50000,'NGN','stripe','pi_refB','completed','${allowanceB}','stripe:pi_refB',NOW())
      ON CONFLICT (business_id,gateway,provider_reference) DO UPDATE SET status='completed',refund_amount_minor=NULL,refund_clawback_minor=NULL,consumed_shortfall_minor=NULL,refunded_at=NULL
      RETURNING id;`);
    psql(`DELETE FROM messaging_allowance_events WHERE allowance_id='${allowanceB}' AND event_type='adjust';`);
  });

  it('1: partial refund A, then B reaches refunded', () => {
    const rA = JSON.parse(psql(`SELECT public.process_topup_refund('${purchaseA}'::UUID,'rA',20000);`));
    expect(rA.processed).toBe(true);
    expect(rA.clawback_minor).toBe(20000);
    expect(rA.status).toBe('partially_refunded');

    const rB = JSON.parse(psql(`SELECT public.process_topup_refund('${purchaseA}'::UUID,'rB',80000);`));
    expect(rB.processed).toBe(true);
    expect(rB.cumulative_refunded_minor).toBe(100000);
    expect(rB.status).toBe('refunded');
    expect(parseInt(psql(`SELECT remaining_minor FROM messaging_allowances WHERE id='${allowanceA}';`),10)).toBe(0);
  });

  it('2: replay refund A after terminal refunded → idempotent success', () => {
    expect(psql(`SELECT status FROM messaging_topup_purchases WHERE id='${purchaseA}';`)).toBe('refunded');
    const replay = JSON.parse(psql(`SELECT public.process_topup_refund('${purchaseA}'::UUID,'rA',20000);`));
    expect(replay.processed).toBe(true);
    expect(replay.idempotent).toBe(true);
    expect(parseInt(psql(`SELECT refund_amount_minor FROM messaging_topup_purchases WHERE id='${purchaseA}';`),10)).toBe(100000);
  });

  it('3: new refund C after refunded → rejected', () => {
    const r = JSON.parse(psql(`SELECT public.process_topup_refund('${purchaseA}'::UUID,'rC_new',1);`));
    expect(r.processed).toBe(false);
    expect(r.reason).toBe('not_refundable');
  });

  it('4: disputed new refund remains rejected', () => {
    const dpId = psql(`INSERT INTO messaging_topup_purchases (business_id,owner_id,package_amount_minor,currency_code,gateway,provider_reference,status,allowance_id,grant_source_ref,completed_at)
      VALUES ('${BIZ_A}','${OWNER_ID}',10000,'NGN','stripe','pi_disp491','disputed','${allowanceA}','stripe:pi_disp491',NOW())
      ON CONFLICT (business_id,gateway,provider_reference) DO UPDATE SET status='disputed'
      RETURNING id;`);
    const r = JSON.parse(psql(`SELECT public.process_topup_refund('${dpId}'::UUID,'dp1',5000);`));
    expect(r.processed).toBe(false);
    expect(r.reason).toBe('not_refundable');
  });

  it('5: shortfall → review → later refund, exact accounting', () => {
    const r1 = JSON.parse(psql(`SELECT public.process_topup_refund('${purchaseB}'::UUID,'sR1',30000);`));
    expect(r1.processed).toBe(true);
    expect(r1.clawback_minor).toBe(10000);
    expect(r1.shortfall_minor).toBe(20000);
    expect(r1.status).toBe('review');

    const r2 = JSON.parse(psql(`SELECT public.process_topup_refund('${purchaseB}'::UUID,'sR2',20000);`));
    expect(r2.processed).toBe(true);
    expect(r2.cumulative_refunded_minor).toBe(50000);
    expect(r2.cumulative_shortfall_minor).toBe(40000);
    expect(parseInt(psql(`SELECT remaining_minor FROM messaging_allowances WHERE id='${allowanceB}';`),10)).toBe(0);

    const row = psql(`SELECT refund_amount_minor,refund_clawback_minor,consumed_shortfall_minor FROM messaging_topup_purchases WHERE id='${purchaseB}';`);
    const [rT,cT,sT] = row.split('|').map(Number);
    expect(cT+sT).toBe(rT);

    const replay = JSON.parse(psql(`SELECT public.process_topup_refund('${purchaseB}'::UUID,'sR1',30000);`));
    expect(replay.processed).toBe(true);
    expect(replay.idempotent).toBe(true);
  });
});

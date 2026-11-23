/**
 * M557: minimum spend and bottle packages on table reservations
 * (Owner decision 2026-11-23). Disposable PostgreSQL: the real M476, M477,
 * M510, M542 and M557 files on the shared seating fixture.
 *
 * book_table_atomic is called with named arguments, as PostgREST calls it,
 * so the "old app" calls below prove that a caller naming only the M542
 * parameters still reaches the one remaining signature.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const url = process.env.TEST_DATABASE_URL;
if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) {
  throw new Error('Table package tests require a disposable local PostgreSQL server');
}
const database = `tpk557_${randomUUID().replaceAll('-', '')}`;
const owner = randomUUID();
const otherOwner = randomUUID();
const customer = randomUUID();
const SIG = 'public.book_table_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,integer,text,text,integer,integer,integer,uuid,integer,integer,integer)';
let control: pg.Client;
let client: pg.Client;
let targetUrl: string;
let day = 0;

async function connection() { const db = new pg.Client({ connectionString: targetUrl }); await db.connect(); return db; }

interface Pkg { id: string; name: string; includes: string; price: number }
function pkg(name: string, price: number, includes = '2 Hennessy VS + 1 Moët'): Pkg {
  return { id: randomUUID(), name, includes, price };
}

async function table(opts: { deposit?: number; minimumSpend?: number | null; mode?: 'deposit' | 'full'; packages?: Pkg[]; businessOwner?: string } = {}) {
  const business = (await client.query('INSERT INTO businesses(owner_id) VALUES($1) RETURNING id', [opts.businessOwner || owner])).rows[0].id as string;
  const row = (await client.query(
    `INSERT INTO seating_resources(business_id,name,capacity,reservation_duration_minutes,deposit_amount,minimum_spend,payment_mode,packages)
     VALUES($1,'VIP Booth',8,120,$2,$3,$4,$5::jsonb) RETURNING id`,
    [business, opts.deposit ?? 0, opts.minimumSpend ?? null, opts.mode || 'deposit', JSON.stringify(opts.packages || [])])).rows[0];
  return { business, id: row.id as string };
}
type Table = Awaited<ReturnType<typeof table>>;

/** A date nobody else in this file books, so tests never collide on a slot. */
function nextDate() { day += 1; const d = new Date(Date.UTC(2035, 0, 1) + day * 86_400_000); return d.toISOString().slice(0, 10); }

interface BookArgs {
  session?: string | null; date?: string; party?: number; expectedDeposit?: number | null;
  packageId?: string | null; expectedPayable?: number | null; expectedMinimumSpend?: number | null; expectedPackagePrice?: number | null;
  legacy?: boolean;
}
async function book(db: pg.Client, t: Table, a: BookArgs = {}) {
  const params: unknown[] = [a.session ?? null, t.business, customer, t.id, a.date || nextDate(), '18:00', a.party ?? 4, a.expectedDeposit ?? 0];
  let named = `p_bot_session_id=>$1,p_business_id=>$2,p_user_id=>$3,p_seating_resource_id=>$4,p_date=>$5::date,p_time=>$6,p_party_size=>$7,
    p_duration_minutes=>120,p_guest_name=>'Guest',p_guest_phone=>'+2348000000000',p_deposit_amount=>0,p_deposit_status=>'none',p_status=>'confirmed',
    p_total_amount=>0,p_expected_deposit=>$8::int,p_expected_duration=>120`;
  if (!a.legacy) {
    params.push(a.packageId ?? null, a.expectedPayable ?? null, a.expectedMinimumSpend ?? null, a.expectedPackagePrice ?? null);
    named += ',p_package_id=>$9::uuid,p_expected_payable=>$10::int,p_expected_minimum_spend=>$11::int,p_expected_package_price=>$12::int';
  }
  const result = (await db.query(`SELECT * FROM book_table_atomic(${named})`, params)).rows[0];
  const booking = result.booking_id
    ? (await client.query('SELECT deposit_amount,deposit_status,status,total_amount,metadata,flow_type FROM bookings WHERE id=$1', [result.booking_id])).rows[0]
    : null;
  return { ...result, booking };
}

beforeAll(async () => {
  control = new pg.Client({ connectionString: url }); await control.connect();
  const roles = (await control.query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')")).rows;
  if (roles.length !== 3) throw new Error('Required test roles must already exist on the local server');
  await control.query(`CREATE DATABASE ${database}`);
  const target = new URL(url!); target.pathname = `/${database}`; targetUrl = target.toString();
  client = await connection();
  expect((await client.query('SELECT current_database() AS db')).rows[0].db).toBe(database);
  await client.query(readFileSync('lib/__tests__/fixtures/seating-holds-542.sql', 'utf8'));
  for (const migration of ['476_seating_resources_table_reservation', '477_exclude_table_bookings_from_slot_capacity', '510_table_overnight_reservations']) {
    await client.query(readFileSync(`supabase/migrations/${migration}.sql`, 'utf8'));
  }
  await client.query('GRANT USAGE ON SCHEMA public,auth TO service_role,authenticated,anon; GRANT ALL ON businesses TO service_role; GRANT SELECT,INSERT,UPDATE ON bookings TO service_role; GRANT SELECT ON businesses TO authenticated;');
  await client.query('INSERT INTO auth.users(id) VALUES($1),($2)', [owner, otherOwner]);
  await client.query('INSERT INTO profiles(id) VALUES($1)', [customer]);
  await client.query(readFileSync('supabase/migrations/542_seating_holds.sql', 'utf8'));
  await client.query(readFileSync('supabase/migrations/557_table_minimum_spend_packages.sql', 'utf8'));
}, 60000);
afterAll(async () => {
  await client?.end();
  await control?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await control?.end();
});

describe('M557 tables without a minimum spend or packages book exactly as before', () => {
  it('existing rows default to no minimum spend, deposit mode and no packages', async () => {
    const t = await table({ deposit: 5000 });
    const row = (await client.query('SELECT minimum_spend,payment_mode,packages FROM seating_resources WHERE id=$1', [t.id])).rows[0];
    expect(row).toEqual({ minimum_spend: null, payment_mode: 'deposit', packages: [] });
  });

  it('old app call (M542 parameters only) charges the flat deposit with the same metadata', async () => {
    const t = await table({ deposit: 5000 });
    const r = await book(client, t, { legacy: true, expectedDeposit: 5000 });
    expect(r.slot_available).toBe(true);
    expect(r.booking).toMatchObject({ deposit_amount: 5000, total_amount: 5000, deposit_status: 'pending', status: 'pending', flow_type: 'table_reservation' });
    expect(r.booking.metadata).toEqual({ duration_minutes: 120 });
  });

  it('new app call without a package gives the identical booking, and no deposit still confirms at once', async () => {
    const t = await table({ deposit: 5000 });
    const r = await book(client, t, { expectedDeposit: 5000, expectedPayable: 5000 });
    expect(r.booking).toMatchObject({ deposit_amount: 5000, total_amount: 5000, status: 'pending' });
    expect(r.booking.metadata).toEqual({ duration_minutes: 120 });
    const free = await table();
    const f = await book(client, free, { expectedDeposit: 0, expectedPayable: 0 });
    expect(f.booking).toMatchObject({ deposit_amount: 0, total_amount: 0, deposit_status: 'none', status: 'confirmed' });
    expect(f.booking.metadata).toEqual({ duration_minutes: 120 });
  });

  it('a package id on a table without packages is refused', async () => {
    const t = await table({ deposit: 5000 });
    await expect(book(client, t, { expectedDeposit: 5000, expectedPayable: 5000, packageId: randomUUID() })).rejects.toThrow('package_unavailable');
  });
});

describe('M557 amount to pay now', () => {
  it('deposit only: a chosen package pays the deposit and the booking keeps the package', async () => {
    const gold = pkg('Gold', 650000);
    const t = await table({ deposit: 50000, minimumSpend: 500000, packages: [gold] });
    const r = await book(client, t, { expectedDeposit: 50000, packageId: gold.id, expectedPayable: 50000, expectedMinimumSpend: 500000, expectedPackagePrice: 650000 });
    expect(r.booking).toMatchObject({ deposit_amount: 50000, total_amount: 50000, status: 'pending' });
    expect(r.booking.metadata).toEqual({ duration_minutes: 120, table_offer: { payment_mode: 'deposit', minimum_spend: 500000, package: gold } });
  });

  it('deposit only with no deposit: a package booking confirms at once', async () => {
    const gold = pkg('Gold', 650000);
    const t = await table({ packages: [gold] });
    const r = await book(client, t, { packageId: gold.id, expectedPayable: 0, expectedPackagePrice: 650000 });
    expect(r.booking).toMatchObject({ deposit_amount: 0, total_amount: 0, deposit_status: 'none', status: 'confirmed' });
    expect(r.booking.metadata.table_offer.package).toEqual(gold);
  });

  it('pay in full: the package price is the amount to pay', async () => {
    const gold = pkg('Gold', 650000); const silver = pkg('Silver', 400000);
    const t = await table({ deposit: 50000, minimumSpend: 500000, mode: 'full', packages: [gold, silver] });
    const r = await book(client, t, { expectedDeposit: 50000, packageId: silver.id, expectedPayable: 400000, expectedMinimumSpend: 500000, expectedPackagePrice: 400000 });
    expect(r.booking).toMatchObject({ deposit_amount: 400000, total_amount: 400000, deposit_status: 'pending', status: 'pending' });
    expect(r.booking.metadata.table_offer).toEqual({ payment_mode: 'full', minimum_spend: 500000, package: silver });
  });

  it('pay in full, no package: the minimum spend is the amount to pay', async () => {
    const t = await table({ deposit: 50000, minimumSpend: 500000, mode: 'full', packages: [pkg('Gold', 650000)] });
    const r = await book(client, t, { expectedDeposit: 50000, expectedPayable: 500000, expectedMinimumSpend: 500000 });
    expect(r.booking).toMatchObject({ deposit_amount: 500000, total_amount: 500000 });
    expect(r.booking.metadata.table_offer).toEqual({ payment_mode: 'full', minimum_spend: 500000, package: null });
  });

  it('pay in full, no package and no minimum spend: the deposit is the amount to pay', async () => {
    const t = await table({ deposit: 50000, mode: 'full', packages: [pkg('Gold', 650000)] });
    const r = await book(client, t, { expectedDeposit: 50000, expectedPayable: 50000 });
    expect(r.booking).toMatchObject({ deposit_amount: 50000, total_amount: 50000 });
  });

  it('minimum spend only (deposit mode) is recorded with no package', async () => {
    const t = await table({ deposit: 20000, minimumSpend: 300000 });
    const r = await book(client, t, { expectedDeposit: 20000, expectedPayable: 20000, expectedMinimumSpend: 300000 });
    expect(r.booking).toMatchObject({ deposit_amount: 20000, total_amount: 20000 });
    expect(r.booking.metadata.table_offer).toEqual({ payment_mode: 'deposit', minimum_spend: 300000, package: null });
  });
});

describe('M557 changed terms fail closed', () => {
  it('refuses a changed amount, minimum spend or package price', async () => {
    const gold = pkg('Gold', 650000);
    const t = await table({ deposit: 50000, minimumSpend: 500000, mode: 'full', packages: [gold] });
    const base = { expectedDeposit: 50000, packageId: gold.id, expectedPayable: 650000, expectedMinimumSpend: 500000, expectedPackagePrice: 650000 };
    await expect(book(client, t, { ...base, expectedPayable: 600000 })).rejects.toThrow('deposit_changed');
    await expect(book(client, t, { ...base, expectedMinimumSpend: 400000 })).rejects.toThrow('deposit_changed');
    await expect(book(client, t, { ...base, expectedMinimumSpend: null })).rejects.toThrow('deposit_changed');
    await expect(book(client, t, { ...base, expectedPackagePrice: 600000 })).rejects.toThrow('deposit_changed');
    expect((await book(client, t, base)).booking.deposit_amount).toBe(650000);
  });

  it('a price change between showing and paying is caught in deposit mode too', async () => {
    const gold = pkg('Gold', 650000);
    const t = await table({ deposit: 50000, packages: [gold] });
    await client.query('UPDATE seating_resources SET packages=$2::jsonb WHERE id=$1', [t.id, JSON.stringify([{ ...gold, price: 700000 }])]);
    await expect(book(client, t, { expectedDeposit: 50000, packageId: gold.id, expectedPayable: 50000, expectedPackagePrice: 650000 })).rejects.toThrow('deposit_changed');
  });

  it('a caller that names the offer but no expected deposit still gets the database amount, never its own', async () => {
    const gold = pkg('Gold', 300000);
    const t = await table({ deposit: 50000, minimumSpend: 200000, mode: 'full', packages: [gold] });
    const args = [t.business, customer, t.id, nextDate()];
    const withPayable = (await client.query(`SELECT * FROM book_table_atomic(p_bot_session_id=>NULL,p_business_id=>$1,p_user_id=>$2,p_seating_resource_id=>$3,
      p_date=>$4::date,p_time=>'18:00',p_party_size=>4,p_deposit_amount=>1,p_total_amount=>1,p_expected_deposit=>NULL,
      p_package_id=>$5::uuid,p_expected_payable=>300000,p_expected_minimum_spend=>200000,p_expected_package_price=>300000)`, [...args, gold.id])).rows[0];
    const onlyPackage = (await client.query(`SELECT * FROM book_table_atomic(p_bot_session_id=>NULL,p_business_id=>$1,p_user_id=>$2,p_seating_resource_id=>$3,
      p_date=>$4::date,p_time=>'18:00',p_party_size=>4,p_deposit_amount=>1,p_total_amount=>1,p_package_id=>$5::uuid)`, [t.business, customer, t.id, nextDate(), gold.id])).rows[0];
    const rows = (await client.query('SELECT id,deposit_amount,total_amount FROM bookings WHERE id = ANY($1::uuid[]) ORDER BY id', [[withPayable.booking_id, onlyPackage.booking_id]])).rows;
    expect(rows.map(r => [r.deposit_amount, r.total_amount])).toEqual([[300000, 300000], [300000, 300000]]);
  });

  it('old app call on a table that charges more than the deposit is refused', async () => {
    const t = await table({ deposit: 50000, minimumSpend: 500000, mode: 'full' });
    await expect(book(client, t, { legacy: true, expectedDeposit: 50000 })).rejects.toThrow('deposit_changed');
    expect(Number((await client.query('SELECT count(*) FROM bookings WHERE seating_resource_id=$1', [t.id])).rows[0].count)).toBe(0);
  });

  it('old app call on a deposit-mode table with packages still pays the deposit', async () => {
    const t = await table({ deposit: 50000, minimumSpend: 500000, packages: [pkg('Gold', 650000)] });
    const r = await book(client, t, { legacy: true, expectedDeposit: 50000 });
    expect(r.booking).toMatchObject({ deposit_amount: 50000, total_amount: 50000 });
  });
});

describe('M557 cross-business and retry safety', () => {
  it("another table's or business's package is refused", async () => {
    const gold = pkg('Gold', 650000);
    const mine = await table({ deposit: 50000, packages: [pkg('Silver', 400000)] });
    await table({ deposit: 50000, packages: [gold], businessOwner: otherOwner });
    await expect(book(client, mine, { expectedDeposit: 50000, packageId: gold.id, expectedPayable: 50000, expectedPackagePrice: 650000 })).rejects.toThrow('package_unavailable');
  });

  it('a retry with the same package returns the same booking once', async () => {
    const gold = pkg('Gold', 650000);
    const t = await table({ minimumSpend: 500000, mode: 'full', packages: [gold] });
    const session = randomUUID(); const date = nextDate();
    const args = { session, date, packageId: gold.id, expectedPayable: 650000, expectedMinimumSpend: 500000, expectedPackagePrice: 650000 };
    const first = await book(client, t, args); const again = await book(client, t, args);
    expect(again.booking_id).toBe(first.booking_id);
    expect(Number((await client.query('SELECT count(*) FROM bookings WHERE seating_resource_id=$1', [t.id])).rows[0].count)).toBe(1);
  });

  it('a retry for another package or amount never hands back the earlier booking', async () => {
    const gold = pkg('Gold', 650000); const silver = pkg('Silver', 400000);
    const t = await table({ minimumSpend: 500000, mode: 'full', packages: [gold, silver] });
    const session = randomUUID(); const date = nextDate();
    const first = await book(client, t, { session, date, packageId: gold.id, expectedPayable: 650000, expectedMinimumSpend: 500000, expectedPackagePrice: 650000 });
    // Same session, slot and party: the earlier pending booking holds the table, so
    // the new selection gets "not available" or the session's one-booking index.
    const second = book(client, t, { session, date, packageId: silver.id, expectedPayable: 400000, expectedMinimumSpend: 500000, expectedPackagePrice: 400000 });
    await second.then(r => { expect(r.booking_id).not.toBe(first.booking_id); expect(r.slot_available).toBe(false); }, e => expect(String(e)).toMatch(/idx_bookings_session_idempotent|duplicate key/));
    const rows = (await client.query('SELECT deposit_amount FROM bookings WHERE seating_resource_id=$1', [t.id])).rows;
    expect(rows).toEqual([{ deposit_amount: 650000 }]);
  });
});

describe('M557 package list and payment mode checks', () => {
  async function setPackages(t: Table, packages: unknown) {
    return client.query('UPDATE seating_resources SET packages=$2::jsonb WHERE id=$1', [t.id, JSON.stringify(packages)]);
  }
  it('accepts up to 9 well-formed packages and refuses a 10th', async () => {
    const t = await table();
    await setPackages(t, Array.from({ length: 9 }, (_, i) => pkg(`P${i}`, 1000 + i)));
    await expect(setPackages(t, Array.from({ length: 10 }, (_, i) => pkg(`P${i}`, 1000 + i)))).rejects.toThrow('seating_packages_too_many');
  });
  it.each([
    ['a zero price', { ...pkg('Gold', 1), price: 0 }],
    ['a decimal price', { ...pkg('Gold', 1), price: 650000.5 }],
    ['a text price', { ...pkg('Gold', 1), price: '650000' }],
    ['a price above 999,999,999', { ...pkg('Gold', 1), price: 1_000_000_000 }],
    ['an empty name', { ...pkg('Gold', 1), name: '   ' }],
    ['a name of tabs and newlines', { ...pkg('Gold', 1), name: '\n\t ' }],
    ['a 61-character name', { ...pkg('Gold', 1), name: 'x'.repeat(61) }],
    ['includes over 300 characters', { ...pkg('Gold', 1), includes: 'x'.repeat(301) }],
    ['a missing includes', (({ includes: _i, ...rest }) => rest)(pkg('Gold', 1))],
    ['an extra key', { ...pkg('Gold', 1), sneaky: true }],
    ['a non-uuid id', { ...pkg('Gold', 1), id: 'gold' }],
    ['a non-object', 'Gold'],
  ])('refuses %s', async (_label, bad) => {
    const t = await table();
    await expect(setPackages(t, [bad])).rejects.toThrow('seating_packages_invalid');
  });
  it('refuses duplicate package ids and a non-list', async () => {
    const t = await table(); const gold = pkg('Gold', 650000);
    await expect(setPackages(t, [gold, { ...gold, name: 'Copy' }])).rejects.toThrow('seating_packages_invalid');
    await expect(setPackages(t, { gold })).rejects.toThrow('seating_packages_invalid');
  });
  it('pay in full needs a minimum spend or a package; minimum spend must be positive', async () => {
    await expect(table({ mode: 'full' })).rejects.toThrow('seating_full_payment_needs_offer');
    await expect(table({ minimumSpend: 0 })).rejects.toThrow('seating_minimum_spend_positive');
    await expect(table({ minimumSpend: 1_000_000_000 })).rejects.toThrow('seating_minimum_spend_positive');
    expect((await table({ minimumSpend: 999_999_999 })).id).toBeTruthy();
    await expect(client.query("UPDATE seating_resources SET payment_mode='later' WHERE id=$1", [(await table({ minimumSpend: 1000 })).id])).rejects.toThrow('seating_payment_mode_valid');
  });
});

describe('M557 final-state grants and RLS', () => {
  it('book_table_atomic has one signature, SECURITY INVOKER, service_role only', async () => {
    const fns = (await client.query("SELECT p.oid::regprocedure::text AS sig, p.prosecdef, p.proconfig FROM pg_proc p WHERE p.proname='book_table_atomic'")).rows;
    expect(fns).toHaveLength(1);
    expect(fns[0]).toMatchObject({ prosecdef: false, proconfig: null });
    const priv = (await client.query(`SELECT has_function_privilege('anon',$1,'EXECUTE') a, has_function_privilege('authenticated',$1,'EXECUTE') u, has_function_privilege('service_role',$1,'EXECUTE') s`, [SIG])).rows[0];
    expect(priv).toEqual({ a: false, u: false, s: true });
    const db = await connection();
    try {
      await db.query('SET ROLE authenticated');
      await expect(book(db, await table())).rejects.toThrow(/permission denied/);
      await db.query('RESET ROLE'); await db.query('SET ROLE service_role');
      expect((await book(db, await table(), { expectedPayable: 0 })).slot_available).toBe(true);
    } finally { await db.end(); }
  });

  it('the validation trigger function is private, SECURITY INVOKER and not callable by API roles', async () => {
    const row = (await client.query(`SELECT n.nspname, p.prosecdef, has_function_privilege('authenticated',p.oid,'EXECUTE') u, has_function_privilege('anon',p.oid,'EXECUTE') a
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proname='seating_packages_valid'`)).rows;
    expect(row).toEqual([{ nspname: 'private', prosecdef: false, u: false, a: false }]);
  });

  it('an owner edits packages on their own tables only; another owner sees and changes nothing', async () => {
    const t = await table({ deposit: 1000 });
    const gold = pkg('Gold', 650000);
    const db = await connection();
    try {
      await db.query('SET ROLE authenticated');
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [otherOwner]);
      expect((await db.query("UPDATE seating_resources SET packages=$2::jsonb, minimum_spend=1, payment_mode='full' WHERE id=$1", [t.id, JSON.stringify([gold])])).rowCount).toBe(0);
      expect((await db.query('SELECT packages FROM seating_resources WHERE id=$1', [t.id])).rows).toHaveLength(0);
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [owner]);
      expect((await db.query("UPDATE seating_resources SET packages=$2::jsonb, minimum_spend=500000, payment_mode='full' WHERE id=$1", [t.id, JSON.stringify([gold])])).rowCount).toBe(1);
      await expect(db.query('UPDATE seating_resources SET packages=$2::jsonb WHERE id=$1', [t.id, JSON.stringify([{ ...gold, price: 0 }])])).rejects.toThrow('seating_packages_invalid');
      await db.query('RESET ROLE'); await db.query('SET ROLE anon');
      await expect(db.query('SELECT packages FROM seating_resources WHERE id=$1', [t.id])).rejects.toThrow(/permission denied/);
    } finally { await db.end(); }
    const row = (await client.query('SELECT minimum_spend,payment_mode,packages FROM seating_resources WHERE id=$1', [t.id])).rows[0];
    expect(row).toEqual({ minimum_spend: 500000, payment_mode: 'full', packages: [gold] });
  });

  it('seating_resources keeps RLS and no column-level grants on the new columns', async () => {
    expect((await client.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.seating_resources'::regclass")).rows[0].relrowsecurity).toBe(true);
    const cols = (await client.query("SELECT attname FROM pg_attribute WHERE attrelid='public.seating_resources'::regclass AND attname IN ('minimum_spend','payment_mode','packages') AND attacl IS NOT NULL")).rows;
    expect(cols).toEqual([]);
  });

  it('re-applying the migration changes nothing', async () => {
    const before = (await client.query("SELECT pg_get_functiondef('" + SIG + "'::regprocedure) AS d")).rows[0].d;
    await client.query(readFileSync('supabase/migrations/557_table_minimum_spend_packages.sql', 'utf8'));
    expect((await client.query("SELECT pg_get_functiondef('" + SIG + "'::regprocedure) AS d")).rows[0].d).toBe(before);
  });
});

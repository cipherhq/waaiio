import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const url = process.env.TEST_DATABASE_URL;
if (!url || !['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname)) {
  throw new Error('VIP holds tests require a disposable local PostgreSQL server');
}
const database = `vip542_${randomUUID().replaceAll('-', '')}`;
const owner = randomUUID();
const customer = randomUUID();
const start = '2035-11-02T18:00';
const end = '2035-11-02T20:00';
let control: pg.Client;
let client: pg.Client;
let targetUrl: string;
async function connection() { const db = new pg.Client({ connectionString: targetUrl }); await db.connect(); return db; }
async function resource(capacity = 10, businessId?: string) {
  const business = businessId || (await client.query(`INSERT INTO businesses(owner_id) VALUES($1) RETURNING id`, [owner])).rows[0].id;
  const row = (await client.query(`INSERT INTO seating_resources(business_id,name,capacity,reservation_duration_minutes) VALUES($1,'VIP', $2,120) RETURNING id`, [business,capacity])).rows[0];
  return { business, id: row.id as string, capacity };
}
type Resource = Awaited<ReturnType<typeof resource>>;
async function hold(db: pg.Client, r: Resource, seats: number | null = 2, opts: { group?: string; ids?: string[]; start?: string; end?: string; actor?: string } = {}) {
  return db.query(`SELECT * FROM create_seating_hold($1,$2,$3,$4::uuid[],$5::timestamp,$6::timestamp,$7,$8,'VIP')`,
    [r.business,opts.actor || owner,opts.group || randomUUID(),opts.ids || [r.id],opts.start || start,opts.end || end,seats,seats === null]);
}
async function book(db: pg.Client, r: Resource, party = 8, session: string | null = null, date='2035-11-02', time='18:00') {
  return (await db.query(`SELECT * FROM book_table_atomic($1,$2,$3,$4,$5::date,$6,$7,120,'Guest','+10000000000',NULL,NULL,0,'none','confirmed',0,0,120)`,
    [session,r.business,customer,r.id,date,time,party])).rows[0];
}
async function release(db: pg.Client, r: Resource, group: string) { return db.query('SELECT release_seating_hold($1,$2,$3)',[r.business,owner,group]); }
async function waitForBlocked(pid: number) {
  const until=Date.now()+3000;
  while(Date.now()<until) {
    if ((await client.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.wait_event_type==='Lock') return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error('Expected second session to reach its contested database lock');
}


beforeAll(async () => {
  control = new pg.Client({ connectionString: url }); await control.connect();
  const roles = (await control.query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')")).rows;
  if (roles.length !== 3) throw new Error('Required test roles must already exist on the local server');
  await control.query(`CREATE DATABASE ${database}`);
  const target = new URL(url!); target.pathname = `/${database}`; targetUrl = target.toString();
  client = await connection();
  expect((await client.query('SELECT current_database() AS db')).rows[0].db).toBe(database);
  await client.query(readFileSync('lib/__tests__/fixtures/seating-holds-542.sql','utf8'));
  for (const migration of ['476_seating_resources_table_reservation','477_exclude_table_bookings_from_slot_capacity','510_table_overnight_reservations']) {
    await client.query(readFileSync(`supabase/migrations/${migration}.sql`,'utf8'));
  }
  await client.query('GRANT USAGE ON SCHEMA public,auth TO service_role,authenticated,anon; GRANT ALL ON businesses TO service_role; GRANT SELECT,UPDATE ON bookings TO service_role; GRANT SELECT ON businesses TO authenticated; GRANT SELECT,UPDATE,DELETE ON bookings TO authenticated;');
  await client.query('INSERT INTO auth.users(id) VALUES($1);',[owner]);
  await client.query('INSERT INTO profiles(id) VALUES($1)',[customer]);
  await client.query(readFileSync('supabase/migrations/542_seating_holds.sql','utf8'));
},60000);
afterAll(async () => {
  await client?.end();
  await control?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await control?.end();
});

describe('VIP hold capacity authority', () => {
  it('accepts exact fit and preserves one customer reservation', async () => {
    const r=await resource(); await hold(client,r);
    expect((await book(client,r,9)).slot_available).toBe(false);
    expect((await book(client,r,8)).slot_available).toBe(true);
    expect((await book(client,r,1)).slot_available).toBe(false);
  });
  it('whole hold blocks and auditable release restores capacity', async () => {
    const r=await resource(); const group=randomUUID(); await hold(client,r,null,{group});
    expect((await book(client,r,1)).slot_available).toBe(false);
    await release(client,r,group); await release(client,r,group);
    const row=(await client.query('SELECT released_by,released_at FROM seating_holds WHERE group_id=$1',[group])).rows[0];
    expect(row.released_by).toBe(owner); expect(row.released_at).toBeTruthy();
    expect((await book(client,r,10)).slot_available).toBe(true);
  });
  it('uses peak occupancy and half-open boundaries, including overnight holds', async () => {
    const r=await resource();
    await hold(client,r,6,{end:'2035-11-02T19:00'});
    await hold(client,r,6,{start:'2035-11-02T19:00'});
    expect((await book(client,r,4)).slot_available).toBe(true);
    const overnight=await resource();
    await hold(client,overnight,null,{start:'2035-11-02T23:00',end:'2035-11-03T02:00'});
    expect((await book(client,overnight,1,null,'2035-11-03','00:00')).slot_available).toBe(false);
    expect((await book(client,overnight,1,null,'2035-11-03','02:00')).slot_available).toBe(true);
  });
  it('group failure rolls back earlier resources and retries compare full intent', async () => {
    const r=await resource(); const second=await resource(10,r.business); await book(client,second,10);
    await expect(hold(client,r,null,{ids:[r.id,second.id]})).rejects.toThrow('hold_capacity_conflict');
    expect(Number((await client.query('SELECT count(*) FROM seating_holds WHERE seating_resource_id=$1',[r.id])).rows[0].count)).toBe(0);
    const group=randomUUID(); await hold(client,r,2,{group}); await hold(client,r,2,{group});
    await expect(hold(client,r,3,{group})).rejects.toThrow('hold_retry_mismatch');
    expect(Number((await client.query('SELECT count(*) FROM seating_holds WHERE group_id=$1',[group])).rows[0].count)).toBe(1);
  });
  it('tenant/actor/immutability/grants deny unauthorized writes', async () => {
    const r=await resource(); const other=await resource();
    await expect(hold(client,r,2,{actor:randomUUID()})).rejects.toThrow('hold_unauthorized');
    await expect(hold(client,r,2,{ids:[other.id]})).rejects.toThrow('hold_resource_unavailable');
    const result=await hold(client,r); const id=result.rows[0].id;
    await expect(client.query('UPDATE seating_holds SET created_by=$1 WHERE id=$2',[randomUUID(),id])).rejects.toThrow('hold_immutable');
    const db=await connection();
    try {
      await db.query('SET ROLE authenticated');
      await expect(hold(db,r)).rejects.toThrow(/permission denied/);
      expect((await db.query('SELECT * FROM seating_holds WHERE id=$1',[id])).rows).toHaveLength(0);
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[owner]);
      expect((await db.query('SELECT * FROM seating_holds WHERE id=$1',[id])).rows).toHaveLength(1);
      await expect(db.query('UPDATE seating_holds SET released_at=now() WHERE id=$1',[id])).rejects.toThrow(/permission denied/);
    } finally { await db.end(); }
  });
  it('service RPCs can create, book, and release while owner direct capacity writes are guarded', async () => {
    const r=await resource(); const db=await connection(); const group=randomUUID();
    try {
      await db.query('SET ROLE service_role');
      await hold(db,r,2,{group}); expect((await book(db,r,8)).slot_available).toBe(true);
      await db.query('RESET ROLE'); await db.query('SET ROLE authenticated');
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[owner]);
      await expect(db.query('UPDATE seating_resources SET capacity=9 WHERE id=$1',[r.id])).rejects.toThrow('seating_capacity_conflict');
      await db.query('RESET ROLE'); await db.query('SET ROLE service_role'); await release(db,r,group);
      await db.query('RESET ROLE'); await db.query('SET ROLE authenticated');
      expect((await db.query('UPDATE seating_resources SET capacity=8 WHERE id=$1 RETURNING capacity',[r.id])).rows[0].capacity).toBe(8);
    } finally { await db.end(); }
  });
  it('capacity reductions see bookings/holds and unsupported isolation fails closed', async () => {
    const r=await resource(); await hold(client,r,2); await book(client,r,8);
    await expect(client.query('UPDATE seating_resources SET capacity=9 WHERE id=$1',[r.id])).rejects.toThrow('seating_capacity_conflict');
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await expect(client.query('UPDATE seating_resources SET capacity=11 WHERE id=$1',[r.id])).rejects.toThrow('seating_capacity_requires_read_committed');
    await client.query('ROLLBACK');
    await client.query('BEGIN');
    const same=await resource(); await hold(client,same,7);
    await expect(client.query('UPDATE seating_resources SET capacity=6 WHERE id=$1',[same.id])).rejects.toThrow('seating_capacity_conflict');
    await client.query('ROLLBACK');
  });
  it('concurrent hold commits before booking rechecks capacity and retry remains idempotent', async () => {
    const r=await resource(); const a=await connection(); const b=await connection(); const group=randomUUID();
    try {
      await a.query('BEGIN'); await hold(a,r,4,{group});
      const booking=book(b,r,8);
      await a.query('COMMIT'); expect((await booking).slot_available).toBe(false);
      const results=await Promise.all([hold(a,r,4,{group}),hold(b,r,4,{group})]);
      expect(results[0].rows[0].id).toBe(results[1].rows[0].id);
    } finally { await a.end(); await b.end(); }
  });
  it('a committed booking is visible to a waiting hold', async () => {
    const r=await resource(); const a=await connection(); const b=await connection();
    try {
      await a.query('BEGIN'); expect((await book(a,r,8)).slot_available).toBe(true);
      const pending=hold(b,r,3).then(() => null, error => error);
      await a.query('COMMIT'); expect(await pending).toMatchObject({code:'23514'});
      await hold(b,r,2);
      expect(Number((await client.query('SELECT sum(seats) AS seats FROM seating_holds WHERE seating_resource_id=$1',[r.id])).rows[0].seats)).toBe(2);
    } finally { await a.query('ROLLBACK'); await a.end(); await b.end(); }
  });
  it('a hold and capacity writer cannot commit an invalid allocation; explicit retry succeeds', async () => {
    const r=await resource(); const a=await connection(); const b=await connection();
    try {
      await a.query('BEGIN'); await hold(a,r,8);
      const pending=b.query('UPDATE seating_resources SET capacity=7 WHERE id=$1',[r.id]).then(() => null,error => error);
      await a.query('COMMIT'); expect(await pending).toMatchObject({code:'23514'});
      await b.query('UPDATE seating_resources SET capacity=8 WHERE id=$1',[r.id]);
      expect((await book(b,r,1)).slot_available).toBe(false);
    } finally { await a.query('ROLLBACK'); await a.end(); await b.end(); }
  });
  it('normal RPCs are reentrant with their resource lock and reject unsupported isolation', async () => {
    const r=await resource();
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(abs(hashtext($1 || '|sr|' || $2)::bigint))",[r.business,r.id]);
    await hold(client,r,2); expect((await book(client,r,8)).slot_available).toBe(true);
    await client.query('COMMIT');
    for (const action of [() => hold(client,r), () => book(client,r)]) {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await expect(action()).rejects.toMatchObject({code:'40001'});
      await client.query('ROLLBACK');
    }
  });
  it('reversed group requests serialize without partial allocation', async () => {
    const r=await resource(); const second=await resource(10,r.business); const a=await connection(); const b=await connection();
    try {
      const outcomes=await Promise.allSettled([hold(a,r,null,{ids:[r.id,second.id]}),hold(b,r,null,{ids:[second.id,r.id]})]);
      expect(outcomes.filter(o=>o.status==='fulfilled')).toHaveLength(1);
      expect(Number((await client.query('SELECT count(*) FROM seating_holds WHERE business_id=$1',[r.business])).rows[0].count)).toBe(2);
    } finally { await a.end(); await b.end(); }
  });
  it('row-first capacity update fails promptly, then explicit retry sees committed booking', async () => {
    const r=await resource(); const a=await connection(); const b=await connection();
    try {
      await a.query('BEGIN'); await a.query('SELECT id FROM seating_resources WHERE id=$1 FOR UPDATE',[r.id]);
      await b.query('BEGIN'); await b.query("SELECT pg_advisory_xact_lock(abs(hashtext($1 || '|sr|' || $2)::bigint))",[r.business,r.id]);
      const booking=book(b,r,8);
      await a.query("SET LOCAL statement_timeout='1000ms'");
      await expect(a.query('UPDATE seating_resources SET capacity=7 WHERE id=$1',[r.id])).rejects.toMatchObject({code:'40001'});
      await a.query('ROLLBACK'); expect((await booking).slot_available).toBe(true); await b.query('COMMIT');
      await expect(a.query('UPDATE seating_resources SET capacity=7 WHERE id=$1',[r.id])).rejects.toThrow('seating_capacity_conflict');
      await a.query('UPDATE seating_resources SET capacity=8 WHERE id=$1',[r.id]);
    } finally { await a.query('ROLLBACK'); await b.query('ROLLBACK'); await a.end(); await b.end(); }
  });
  it('owner and service reactivation respect partial and whole holds, regardless of flow_type', async () => {
    for (const role of ['authenticated','service_role']) for (const status of ['confirmed','in_progress']) {
      const r=await resource(); const row=await book(client,r,8);
      await client.query("UPDATE bookings SET status='cancelled',flow_type='scheduling' WHERE id=$1",[row.booking_id]);
      const group=randomUUID(); await hold(client,r,3,{group}); const db=await connection();
      try {
        await db.query(`SET ROLE ${role}`);
        await expect(db.query('UPDATE bookings SET status=$1 WHERE id=$2',[status,row.booking_id])).rejects.toThrow('seating_booking_capacity_conflict');
        await release(client,r,group); const whole=randomUUID(); await hold(client,r,null,{group:whole});
        await expect(db.query('UPDATE bookings SET status=$1 WHERE id=$2',[status,row.booking_id])).rejects.toThrow('seating_booking_capacity_conflict');
        await release(client,r,whole); await hold(client,r,2);
        await db.query('UPDATE bookings SET status=$1 WHERE id=$2',[status,row.booking_id]);
      } finally { await db.end(); }
    }
  });
  it('resource/date/overnight/duration/party changes use the complete effective occupancy', async () => {
    const r=await resource(); const second=await resource(10,r.business); const row=await book(client,r,8);
    await hold(client,second,null);
    await expect(client.query('UPDATE bookings SET seating_resource_id=$1 WHERE id=$2',[second.id,row.booking_id])).rejects.toThrow('seating_booking_capacity_conflict');
    await hold(client,r,null,{start:'2035-11-03T00:00',end:'2035-11-03T02:00'});
    await expect(client.query("UPDATE bookings SET date='2035-11-03',time='00:00' WHERE id=$1",[row.booking_id])).rejects.toThrow('seating_booking_capacity_conflict');
    await expect(client.query("UPDATE bookings SET time='23:00' WHERE id=$1",[row.booking_id])).rejects.toThrow('seating_booking_capacity_conflict');
    await hold(client,r,3,{start:'2035-11-02T20:00',end:'2035-11-02T21:00'});
    await expect(client.query(`UPDATE bookings SET metadata='{"duration_minutes":180}' WHERE id=$1`,[row.booking_id])).rejects.toThrow('seating_booking_capacity_conflict');
    await hold(client,r,2);
    await expect(client.query('UPDATE bookings SET party_size=9 WHERE id=$1',[row.booking_id])).rejects.toThrow('seating_booking_capacity_conflict');
    const other=await resource();
    await expect(client.query('UPDATE bookings SET seating_resource_id=$1 WHERE id=$2',[other.id,row.booking_id])).rejects.toThrow('seating_booking_resource_invalid');
  });
  it('harmless status changes and release-only writes succeed under advisory contention', async () => {
    const r=await resource(); const row=await book(client,r,8); const a=await connection();
    try {
      await a.query('BEGIN'); await a.query("SELECT pg_advisory_xact_lock(abs(hashtext($1 || '|sr|' || $2)::bigint))",[r.business,r.id]);
      await client.query("SET statement_timeout='1000ms'");
      await client.query("UPDATE bookings SET status='in_progress',flow_type='scheduling' WHERE id=$1",[row.booking_id]);
      await client.query("UPDATE bookings SET status='cancelled' WHERE id=$1",[row.booking_id]);
      await client.query('DELETE FROM bookings WHERE id=$1',[row.booking_id]);
    } finally { await client.query('RESET statement_timeout'); await a.query('ROLLBACK'); await a.end(); }
  });
  it('opposite resource moves fail promptly without partial commits', async () => {
    const r=await resource(); const second=await resource(10,r.business);
    const firstBooking=await book(client,r,8); const secondBooking=await book(client,second,8);
    const a=await connection(); const b=await connection();
    try {
      await a.query('BEGIN'); await b.query('BEGIN');
      await a.query("SELECT pg_advisory_xact_lock(abs(hashtext($1 || '|sr|' || $2)::bigint))",[r.business,r.id]);
      await b.query("SELECT pg_advisory_xact_lock(abs(hashtext($1 || '|sr|' || $2)::bigint))",[r.business,second.id]);
      await a.query("SET LOCAL statement_timeout='1000ms'"); await b.query("SET LOCAL statement_timeout='1000ms'");
      const outcomes=await Promise.allSettled([
        a.query('UPDATE bookings SET seating_resource_id=$1 WHERE id=$2',[second.id,firstBooking.booking_id]),
        b.query('UPDATE bookings SET seating_resource_id=$1 WHERE id=$2',[r.id,secondBooking.booking_id]),
      ]);
      expect(outcomes.every(o=>o.status==='rejected' && ['40001','23514'].includes(o.reason.code))).toBe(true);
      await a.query('ROLLBACK'); await b.query('ROLLBACK');
      const rows=(await client.query('SELECT id,seating_resource_id FROM bookings WHERE business_id=$1',[r.business])).rows;
      expect(rows.find(x=>x.id===firstBooking.booking_id).seating_resource_id).toBe(r.id);
      expect(rows.find(x=>x.id===secondBooking.booking_id).seating_resource_id).toBe(second.id);
    } finally { await a.query('ROLLBACK'); await b.query('ROLLBACK'); await a.end(); await b.end(); }
  });
  it('booking multirow failure rolls back every changed row', async () => {
    const r=await resource(); const second=await resource(10,r.business);
    await book(client,r,8); await book(client,second,8); await hold(client,second,2);
    await expect(client.query('UPDATE bookings SET party_size=9 WHERE business_id=$1',[r.business])).rejects.toThrow('seating_booking_capacity_conflict');
    expect((await client.query('SELECT party_size FROM bookings WHERE business_id=$1',[r.business])).rows.map(x=>x.party_size)).toEqual([8,8]);
  });
  it('a racing hold blocks reactivation and explicit retry sees the committed hold', async () => {
    const r=await resource(); const row=await book(client,r,8);
    await client.query("UPDATE bookings SET status='cancelled' WHERE id=$1",[row.booking_id]);
    const a=await connection(); const b=await connection();
    try {
      await a.query('BEGIN'); await hold(a,r,3);
      await expect(b.query("UPDATE bookings SET status='confirmed' WHERE id=$1",[row.booking_id])).rejects.toMatchObject({code:'40001'});
      await a.query('COMMIT');
      await expect(b.query("UPDATE bookings SET status='confirmed' WHERE id=$1",[row.booking_id])).rejects.toThrow('seating_booking_capacity_conflict');
      await b.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await expect(b.query("UPDATE bookings SET status='confirmed' WHERE id=$1",[row.booking_id])).rejects.toMatchObject({code:'40001'});
      await b.query('ROLLBACK');
    } finally { await a.query('ROLLBACK'); await b.query('ROLLBACK'); await a.end(); await b.end(); }
  });
  it('reactivation waiting on a row observes a hold committed after its statement began', async () => {
    const r=await resource(); const row=await book(client,r,8);
    await client.query("UPDATE bookings SET status='cancelled' WHERE id=$1",[row.booking_id]);
    const a=await connection(); const b=await connection();
    try {
      await a.query('BEGIN'); await a.query('SELECT id FROM bookings WHERE id=$1 FOR UPDATE',[row.booking_id]);
      await hold(a,r,3);
      const pid=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const pending=b.query("UPDATE bookings SET status='confirmed' WHERE id=$1",[row.booking_id]).then(()=>null,error=>error);
      await waitForBlocked(pid);
      await a.query('COMMIT'); expect(await pending).toMatchObject({code:'23514'});
      expect((await client.query('SELECT status FROM bookings WHERE id=$1',[row.booking_id])).rows[0].status).toBe('cancelled');
    } finally { await a.query('ROLLBACK'); await a.end(); await b.end(); }
  });
  it('a later-row capacity failure rolls back the whole statement', async () => {
    const r=await resource(); const second=await resource(10,r.business); await hold(client,second,8);
    await expect(client.query('UPDATE seating_resources SET capacity=7 WHERE business_id=$1',[r.business])).rejects.toThrow('seating_capacity_conflict');
    expect((await client.query('SELECT capacity FROM seating_resources WHERE business_id=$1',[r.business])).rows.map(r=>r.capacity)).toEqual([10,10]);
  });
});

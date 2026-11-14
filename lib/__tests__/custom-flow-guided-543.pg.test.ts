import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw Error('Disposable PostgreSQL required (TEST_DATABASE_URL)');
const address = new URL(url);
if (!['localhost','127.0.0.1','[::1]'].includes(address.hostname)) throw Error('Local disposable PostgreSQL only');
if (address.searchParams.has('host') && !/^\/(private\/)?tmp\/waaiio-guided-/.test(address.searchParams.get('host')!)) throw Error('Unexpected socket directory');
const database = `guided543_${randomUUID().replaceAll('-','')}`;
const owner = randomUUID(), otherOwner = randomUUID(), biz = randomUUID(), otherBiz = randomUUID();
const flowId = randomUUID(), tableId = randomUUID(), rowId = randomUUID();
const columns = [{name:'name',type:'text',required:true}];
let admin: pg.Client, db: pg.Client, target: string;
const migration = (name: string) => readFileSync(join(process.cwd(),'supabase/migrations',name),'utf8');
const clients: pg.Client[] = [];
async function client(asOwner = owner) {
  const c = new pg.Client({connectionString:target}); await c.connect(); clients.push(c);
  await c.query('SET ROLE authenticated');
  await c.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[asOwner]);
  return c;
}
async function setup(c: pg.Client, request: unknown = {template:'blank'}, id = flowId, businessId = biz, tables: unknown = [{name:'people',columns}]) {
  return c.query('SELECT (public.create_custom_flow_template($1,$2,$3,$4,$5)).*',[id,businessId,request,{name:'Information',nodes:[]},JSON.stringify(tables)]);
}

describe('M543 guided setup and direct-writer concurrency (real PostgreSQL)',()=>{
  beforeAll(async()=>{
    admin = new pg.Client({connectionString:url}); await admin.connect();
    const identity = (await admin.query("SELECT inet_server_addr()::text AS address, current_database() AS database")).rows[0];
    expect([null,'127.0.0.1','::1']).toContain(identity.address);
    await admin.query(`CREATE DATABASE ${database}`);
    const destination = new URL(url); destination.pathname = `/${database}`; target = destination.toString();
    db = new pg.Client({connectionString:target}); await db.connect();
    expect((await db.query('SELECT current_database() AS name')).rows[0].name).toBe(database);
    await db.query(`
      DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
      GRANT USAGE ON SCHEMA auth,public TO anon,authenticated,service_role;
      CREATE TYPE business_category AS ENUM ('other');
      CREATE TABLE businesses(id uuid PRIMARY KEY,owner_id uuid NOT NULL,name text NOT NULL DEFAULT 'B',status text DEFAULT 'active',flow_type text DEFAULT 'scheduling');
      GRANT SELECT ON businesses TO authenticated;
      GRANT SELECT,INSERT,UPDATE,DELETE ON businesses TO service_role;
    `);
    await db.query(migration('008_capabilities.sql'));
    await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon,authenticated,service_role;`);
    await db.query(migration('541_custom_flow_base.sql'));
    await db.query(migration('543_custom_flow_guided_setup.sql'));
  });
  afterAll(async()=>{
    for(const c of clients) await c.end();
    await db?.end();
    if(admin){await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);await admin.end();}
  });
  beforeEach(async()=>{
    await db.query('TRUNCATE custom_flows,businesses CASCADE');
    await db.query('INSERT INTO businesses(id,owner_id) VALUES($1,$2),($3,$4)',[biz,owner,otherBiz,otherOwner]);
  });
  it('creates draft and tables atomically; immutable receipt survives subsequent draft edits',async()=>{
    const c=await client(); await setup(c);
    await c.query("UPDATE custom_flows SET definition='{}',name='Edited' WHERE id=$1",[flowId]);
    const retry=await setup(c); expect(retry.rows[0].name).toBe('Edited');
    expect((await db.query('SELECT count(*)::int n FROM custom_flow_tables')).rows[0].n).toBe(1);
    await expect(c.query("UPDATE custom_flows SET creation_payload='{}' WHERE id=$1",[flowId])).rejects.toMatchObject({code:'23514'});
  });
  it('rejects changed request identity',async()=>{
    const c=await client(); await setup(c);
    await expect(setup(c,{template:'different'})).rejects.toMatchObject({code:'23505'});
  });
  it('rejects another owner and anonymous execute, without widening service grants',async()=>{
    const c=await client(otherOwner); await expect(setup(c)).rejects.toMatchObject({code:'42501'});
    const grants=(await db.query("SELECT has_function_privilege('anon','public.create_custom_flow_template(uuid,uuid,jsonb,jsonb,jsonb)','EXECUTE') anon,has_function_privilege('authenticated','public.create_custom_flow_template(uuid,uuid,jsonb,jsonb,jsonb)','EXECUTE') owner,has_function_privilege('service_role','public.create_custom_flow_template(uuid,uuid,jsonb,jsonb,jsonb)','EXECUTE') service")).rows[0];
    expect(grants).toEqual({anon:false,owner:true,service:false});
    expect((await db.query("SELECT has_table_privilege('service_role','custom_flow_table_rows','UPDATE') allowed")).rows[0].allowed).toBe(true);
  });
  it('rolls back draft and prior tables when a later table is invalid',async()=>{
    const c=await client();
    await expect(setup(c,{},flowId,biz,[{name:'valid',columns},{name:'bad',columns:[]}])).rejects.toMatchObject({code:'23514'});
    expect((await db.query('SELECT count(*)::int n FROM custom_flows')).rows[0].n).toBe(0);
    expect((await db.query('SELECT count(*)::int n FROM custom_flow_tables')).rows[0].n).toBe(0);
  });
  it('two simultaneous retries create one draft and one table',async()=>{
    const a=await client(),b=await client();
    const results=await Promise.all([setup(a),setup(b)]);
    expect(results.map(r=>r.rows[0].id)).toEqual([flowId,flowId]);
    expect((await db.query('SELECT count(*)::int n FROM custom_flow_tables')).rows[0].n).toBe(1);
  });
  async function seed() {
    await db.query("INSERT INTO custom_flows(id,business_id,name) VALUES($1,$2,'Info')",[flowId,biz]);
    await db.query("INSERT INTO custom_flow_tables(id,business_id,flow_id,name,columns,editor_schema_version) VALUES($1,$2,$3,'people',$4,1)",[tableId,biz,flowId,JSON.stringify(columns)]);
    await db.query("INSERT INTO custom_flow_table_rows(id,table_id,business_id,row_code,data) VALUES($1,$2,$3,'A',$4)",[rowId,tableId,biz,{name:'Person'}]);
  }
  it('accepts incomplete drafts, rejects unknown fields and arbitrary source shape via direct authenticated writes',async()=>{
    await seed(); const c=await client();
    await c.query("UPDATE custom_flow_table_rows SET data='{}' WHERE id=$1",[rowId]);
    await expect(c.query("UPDATE custom_flow_table_rows SET data=$2 WHERE id=$1",[rowId,{secret:'bad'}])).rejects.toMatchObject({code:'23514'});
    await expect(c.query("UPDATE custom_flow_table_rows SET data=$2 WHERE id=$1",[rowId,{_source:{version:1,kind:'arbitrary',id:randomUUID()}}])).rejects.toMatchObject({code:'23514'});
  });
  it('rejects incompatible schema edits; accepts compatible same-transaction schema and row edits',async()=>{
    await seed(); const c=await client();
    await expect(c.query('UPDATE custom_flow_tables SET columns=$2 WHERE id=$1',[tableId,JSON.stringify([{name:'name',type:'number'}])])).rejects.toMatchObject({code:'23514'});
    await c.query('BEGIN');
    await c.query("UPDATE custom_flow_table_rows SET data='{}' WHERE id=$1",[rowId]);
    await c.query('UPDATE custom_flow_tables SET columns=$2 WHERE id=$1',[tableId,JSON.stringify([{name:'name',type:'number'}])]);
    await c.query("UPDATE custom_flow_table_rows SET data=$2 WHERE id=$1",[rowId,{name:5}]);
    await c.query('COMMIT');
    expect((await db.query('SELECT data FROM custom_flow_table_rows WHERE id=$1',[rowId])).rows[0].data).toEqual({name:5});
  });
  it('keeps published table references stable across owner and service schema edits',async()=>{
    await seed();const c=await client();
    for(const role of ['authenticated','service_role']){
      await c.query('RESET ROLE');await c.query(`SET ROLE ${role}`);
      await expect(c.query("UPDATE custom_flow_tables SET name='renamed' WHERE id=$1",[tableId])).rejects.toMatchObject({code:'23514'});
    }
    await c.query('UPDATE custom_flow_tables SET columns=$2 WHERE id=$1',[tableId,JSON.stringify([...columns,{name:'details',type:'text'}])]);
    const answer=await c.query("SELECT r.data FROM custom_flow_tables t JOIN custom_flow_table_rows r ON r.table_id=t.id AND r.business_id=t.business_id WHERE t.business_id=$1 AND t.flow_id=$2 AND t.name='people'",[biz,flowId]);
    expect(answer.rows).toEqual([{data:{name:'Person'}}]);
  });
  it('direct row writer fails immediately on table lock contention and can explicitly retry',async()=>{
    await seed(); const a=await client(),b=await client();
    await a.query('BEGIN'); await a.query('SELECT pg_advisory_xact_lock(hashtextextended($1,543))',[tableId]);
    await expect(b.query('UPDATE custom_flow_table_rows SET data=$2 WHERE id=$1',[rowId,{name:'Changed'}])).rejects.toMatchObject({code:'40001'});
    await a.query('ROLLBACK');
    await b.query('UPDATE custom_flow_table_rows SET data=$2 WHERE id=$1',[rowId,{name:'Changed'}]);
  });
  it('schema writer cannot race a row writer with the shared table lock',async()=>{
    await seed(); const a=await client(),b=await client();
    await a.query('BEGIN'); await a.query('UPDATE custom_flow_table_rows SET data=$2 WHERE id=$1',[rowId,{name:'Changed'}]);
    await expect(b.query('UPDATE custom_flow_tables SET columns=$2 WHERE id=$1',[tableId,JSON.stringify(columns)])).rejects.toMatchObject({code:'40001'});
    await a.query('ROLLBACK');
  });
  it('timestamp CAS gives exactly one concurrent row writer success',async()=>{
    await seed(); const a=await client(),b=await client();
    const stamp=(await db.query('SELECT updated_at::text stamp FROM custom_flow_table_rows WHERE id=$1',[rowId])).rows[0].stamp;
    const sql='UPDATE custom_flow_table_rows SET data=$2 WHERE id=$1 AND updated_at=$3 RETURNING id';
    const results=await Promise.all([a.query(sql,[rowId,{name:'A'},stamp]),b.query(sql,[rowId,{name:'B'},stamp])]);
    expect(results.map(r=>r.rowCount).sort()).toEqual([0,1]);
  });
  it('rejects unsupported isolation and immutable guarded identity changes',async()=>{
    await seed(); const c=await client();
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await expect(c.query("UPDATE custom_flow_table_rows SET data='{}' WHERE id=$1",[rowId])).rejects.toMatchObject({code:'25001'});
    await c.query('ROLLBACK');
    await expect(c.query('UPDATE custom_flow_tables SET editor_schema_version=0 WHERE id=$1',[tableId])).rejects.toMatchObject({code:'23514'});
  });
  it('fresh trigger validation sees schema committed after the outer statement began',async()=>{
    await seed();const a=await client(),b=await client();
    await a.query('BEGIN');await a.query('SELECT id FROM custom_flow_table_rows WHERE id=$1 FOR UPDATE',[rowId]);
    const pid=(await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    const pending=b.query('UPDATE custom_flow_table_rows SET data=$2 WHERE id=$1',[rowId,{name:'Stale text'}]).then(()=>({code:'success'}),error=>({code:error.code}));
    let blocked=false;
    for(let attempt=0;attempt<100;attempt++){
      blocked=(await db.query("SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waiting===true;
      if(blocked)break;await new Promise(resolve=>setTimeout(resolve,10));
    }
    expect(blocked).toBe(true);
    await a.query("UPDATE custom_flow_table_rows SET data='{}' WHERE id=$1",[rowId]);
    await a.query('UPDATE custom_flow_tables SET columns=$2 WHERE id=$1',[tableId,JSON.stringify([{name:'name',type:'number'}])]);
    await a.query('COMMIT');
    expect(await pending).toEqual({code:'23514'});
  });
  it('service writers obey the same schema guard and later-row failure rolls back the whole statement',async()=>{
    await seed();const c=await client();await c.query('RESET ROLE');await c.query('SET ROLE service_role');
    await expect(c.query('UPDATE custom_flow_table_rows SET data=$2 WHERE id=$1',[rowId,{name:123}])).rejects.toMatchObject({code:'23514'});
    await expect(c.query(`INSERT INTO custom_flow_table_rows(table_id,business_id,row_code,data) VALUES($1,$2,'GOOD','{"name":"A"}'),($1,$2,'BAD','{"name":123}')`,[tableId,biz])).rejects.toMatchObject({code:'23514'});
    expect((await db.query('SELECT count(*)::int n FROM custom_flow_table_rows')).rows[0].n).toBe(1);
  });
  it('cross-tenant row moves fail and do not remove the original row',async()=>{
    await seed();const foreignFlow=randomUUID(),foreignTable=randomUUID();
    await db.query("INSERT INTO custom_flows(id,business_id,name) VALUES($1,$2,'Other')",[foreignFlow,otherBiz]);
    await db.query("INSERT INTO custom_flow_tables(id,business_id,flow_id,name,columns,editor_schema_version) VALUES($1,$2,$3,'other',$4,1)",[foreignTable,otherBiz,foreignFlow,JSON.stringify(columns)]);
    const c=await client();await expect(c.query('UPDATE custom_flow_table_rows SET table_id=$2 WHERE id=$1',[rowId,foreignTable])).rejects.toMatchObject({code:'23503'});
    expect((await db.query('SELECT table_id FROM custom_flow_table_rows WHERE id=$1',[rowId])).rows[0].table_id).toBe(tableId);
  });
});

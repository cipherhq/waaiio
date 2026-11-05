/**
 * Channel Number Continuity — real PostgreSQL tests.
 *
 * Hermetic bootstrap: applies actual M391, M430, M439 §1, M494–M496
 * migrations on a disposable local Postgres. No mock function definitions.
 *
 * Requires TEST_DATABASE_URL pointing to a loopback disposable database.
 * Parent creates the DB; tests apply schema and seed deterministically.
 *
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { hashOperationParams } from '@/lib/admin-step-up';
import { BOOTSTRAP_SQL, M439_S1_SQL, TRUNCATE_SQL, SEED_SQL, OWNER, ADMIN1, ADMIN2, ADMIN3, BIZ, SH_NG, SH_GB, DEDIC, CAND, M_SU, BZDOC, REJ_DOC, FOREIGN_DOC, VREC, } from './fixtures/channel-number-continuity-db';
const url = process.env.TEST_DATABASE_URL;
if (!url)
    throw new Error('TEST_DATABASE_URL is required; security tests cannot be skipped');
// ── Helpers ──────────────────────────────────────────────────────
/** Insert a dedicated channel and assign it to the business. */
async function seedDedicated(pool: pg.Pool | pg.PoolClient) {
    await pool.query(`INSERT INTO public.whatsapp_channels
       (id, business_id, channel_type, phone_number, is_active, connection_status, country_code, connection_method)
     VALUES ($1, $2, 'dedicated', '+2348099999999', true, 'active', 'NG', 'embedded_signup')`, [DEDIC, BIZ]);
    await pool.query(`UPDATE public.businesses
     SET assigned_channel_id = $1, whatsapp_channel_id = $1, wa_method = 'transfer'
     WHERE id = $2`, [DEDIC, BIZ]);
}
/** Insert a ready candidate for BIZ matching current pointers. */
async function seedCandidate(pool: pg.Pool | pg.PoolClient, opts: {
    assignedId?: string | null;
    waMethod?: string;
    replacingId?: string | null;
} = {}) {
    const assigned = opts.assignedId ?? null;
    const waMethod = opts.waMethod ?? 'transfer';
    const replacing = opts.replacingId ?? null;
    await pool.query(`INSERT INTO public.whatsapp_channel_candidates (
       id, business_id, status, connection_source, business_wa_method,
       phone_number, phone_number_normalized, phone_number_id, waba_id,
       display_name, country_code,
       expected_assigned_channel_id, expected_whatsapp_channel_id, expected_wa_method,
       replacing_dedicated_channel_id
     ) VALUES (
       $1, $2, 'ready', 'embedded_signup', 'transfer',
       '+2348011111111', '2348011111111', 'pnid_new', 'waba_new',
       'New Number', 'NG',
       $3, $3, $4, $5
     )`, [CAND, BIZ, assigned, waMethod, replacing]);
}
/** Insert a merchant step-up row for promote or disconnect. */
async function seedMerchantStepUp(pool: pg.Pool | pg.PoolClient, actionType: string, targetId: string, hash: string, session = 'sess-1') {
    await pool.query(`INSERT INTO public.merchant_step_up_authorizations (
       id, owner_user_id, business_id, session_id, action_type,
       target_id, params_hash, verified_at, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW() + INTERVAL '5 minutes')`, [M_SU, OWNER, BIZ, session, actionType, targetId, hash]);
}
// ══════════════════════════════════════════════════════════════════
// Main suite
// ══════════════════════════════════════════════════════════════════
describe('M496 — Channel Number Continuity (real PG)', () => {
    let pool: pg.Pool;
    beforeAll(async () => {
        const target = new URL(url!);
        const isolatedCi = process.env.GITHUB_ACTIONS === 'true'
            && target.username === 'test_runner'
            && /^\/pg_test_\d+$/.test(target.pathname);
        if (!['localhost', '127.0.0.1'].includes(target.hostname)
            || (target.pathname !== '/channel_continuity_test' && !isolatedCi)) {
            throw new Error('Disposable loopback database only');
        }
        pool = new pg.Pool({ connectionString: url });
        // ── Clean slate ──────────────────────────────────────────────
        await pool.query(`
      DROP TABLE IF EXISTS public.whatsapp_signup_sessions CASCADE;
      DROP TABLE IF EXISTS public.admin_audit_logs CASCADE;
      DROP TABLE IF EXISTS public.profiles CASCADE;
      DROP TABLE IF EXISTS public.channel_transition_audit CASCADE;
      DROP TABLE IF EXISTS public.channel_change_approvals CASCADE;
      DROP TABLE IF EXISTS public.merchant_step_up_authorizations CASCADE;
      DROP TABLE IF EXISTS public.admin_step_up_authorizations CASCADE;
      DROP TABLE IF EXISTS public.whatsapp_channel_secrets CASCADE;
      DROP TABLE IF EXISTS public.whatsapp_channel_candidates CASCADE;
      DROP TABLE IF EXISTS public.whatsapp_channels CASCADE;
      DROP TABLE IF EXISTS public.business_documents CASCADE;
      DROP TABLE IF EXISTS public.verification_requests CASCADE;
      DROP TABLE IF EXISTS public.businesses CASCADE;
      DROP TABLE IF EXISTS public.platform_settings CASCADE;
      DROP SCHEMA IF EXISTS auth CASCADE;
      DROP FUNCTION IF EXISTS public.promote_candidate_with_merchant_auth(UUID,UUID,UUID,UUID,TEXT,TEXT);
      DROP FUNCTION IF EXISTS public.disconnect_with_merchant_auth(UUID,UUID,UUID,UUID,TEXT,TEXT);
      DROP FUNCTION IF EXISTS public.execute_channel_change_approval(UUID,UUID,UUID,TEXT,TEXT);
      DROP FUNCTION IF EXISTS public.cleanup_expired_merchant_step_ups();
      DROP FUNCTION IF EXISTS public.transition_to_shared(UUID);
      DROP FUNCTION IF EXISTS public.reassign_shared_channel(UUID,UUID);
      DROP FUNCTION IF EXISTS public.allocate_shared_channel(UUID,TEXT);
      DROP FUNCTION IF EXISTS public.get_bot_context(TEXT,UUID);
      DROP FUNCTION IF EXISTS public.promote_channel_candidate(UUID,UUID);
      DROP FUNCTION IF EXISTS public.check_phone_conflict(TEXT,UUID,TEXT);
    `);
        // ── Apply schema ─────────────────────────────────────────────
        await pool.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM service_role');
        await pool.query(BOOTSTRAP_SQL);
        await pool.query(readFileSync('supabase/migrations/391_channel_candidate_system.sql', 'utf8'));
        await pool.query(readFileSync('supabase/migrations/430_shared_number_tenant_isolation.sql', 'utf8'));
        await pool.query(M439_S1_SQL);
        await pool.query(readFileSync('supabase/migrations/494_business_status_step_up.sql', 'utf8'));
        await pool.query(readFileSync('supabase/migrations/495_embedded_signup_sessions.sql', 'utf8'));
        // Supabase-style broad service defaults must not survive explicit continuity grants.
        await pool.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role');
        await pool.query('CREATE TABLE public.continuity_default_grant_probe(id integer)');
        const inherited = await pool.query(`SELECT has_table_privilege('service_role', 'public.continuity_default_grant_probe', 'UPDATE') AS u,
          has_table_privilege('service_role', 'public.continuity_default_grant_probe', 'DELETE') AS d`);
        expect(inherited.rows[0]).toEqual({ u: true, d: true });
        await pool.query('DROP TABLE public.continuity_default_grant_probe');
        await pool.query(readFileSync('supabase/migrations/496_channel_number_continuity.sql', 'utf8'));
        await pool.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM service_role');
    });
    afterAll(async () => { await pool?.end(); });
    beforeEach(async () => {
        await pool.query(TRUNCATE_SQL);
        await pool.query(SEED_SQL);
    });
    // ════════════════════════════════════════════════════════════════
    // §1. Schema & Grant Verification
    // ════════════════════════════════════════════════════════════════
    describe('Schema & Grants', () => {
        it('normalizes all service-role table permissions despite inherited ALL defaults', async () => {
            for (const table of ['merchant_step_up_authorizations', 'channel_change_approvals', 'channel_transition_audit']) {
                const { rows: [grants] } = await pool.query(`SELECT
                  has_table_privilege('service_role',$1,'SELECT') AS s,
                  has_table_privilege('service_role',$1,'INSERT') AS i,
                  has_table_privilege('service_role',$1,'UPDATE') AS u,
                  has_table_privilege('service_role',$1,'DELETE') AS d,
                  has_table_privilege('service_role',$1,'TRUNCATE') AS t,
                  has_table_privilege('service_role',$1,'REFERENCES') AS r,
                  has_table_privilege('service_role',$1,'TRIGGER') AS g`, ['public.' + table]);
                expect(grants).toEqual({ s: true, i: true, u: table !== 'channel_transition_audit', d: false, t: false, r: false, g: false });
            }
        });

        it('all new tables deny public client access and retain RLS in final state', async () => {
            for (const table of ['merchant_step_up_authorizations', 'channel_change_approvals', 'channel_transition_audit', 'whatsapp_signup_sessions']) {
                const { rows: [state] } = await pool.query(`SELECT relrowsecurity AS rls,
          has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS anon,
          has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS authenticated
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname=$1`, [table]);
                expect(state).toEqual({ rls: true, anon: false, authenticated: false });
            }
        });
        it('merchant_step_up_authorizations: RLS enabled', async () => {
            const r = await pool.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'merchant_step_up_authorizations'`);
            expect(r.rows).toHaveLength(1);
            expect(r.rows[0].relrowsecurity).toBe(true);
        });
        it('channel_change_approvals: RLS enabled', async () => {
            const r = await pool.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'channel_change_approvals'`);
            expect(r.rows).toHaveLength(1);
            expect(r.rows[0].relrowsecurity).toBe(true);
        });
        it('channel_transition_audit: append-only (no UPDATE/DELETE for service_role)', async () => {
            const r = await pool.query(`
        SELECT
          has_table_privilege('service_role', 'public.channel_transition_audit', 'INSERT') as i,
          has_table_privilege('service_role', 'public.channel_transition_audit', 'SELECT') as s,
          has_table_privilege('service_role', 'public.channel_transition_audit', 'UPDATE') as u,
          has_table_privilege('service_role', 'public.channel_transition_audit', 'DELETE') as d
      `);
            expect(r.rows[0]).toEqual({ i: true, s: true, u: false, d: false });
        });
        it('all M496 functions are SECURITY DEFINER with search_path', async () => {
            const fns = [
                'promote_candidate_with_merchant_auth',
                'disconnect_with_merchant_auth',
                'execute_channel_change_approval',
                'channel_change_evidence', 'channel_change_shared_target',
                'channel_change_candidate_target', 'channel_change_operation',
                'channel_change_action_descriptor', 'channel_change_check_authorization',
                'mutate_channel_change_approval', 'transition_to_shared_exact',
                'cleanup_expired_merchant_step_ups',
            ];
            for (const fn of fns) {
                const r = await pool.query(`SELECT prosecdef, proconfig FROM pg_proc p
           JOIN pg_namespace n ON p.pronamespace = n.oid
           WHERE n.nspname = 'public' AND p.proname = $1`, [fn]);
                expect(r.rows.length).toBeGreaterThan(0);
                expect(r.rows[0].prosecdef).toBe(true);
                expect((r.rows[0].proconfig as string[]).some((c: string) => c === 'search_path=""')).toBe(true);
            }
        });
        it('anon/authenticated cannot execute any wrapper function', async () => {
            for (const sig of [
                'promote_candidate_with_merchant_auth(uuid,uuid,uuid,uuid,text,text)',
                'disconnect_with_merchant_auth(uuid,uuid,uuid,uuid,text,text)',
                'execute_channel_change_approval(uuid,uuid,uuid,text,text)',
                'channel_change_evidence(uuid,jsonb)', 'channel_change_shared_target(uuid,uuid)',
                'channel_change_candidate_target(uuid,uuid)', 'channel_change_operation(uuid,uuid,jsonb,integer)',
                'channel_change_action_descriptor(text,uuid,text,uuid,uuid,jsonb)',
                'channel_change_check_authorization(uuid,uuid,text,text,text,text,boolean)',
                'mutate_channel_change_approval(text,uuid,text,uuid,uuid,jsonb,uuid,text)',
                'transition_to_shared_exact(uuid,uuid)', 'cleanup_expired_merchant_step_ups()',
            ]) {
                const r = await pool.query(`SELECT
             has_function_privilege('anon', $1, 'EXECUTE') as anon,
             has_function_privilege('authenticated', $1, 'EXECUTE') as auth,
             has_function_privilege('service_role', $1, 'EXECUTE') as service`, [sig]);
                expect(r.rows[0].anon).toBe(false);
                expect(r.rows[0].auth).toBe(false);
                expect(r.rows[0].service).toBe(true);
            }
        });
        it('chk_distinct_approver constraint exists', async () => {
            const r = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname = 'chk_distinct_approver'`);
            expect(r.rows).toHaveLength(1);
        });
        it('chk_owner_not_requester constraint exists', async () => {
            const r = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname = 'chk_owner_not_requester'`);
            expect(r.rows).toHaveLength(1);
        });
        it('partial unique index uq_channel_change_open_per_business exists', async () => {
            const r = await pool.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'uq_channel_change_open_per_business'`);
            expect(r.rows).toHaveLength(1);
        });
        it('admin step-up CHECK accepts channel_change_execute', async () => {
            // Insert must succeed (action_type in updated CHECK)
            await pool.query(`INSERT INTO public.admin_step_up_authorizations
           (id, admin_user_id, session_id, action_type, params_hash, verified_at, expires_at)
         VALUES (gen_random_uuid(), $1, 'sess', 'channel_change_execute', 'h', NOW(), NOW() + INTERVAL '5 minutes')`, [ADMIN1]);
            // Unknown action must fail
            await expect(pool.query(`INSERT INTO public.admin_step_up_authorizations
             (id, admin_user_id, session_id, action_type, params_hash)
           VALUES (gen_random_uuid(), $1, 'sess', 'unknown_action', 'h')`, [ADMIN1])).rejects.toMatchObject({ code: '23514' });
        });
    });
    // ════════════════════════════════════════════════════════════════
    // §2. promote_candidate_with_merchant_auth
    // ════════════════════════════════════════════════════════════════
    describe('promote_candidate_with_merchant_auth', () => {
        it('promotion audit records the actual coexist business mode', async () => {
            await seedCandidate(pool);
            await pool.query("UPDATE whatsapp_channel_candidates SET business_wa_method='coexist' WHERE id=$1", [CAND]);
            const { rows: [result] } = await pool.query('SELECT promote_candidate_with_merchant_auth($1,$2,NULL,$3,NULL,NULL) AS value', [CAND, BIZ, OWNER]);
            const { rows: [biz] } = await pool.query('SELECT wa_method,assigned_channel_id FROM businesses WHERE id=$1', [BIZ]);
            expect(biz.wa_method).toBe('coexist');
            const { rows: [audit] } = await pool.query('SELECT new_wa_method,new_channel_id,new_assigned_channel_id FROM channel_transition_audit WHERE business_id=$1', [BIZ]);
            expect(audit).toEqual({ new_wa_method: biz.wa_method, new_channel_id: result.value.channel_id, new_assigned_channel_id: biz.assigned_channel_id });
        });
        it('promotion audit retains the old shared channel on shared-to-dedicated upgrade', async () => {
            await pool.query("UPDATE businesses SET wa_method='shared',assigned_channel_id=$1 WHERE id=$2", [SH_NG, BIZ]);
            await seedCandidate(pool, { assignedId: SH_NG, waMethod: 'shared' });
            await pool.query('UPDATE whatsapp_channel_candidates SET expected_whatsapp_channel_id=NULL WHERE id=$1', [CAND]);
            await seedMerchantStepUp(pool, 'channel_number_change', CAND, 'upgrade-hash');
            const { rows: [result] } = await pool.query('SELECT promote_candidate_with_merchant_auth($1,$2,$3,$4,$5,$6) AS value', [CAND, BIZ, M_SU, OWNER, 'sess-1', 'upgrade-hash']);
            expect(result.value.ok).toBe(true);
            const { rows: [audit] } = await pool.query('SELECT old_channel_id,old_wa_method,old_assigned_channel_id,new_wa_method FROM channel_transition_audit WHERE business_id=$1', [BIZ]);
            expect(audit).toEqual({ old_channel_id: SH_NG, old_wa_method: 'shared', old_assigned_channel_id: SH_NG, new_wa_method: 'transfer' });
        });

        it('first-connect: succeeds without step-up, creates audit', async () => {
            // Business has no channel assignments — no authority
            await seedCandidate(pool, { assignedId: null, waMethod: 'transfer' });
            const { rows } = await pool.query(`SELECT public.promote_candidate_with_merchant_auth($1, $2, NULL, $3, NULL, NULL) as r`, [CAND, BIZ, OWNER]);
            const r = rows[0].r;
            expect(r.ok).toBe(true);
            expect(r.transition_type).toBe('first_connect');
            expect(r.channel_id).toBeTruthy();
            // Audit row
            const audit = await pool.query(`SELECT transition_type, owner_user_id, merchant_step_up_id, provider_verified
         FROM public.channel_transition_audit WHERE business_id = $1`, [BIZ]);
            expect(audit.rows).toHaveLength(1);
            expect(audit.rows[0].transition_type).toBe('first_connect');
            expect(audit.rows[0].owner_user_id).toBe(OWNER);
            expect(audit.rows[0].merchant_step_up_id).toBeNull();
            expect(audit.rows[0].provider_verified).toBe(true);
            // Business now has dedicated channel assigned
            const { rows: [biz] } = await pool.query(`SELECT assigned_channel_id, whatsapp_channel_id, wa_method FROM public.businesses WHERE id = $1`, [BIZ]);
            expect(biz.assigned_channel_id).toBe(r.channel_id);
            expect(biz.wa_method).toBe('transfer');
        });
        it('replacement: valid step-up consumes auth and creates audit', async () => {
            await seedDedicated(pool);
            await seedCandidate(pool, { assignedId: DEDIC, waMethod: 'transfer', replacingId: DEDIC });
            await seedMerchantStepUp(pool, 'channel_number_change', CAND, 'h1');
            const { rows } = await pool.query(`SELECT public.promote_candidate_with_merchant_auth($1, $2, $3, $4, $5, $6) as r`, [CAND, BIZ, M_SU, OWNER, 'sess-1', 'h1']);
            expect(rows[0].r.ok).toBe(true);
            expect(rows[0].r.transition_type).toBe('replacement');
            // Step-up consumed
            const { rows: [su] } = await pool.query(`SELECT consumed_at FROM public.merchant_step_up_authorizations WHERE id = $1`, [M_SU]);
            expect(su.consumed_at).not.toBeNull();
            // Audit row
            const audit = await pool.query(`SELECT transition_type, merchant_step_up_id FROM public.channel_transition_audit WHERE business_id = $1`, [BIZ]);
            expect(audit.rows).toHaveLength(1);
            expect(audit.rows[0].transition_type).toBe('replacement');
            expect(audit.rows[0].merchant_step_up_id).toBe(M_SU);
            // Old channel deactivated
            const { rows: [old] } = await pool.query(`SELECT is_active FROM public.whatsapp_channels WHERE id = $1`, [DEDIC]);
            expect(old.is_active).toBe(false);
        });
        it('replacement: NULL session_id raises session_binding_required', async () => {
            await seedDedicated(pool);
            await seedCandidate(pool, { assignedId: DEDIC, waMethod: 'transfer', replacingId: DEDIC });
            await seedMerchantStepUp(pool, 'channel_number_change', CAND, 'h1');
            // p_session_id=NULL, p_params_hash=NULL → session_binding_required
            // (raised AFTER successful promotion, so tests transaction rollback too)
            await expect(pool.query(`SELECT public.promote_candidate_with_merchant_auth($1, $2, $3, $4, NULL, NULL)`, [CAND, BIZ, M_SU, OWNER])).rejects.toThrow('session_binding_required');
        });
        it('replacement: consumed step-up raises step_up_invalid', async () => {
            await seedDedicated(pool);
            await seedCandidate(pool, { assignedId: DEDIC, waMethod: 'transfer', replacingId: DEDIC });
            await seedMerchantStepUp(pool, 'channel_number_change', CAND, 'h1');
            // Pre-consume the step-up
            await pool.query(`UPDATE public.merchant_step_up_authorizations SET consumed_at = NOW() WHERE id = $1`, [M_SU]);
            await expect(pool.query(`SELECT public.promote_candidate_with_merchant_auth($1, $2, $3, $4, $5, $6)`, [CAND, BIZ, M_SU, OWNER, 'sess-1', 'h1'])).rejects.toThrow('step_up_invalid');
        });
        it('rollback: invalid step-up after promotion restores all state', async () => {
            await seedDedicated(pool);
            await seedCandidate(pool, { assignedId: DEDIC, waMethod: 'transfer', replacingId: DEDIC });
            await seedMerchantStepUp(pool, 'channel_number_change', CAND, 'correct-hash');
            // Call with WRONG hash → promote succeeds inside the txn, but
            // step-up consume finds 0 rows → RAISE → full rollback
            await expect(pool.query(`SELECT public.promote_candidate_with_merchant_auth($1, $2, $3, $4, $5, $6)`, [CAND, BIZ, M_SU, OWNER, 'sess-1', 'wrong-hash'])).rejects.toThrow('step_up_invalid');
            // Business pointers unchanged
            const { rows: [biz] } = await pool.query(`SELECT assigned_channel_id, whatsapp_channel_id, wa_method
         FROM public.businesses WHERE id = $1`, [BIZ]);
            expect(biz.assigned_channel_id).toBe(DEDIC);
            expect(biz.whatsapp_channel_id).toBe(DEDIC);
            expect(biz.wa_method).toBe('transfer');
            // Candidate still exists
            const cands = await pool.query(`SELECT status FROM public.whatsapp_channel_candidates WHERE id = $1`, [CAND]);
            expect(cands.rows).toHaveLength(1);
            expect(cands.rows[0].status).toBe('ready');
            // Step-up not consumed
            const { rows: [su] } = await pool.query(`SELECT consumed_at FROM public.merchant_step_up_authorizations WHERE id = $1`, [M_SU]);
            expect(su.consumed_at).toBeNull();
            // No audit rows
            const audit = await pool.query(`SELECT 1 FROM public.channel_transition_audit WHERE business_id = $1`, [BIZ]);
            expect(audit.rows).toHaveLength(0);
        });
        it('no authority and NULL step-up skips step-up check entirely', async () => {
            // Business has no channels, no authority → step-up not required
            await seedCandidate(pool, { assignedId: null, waMethod: 'transfer' });
            const { rows } = await pool.query(`SELECT public.promote_candidate_with_merchant_auth($1, $2, NULL, $3, NULL, NULL) as r`, [CAND, BIZ, OWNER]);
            expect(rows[0].r.ok).toBe(true);
            // No step-up consumed (none was provided)
            const su = await pool.query(`SELECT 1 FROM public.merchant_step_up_authorizations WHERE business_id = $1`, [BIZ]);
            expect(su.rows).toHaveLength(0);
        });
    });
    // ════════════════════════════════════════════════════════════════
    // §3. disconnect_with_merchant_auth
    // ════════════════════════════════════════════════════════════════
    describe('disconnect_with_merchant_auth', () => {
        it('missing explicit target fails without consuming authorization', async () => {
            await seedDedicated(pool);
            await seedMerchantStepUp(pool, 'channel_disconnect', SH_NG, 'h');
            await expect(pool.query('SELECT disconnect_with_merchant_auth($1,$2,$3,NULL,$4,$5)', [BIZ, M_SU, OWNER, 'sess-1', 'h'])).rejects.toThrow('target_required');
            expect((await pool.query('SELECT consumed_at FROM merchant_step_up_authorizations WHERE id=$1', [M_SU])).rows[0].consumed_at).toBeNull();
        });
        it('another eligible destination cannot reuse the selected destination authorization', async () => {
            await seedDedicated(pool);
            await pool.query("UPDATE whatsapp_channels SET country_code='NG' WHERE id=$1", [SH_GB]);
            const hash = hashOperationParams({ action: 'channel_disconnect', business_id: BIZ, target_channel_id: SH_NG });
            await seedMerchantStepUp(pool, 'channel_disconnect', SH_NG, hash);
            await expect(pool.query('SELECT disconnect_with_merchant_auth($1,$2,$3,$4,$5,$6)', [BIZ, M_SU, OWNER, SH_GB, 'sess-1', hash])).rejects.toThrow('step_up_invalid');
            expect((await pool.query('SELECT assigned_channel_id FROM businesses WHERE id=$1', [BIZ])).rows[0].assigned_channel_id).toBe(DEDIC);
            expect((await pool.query('SELECT consumed_at FROM merchant_step_up_authorizations WHERE id=$1', [M_SU])).rows[0].consumed_at).toBeNull();
        });
        it('merchant cannot replace an existing shared assignment', async () => {
            await pool.query("UPDATE businesses SET wa_method='shared',assigned_channel_id=$1 WHERE id=$2", [SH_NG, BIZ]);
            await pool.query("UPDATE whatsapp_channels SET country_code='NG' WHERE id=$1", [SH_GB]);
            await seedMerchantStepUp(pool, 'channel_disconnect', SH_GB, 'h');
            await expect(pool.query('SELECT disconnect_with_merchant_auth($1,$2,$3,$4,$5,$6)', [BIZ, M_SU, OWNER, SH_GB, 'sess-1', 'h'])).rejects.toThrow('shared_replacement_requires_admin');
            expect((await pool.query('SELECT assigned_channel_id FROM businesses WHERE id=$1', [BIZ])).rows[0].assigned_channel_id).toBe(SH_NG);
        });
        it('succeeds with valid step-up, transitions to shared, creates audit', async () => {
            await seedDedicated(pool);
            await seedMerchantStepUp(pool, 'channel_disconnect', SH_NG, hashOperationParams({ action: 'channel_disconnect', business_id: BIZ, target_channel_id: SH_NG }));
            const { rows } = await pool.query(`SELECT public.disconnect_with_merchant_auth($1, $2, $3, $6, $4, $5) as r`, [BIZ, M_SU, OWNER, 'sess-1', hashOperationParams({ action: 'channel_disconnect', business_id: BIZ, target_channel_id: SH_NG }), SH_NG]);
            expect(rows[0].r.ok).toBe(true);
            // Step-up consumed
            const { rows: [su] } = await pool.query(`SELECT consumed_at FROM public.merchant_step_up_authorizations WHERE id = $1`, [M_SU]);
            expect(su.consumed_at).not.toBeNull();
            // Business now shared with NG channel
            const { rows: [biz] } = await pool.query(`SELECT wa_method, assigned_channel_id, whatsapp_channel_id
         FROM public.businesses WHERE id = $1`, [BIZ]);
            expect(biz.wa_method).toBe('shared');
            expect(biz.assigned_channel_id).toBe(SH_NG);
            expect(biz.whatsapp_channel_id).toBeNull();
            // Audit
            const audit = await pool.query(`SELECT transition_type, merchant_step_up_id
         FROM public.channel_transition_audit WHERE business_id = $1`, [BIZ]);
            expect(audit.rows).toHaveLength(1);
            expect(audit.rows[0].transition_type).toBe('disconnect');
            expect(audit.rows[0].merchant_step_up_id).toBe(M_SU);
        });
        it('NULL session_id raises session_binding_required', async () => {
            await seedDedicated(pool);
            await seedMerchantStepUp(pool, 'channel_disconnect', SH_NG, hashOperationParams({ action: 'channel_disconnect', business_id: BIZ, target_channel_id: SH_NG }));
            await expect(pool.query(`SELECT public.disconnect_with_merchant_auth($1, $2, $3, $4, NULL, NULL)`, [BIZ, M_SU, OWNER, SH_NG])).rejects.toThrow('session_binding_required');
        });
        it('invalid step-up raises step_up_invalid', async () => {
            await seedDedicated(pool);
            await seedMerchantStepUp(pool, 'channel_disconnect', SH_NG, hashOperationParams({ action: 'channel_disconnect', business_id: BIZ, target_channel_id: SH_NG }));
            await expect(pool.query(`SELECT public.disconnect_with_merchant_auth($1, $2, $3, $6, $4, $5)`, [BIZ, M_SU, OWNER, 'sess-1', 'wrong-hash', SH_NG])).rejects.toThrow('step_up_invalid');
            // Rollback: business still dedicated
            const { rows: [biz] } = await pool.query(`SELECT wa_method, assigned_channel_id FROM public.businesses WHERE id = $1`, [BIZ]);
            expect(biz.wa_method).toBe('transfer');
            expect(biz.assigned_channel_id).toBe(DEDIC);
            // No audit
            const audit = await pool.query(`SELECT 1 FROM public.channel_transition_audit WHERE business_id = $1`, [BIZ]);
            expect(audit.rows).toHaveLength(0);
        });
    });
    describe('Atomic admin lifecycle', () => {
        type Envelope = {
            action: string;
            actor_user_id: string;
            approval_id: string | null;
            operation: Record<string, unknown>;
        };
        type Authorization = {
            id: string;
            text: string;
            envelope: Envelope;
        };
        let db: pg.PoolClient;
        beforeEach(async () => { db = await pool.connect(); await db.query('BEGIN'); });
        afterEach(async () => { await db.query('ROLLBACK'); db.release(); });
        const details = { request_type: 'recovery', reason: 'Synthetic review', target_action: 'transition_to_shared', target_channel_id: SH_NG, target_candidate_id: null, verification_record: { owner_reverified: true, verification_method: 'manual_document_review', evidence_refs: [{ type: 'business_document', document_id: BZDOC }] } };
        function stable(v: unknown): string { if (v === null || v === undefined)
            return 'null'; if (Array.isArray(v))
            return '[' + v.map(stable).join(',') + ']'; if (typeof v === 'object')
            return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable((v as Record<string, unknown>)[k])).join(',') + '}'; return JSON.stringify(v) ?? 'null'; }
        const session = (actor: string) => 'synthetic-' + actor;
        async function descriptor(action: string, actor: string, id: string | null = null, d: Record<string, unknown> = details): Promise<Envelope> { return (await db.query('SELECT public.channel_change_action_descriptor($1,$2,$3,$4,$5,$6::jsonb) AS value', [action, actor, session(actor), BIZ, id, JSON.stringify(d)])).rows[0].value; }
        async function authorize(envelope: Envelope, actor = envelope.actor_user_id) { const text = stable(envelope), id = crypto.randomUUID(); const target = ['approve', 'execute'].includes(envelope.action) ? envelope.approval_id : BIZ; await db.query("INSERT INTO admin_step_up_authorizations(id,admin_user_id,session_id,action_type,target_id,params_hash,verified_at,expires_at) VALUES($1,$2,$3,$6,$4,$5,NOW(),NOW()+INTERVAL '5 minutes')", [id, actor, session(actor), target, crypto.createHash('sha256').update(text).digest('hex'), envelope.action === 'execute' ? 'channel_change_execute' : 'messaging_config']); return { id, text, envelope }; }
        async function mutate(auth: Authorization, d: Record<string, unknown> = auth.envelope.operation, actor = auth.envelope.actor_user_id) { const e = auth.envelope; return (await db.query('SELECT public.mutate_channel_change_approval($1,$2,$3,$4,$5,$6::jsonb,$7,$8) AS value', [e.action, actor, session(actor), BIZ, e.approval_id, JSON.stringify(d), auth.id, auth.text])).rows[0].value; }
        async function create(d: Record<string, unknown> = details) { const a = await authorize(await descriptor('create', ADMIN1, null, d)); return { result: await mutate(a), auth: a }; }
        async function denyUnconsumed(auth: Authorization, fn: () => Promise<unknown>, pattern: RegExp) { await db.query('SAVEPOINT attempted'); await assert.rejects(fn(), pattern); await db.query('ROLLBACK TO SAVEPOINT attempted'); assert.equal((await db.query('SELECT consumed_at FROM admin_step_up_authorizations WHERE id=$1', [auth.id])).rows[0].consumed_at, null); }
        it('create consumes exact authorization and audits atomically without switching channel', async () => { const { result, auth } = await create(); assert.equal(result.status, 'pending'); const r = (await db.query('SELECT * FROM channel_change_approvals WHERE id=$1', [result.id])).rows[0]; assert.equal(r.requester_authorized_text, auth.text); assert.equal(r.requester_session_id, session(ADMIN1)); assert.equal(r.operation_descriptor.owner_user_id, OWNER); assert.ok((await db.query('SELECT consumed_at FROM admin_step_up_authorizations WHERE id=$1', [auth.id])).rows[0].consumed_at); assert.equal((await db.query('SELECT count(*)::int AS n FROM admin_audit_logs')).rows[0].n, 1); assert.equal((await db.query('SELECT assigned_channel_id FROM businesses WHERE id=$1', [BIZ])).rows[0].assigned_channel_id, null); });
        it('second distinct admin can approve exact reviewed operation', async () => { const { result } = await create(); const a = await authorize(await descriptor('approve', ADMIN2, result.id, { review_confirmed: true })); const r = await mutate(a, { review_confirmed: true }); assert.equal(r.status, 'approved'); const row = (await db.query('SELECT * FROM channel_change_approvals WHERE id=$1', [result.id])).rows[0]; assert.equal(row.approver_admin_id, ADMIN2); assert.equal(row.approver_authorized_text, a.text); assert.equal(row.approval_version, 1); });
        it('same admin approval rejected', async () => { const { result } = await create(); await assert.rejects(descriptor('approve', ADMIN1, result.id, { review_confirmed: true }), /approver_must_differ/); });
        it('explicit second-admin confirmation required', async () => { const { result } = await create(); await assert.rejects(descriptor('approve', ADMIN2, result.id, { review_confirmed: 'true' }), /review_confirmed_required/); });
        it('stale authorization rejected without consumption or request', async () => { const a = await authorize(await descriptor('create', ADMIN1)); await db.query("UPDATE admin_step_up_authorizations SET verified_at=NOW()-INTERVAL '6 minutes' WHERE id=$1", [a.id]); await denyUnconsumed(a, () => mutate(a), /step_up_stale/); assert.equal((await db.query('SELECT count(*)::int AS n FROM channel_change_approvals')).rows[0].n, 0); });
        it('changed evidence after preview rejects before consumption', async () => { const a = await authorize(await descriptor('create', ADMIN1)); await db.query("UPDATE business_documents SET file_url='/synthetic/replaced.pdf' WHERE id=$1", [BZDOC]); await denyUnconsumed(a, () => mutate(a), /descriptor_changed/); });
        it('duplicate request failure rolls back second authorization consumption', async () => { await create(); const a = await authorize(await descriptor('create', ADMIN1)); await denyUnconsumed(a, () => mutate(a), /uq_channel_change_open_per_business/); });
        it('audit insertion failure rolls back request and authorization', async () => { const a = await authorize(await descriptor('create', ADMIN1)); await db.query("ALTER TABLE admin_audit_logs ADD CONSTRAINT review_force_audit_failure CHECK(action <> 'channel_change_requested')"); await denyUnconsumed(a, () => mutate(a), /review_force_audit_failure/); assert.equal((await db.query('SELECT count(*)::int AS n FROM channel_change_approvals')).rows[0].n, 0); });
        it('refresh increments once and clears previous approval', async () => { const { result } = await create(); const a = await authorize(await descriptor('approve', ADMIN2, result.id, { review_confirmed: true })); await mutate(a, { review_confirmed: true }); const f = await authorize(await descriptor('refresh', ADMIN1, result.id, {})); const r = await mutate(f, {}); assert.equal(r.request_version, 2); const row = (await db.query('SELECT * FROM channel_change_approvals WHERE id=$1', [result.id])).rows[0]; assert.equal(row.status, 'pending'); assert.equal(row.approver_admin_id, null); assert.equal(row.approver_authorized_text, null); assert.equal(row.approval_version, null); assert.equal(row.operation_descriptor.request_version, 2); assert.equal(row.requester_authorized_text, f.text); });
        it('changed destination source prevents refresh', async () => { const { result } = await create(); await db.query("UPDATE whatsapp_channels SET phone_number='+2349000000999' WHERE id=$1", [SH_NG]); await assert.rejects(descriptor('refresh', ADMIN1, result.id, {}), /descriptor_changed/); });
        async function approved(d: Record<string, unknown> = details) { const c = await create(d); const a = await authorize(await descriptor('approve', ADMIN2, c.result.id, { review_confirmed: true })); await mutate(a, { review_confirmed: true }); return { ...c, approver: a }; }
        async function execute(a: Authorization, overrideSession = session(a.envelope.actor_user_id)) { return (await db.query('SELECT public.execute_channel_change_approval($1,$2,$3,$4,$5) AS value', [a.envelope.approval_id, a.envelope.actor_user_id, a.id, overrideSession, a.text])).rows[0].value; }
        it('complete two-admin recovery switches exact target and retires old dedicated authority', async () => { await db.query("INSERT INTO whatsapp_channels(id,business_id,channel_type,phone_number,country_code,is_active,connection_status,connection_method) VALUES($1,$2,'dedicated','+2349000000010','NG',true,'active','embedded_signup')", [DEDIC, BIZ]); await db.query("UPDATE businesses SET assigned_channel_id=$1,whatsapp_channel_id=$1,wa_method='transfer' WHERE id=$2", [DEDIC, BIZ]); const c = await approved(); const a = await authorize(await descriptor('execute', ADMIN3, c.result.id, {})); assert.equal((await execute(a)).new_channel_id, SH_NG); const b = (await db.query('SELECT id,owner_id,assigned_channel_id,whatsapp_channel_id,wa_method FROM businesses WHERE id=$1', [BIZ])).rows[0]; assert.deepEqual(b, { id: BIZ, owner_id: OWNER, assigned_channel_id: SH_NG, whatsapp_channel_id: null, wa_method: 'shared' }); assert.equal((await db.query('SELECT is_active FROM whatsapp_channels WHERE id=$1', [DEDIC])).rows[0].is_active, false); assert.equal((await db.query('SELECT count(*)::int AS n FROM channel_transition_audit')).rows[0].n, 1); assert.equal((await db.query('SELECT status FROM channel_change_approvals WHERE id=$1', [c.result.id])).rows[0].status, 'executed'); });
        it('executor session mismatch rejected without consumption', async () => { const c = await approved(); const a = await authorize(await descriptor('execute', ADMIN3, c.result.id, {})); await denyUnconsumed(a, () => execute(a, 'wrong-session'), /descriptor_changed|step_up_invalid/); });
        it('actual requester session binding rechecked', async () => { const c = await approved(); const a = await authorize(await descriptor('execute', ADMIN3, c.result.id, {})); await db.query("UPDATE admin_step_up_authorizations SET session_id='tampered' WHERE id=$1", [c.auth.id]); await denyUnconsumed(a, () => execute(a), /step_up_invalid/); });
        it('actual approver hash binding rechecked', async () => { const c = await approved(); const a = await authorize(await descriptor('execute', ADMIN3, c.result.id, {})); await db.query("UPDATE admin_step_up_authorizations SET params_hash='tampered' WHERE id=$1", [c.approver.id]); await denyUnconsumed(a, () => execute(a), /step_up_invalid/); });
        it('actual requester staleness overrides fresh copied timestamp', async () => { const c = await approved(); const a = await authorize(await descriptor('execute', ADMIN3, c.result.id, {})); await db.query("UPDATE admin_step_up_authorizations SET verified_at=NOW()-INTERVAL '6 minutes' WHERE id=$1", [c.auth.id]); await denyUnconsumed(a, () => execute(a), /step_up_stale/); });
        it('approval target field drift denied before switching', async () => { const c = await approved(); const a = await authorize(await descriptor('execute', ADMIN3, c.result.id, {})); await db.query('UPDATE channel_change_approvals SET target_channel_id=$1 WHERE id=$2', [SH_GB, c.result.id]); await denyUnconsumed(a, () => execute(a), /approval_descriptor_mismatch/); assert.equal((await db.query('SELECT assigned_channel_id FROM businesses WHERE id=$1', [BIZ])).rows[0].assigned_channel_id, null); });
        it('changed evidence after approval blocks execution', async () => { const c = await approved(); const a = await authorize(await descriptor('execute', ADMIN3, c.result.id, {})); await db.query("UPDATE business_documents SET file_url='/synthetic/changed-after-approval.pdf' WHERE id=$1", [BZDOC]); await denyUnconsumed(a, () => execute(a), /descriptor_changed/); });
        it('refreshed request requires fresh approval and then executes version two', async () => { const c = await approved(); const old = await authorize(await descriptor('execute', ADMIN3, c.result.id, {})); const f = await authorize(await descriptor('refresh', ADMIN1, c.result.id, {})); await mutate(f, {}); await denyUnconsumed(old, () => execute(old), /execute_requires_approved/); const app = await authorize(await descriptor('approve', ADMIN2, c.result.id, { review_confirmed: true })); await mutate(app, { review_confirmed: true }); const a = await authorize(await descriptor('execute', ADMIN3, c.result.id, {})); assert.equal((await execute(a)).ok, true); });
        it('execution audit failure rolls back switch, status and authorization', async () => { const c = await approved(); const a = await authorize(await descriptor('execute', ADMIN3, c.result.id, {})); await db.query("ALTER TABLE admin_audit_logs ADD CONSTRAINT review_force_execute_audit_failure CHECK(action <> 'channel_change_executed')"); await denyUnconsumed(a, () => execute(a), /review_force_execute_audit_failure/); assert.equal((await db.query('SELECT assigned_channel_id FROM businesses WHERE id=$1', [BIZ])).rows[0].assigned_channel_id, null); assert.equal((await db.query('SELECT status FROM channel_change_approvals WHERE id=$1', [c.result.id])).rows[0].status, 'approved'); assert.equal((await db.query('SELECT count(*)::int AS n FROM channel_transition_audit')).rows[0].n, 0); });
        it('replay cannot execute the same approved change twice', async () => { const c = await approved(); const a = await authorize(await descriptor('execute', ADMIN3, c.result.id, {})); await execute(a); await assert.rejects(execute(a), /descriptor_changed|execute_requires_approved/); });
        it('candidate promotion executes the exact reviewed ready candidate', async () => {
            await seedDedicated(db);
            await seedCandidate(db, { assignedId: DEDIC, replacingId: DEDIC });
            const c = await approved({ ...details, target_action: 'promote_candidate', target_channel_id: null, target_candidate_id: CAND });
            const a = await authorize(await descriptor('execute', ADMIN1, c.result.id, {}));
            const result = await execute(a); // requester may execute: no third-admin rule
            expect(result.ok).toBe(true);
            expect(result.new_channel_id).not.toBe(DEDIC);
            const { rows: [biz] } = await db.query('SELECT assigned_channel_id,whatsapp_channel_id,owner_id FROM businesses WHERE id=$1', [BIZ]);
            expect(biz).toEqual({ assigned_channel_id: result.new_channel_id, whatsapp_channel_id: result.new_channel_id, owner_id: OWNER });
            const { rows: [old] } = await db.query('SELECT is_active FROM whatsapp_channels WHERE id=$1', [DEDIC]);
            expect(old.is_active).toBe(false);
        });
        it('legacy dedicated-pointer-only source is retained in the transition audit', async () => {
            await seedDedicated(db);
            await db.query('UPDATE businesses SET assigned_channel_id=NULL WHERE id=$1', [BIZ]);
            const c = await approved();
            const a = await authorize(await descriptor('execute', ADMIN2, c.result.id, {}));
            await execute(a); // approver may also execute
            const { rows: [audit] } = await db.query('SELECT old_channel_id,old_assigned_channel_id,new_channel_id FROM channel_transition_audit WHERE business_id=$1', [BIZ]);
            expect(audit).toEqual({ old_channel_id: DEDIC, old_assigned_channel_id: null, new_channel_id: SH_NG });
        });
        it('concurrent executors produce exactly one transition, terminal state and audit', async () => {
            const c = await approved();
            const first = await authorize(await descriptor('execute', ADMIN1, c.result.id, {}));
            const second = await authorize(await descriptor('execute', ADMIN2, c.result.id, {}));
            await db.query('COMMIT'); // expose fixtures to independent connections
            const clients = await Promise.all([pool.connect(), pool.connect()]);
            try {
                const outcomes = await Promise.allSettled([first, second].map((auth, i) => clients[i].query('SELECT public.execute_channel_change_approval($1,$2,$3,$4,$5) AS value', [c.result.id, auth.envelope.actor_user_id, auth.id, session(auth.envelope.actor_user_id), auth.text])));
                expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
                expect(outcomes.filter(r => r.status === 'rejected')).toHaveLength(1);
                const rejection = outcomes.find(r => r.status === 'rejected') as PromiseRejectedResult;
                expect(rejection.reason.message).toMatch(/descriptor_changed|execute_requires_approved/);
                expect((await db.query('SELECT count(*)::int AS n FROM channel_transition_audit')).rows[0].n).toBe(1);
                expect((await db.query("SELECT count(*)::int AS n FROM admin_audit_logs WHERE action='channel_change_executed'")).rows[0].n).toBe(1);
                expect((await db.query('SELECT status FROM channel_change_approvals WHERE id=$1', [c.result.id])).rows[0].status).toBe('executed');
                expect((await db.query('SELECT count(*)::int AS n FROM admin_step_up_authorizations WHERE id=ANY($1::uuid[]) AND consumed_at IS NOT NULL', [[first.id, second.id]])).rows[0].n).toBe(1);
            }
            finally {
                clients.forEach(client => client.release());
                await db.query('BEGIN');
            }
        });
        it('executor who loses admin role is denied without consuming authorization', async () => {
            const c = await approved();
            const a = await authorize(await descriptor('execute', ADMIN3, c.result.id, {}));
            await db.query("UPDATE auth.users SET raw_app_meta_data='{}'::jsonb WHERE id=$1", [ADMIN3]);
            await denyUnconsumed(a, () => execute(a), /actor_not_admin/);
        });
        it('business owner cannot execute even with admin role', async () => {
            const c = await approved();
            await db.query('UPDATE auth.users SET raw_app_meta_data=$1::jsonb WHERE id=$2', [JSON.stringify({ role: 'admin' }), OWNER]);
            await expect(descriptor('execute', OWNER, c.result.id, {})).rejects.toThrow('actor_is_owner');
        });
        it('changed business pointers invalidate execution', async () => {
            await seedDedicated(db);
            const c = await approved();
            const a = await authorize(await descriptor('execute', ADMIN3, c.result.id, {}));
            await db.query('UPDATE businesses SET assigned_channel_id=$1 WHERE id=$2', [SH_NG, BIZ]);
            await denyUnconsumed(a, () => execute(a), /descriptor_changed/);
        });
        it('executor session must be present', async () => {
            const c = await approved();
            const a = await authorize(await descriptor('execute', ADMIN3, c.result.id, {}));
            await denyUnconsumed(a, () => execute(a, ''), /session_required/);
        });
        it('missing referenced requester authorization denies execution', async () => {
            const c = await approved();
            const a = await authorize(await descriptor('execute', ADMIN3, c.result.id, {}));
            await db.query('DELETE FROM admin_step_up_authorizations WHERE id=$1', [c.auth.id]);
            await denyUnconsumed(a, () => execute(a), /step_up_invalid/);
        });
        it('unknown recovery verification method is rejected before authorization', async () => {
            await expect(descriptor('create', ADMIN1, null, { ...details, verification_record: { ...details.verification_record, verification_method: 'phone_call_verification' } })).rejects.toThrow('invalid_verification_method');
        });
        async function evidence(refs: unknown) { return (await db.query('SELECT public.channel_change_evidence($1,$2::jsonb) AS value', [BIZ, JSON.stringify(refs)])).rows[0].value; }
        async function shared(id = SH_NG) { return (await db.query('SELECT public.channel_change_shared_target($1,$2) AS value', [BIZ, id])).rows[0].value; }
        async function operation(d: Record<string, unknown> = details, actor = ADMIN1, version = 1) { return (await db.query('SELECT public.channel_change_operation($1,$2,$3::jsonb,$4) AS value', [BIZ, actor, JSON.stringify(d), version])).rows[0].value; }
        it('approved tenant document snapshot excludes file URL', async () => { const r = await evidence([{ type: 'business_document', document_id: BZDOC }]); assert.equal(r[0].snapshot.status, 'approved'); assert.equal(JSON.stringify(r).includes('file_url'), false); assert.equal(r[0].snapshot.reviewed_by, ADMIN2); });
        it('completed tenant verification request allowed', async () => { const r = await evidence([{ type: 'verification_request', request_id: VREC }]); assert.equal(r[0].snapshot.status, 'completed'); });
        it('foreign evidence denied', () => assert.rejects(evidence([{ type: 'business_document', document_id: FOREIGN_DOC }]), /invalid_evidence_reference/));
        it('rejected evidence denied', () => assert.rejects(evidence([{ type: 'business_document', document_id: REJ_DOC }]), /invalid_evidence_reference/));
        it('missing and unsupported reference denied', () => assert.rejects(evidence([{ type: 'unsupported' }]), /unknown_evidence_reference_type/));
        it('exact-country connected shared target allowed', async () => { assert.equal((await shared()).id, SH_NG); });
        it('GH to NG existing exception allowed', async () => { await db.query("UPDATE businesses SET country_code='GH' WHERE id=$1", [BIZ]); assert.equal((await shared()).id, SH_NG); });
        it('NULL connection status denied', async () => { await db.query('UPDATE whatsapp_channels SET connection_status=NULL WHERE id=$1', [SH_NG]); await assert.rejects(shared(), /target_channel_no_longer_valid/); });
        it('whitespace-only country denied', async () => { await db.query("UPDATE businesses SET country_code='  ' WHERE id=$1", [BIZ]); await db.query("UPDATE whatsapp_channels SET country_code='  ' WHERE id=$1", [SH_NG]); await assert.rejects(shared(), /target_country_mismatch/); });
        it('foreign-country target denied', () => assert.rejects(shared(SH_GB), /target_country_mismatch/));
        it('owned shared target denied', async () => { await db.query('UPDATE whatsapp_channels SET business_id=$1 WHERE id=$2', [BIZ, SH_NG]); await assert.rejects(shared(), /target_channel_no_longer_valid/); });
        it('full target denied', async () => { await db.query("UPDATE platform_settings SET value='0'::jsonb WHERE key='shared_number_capacity'"); await assert.rejects(shared(), /target_at_capacity/); });
        it('stable recovery descriptor binds owner and reviewed sources without mutation', async () => { const a = await operation(); const b = await operation(a); assert.deepEqual(a, b); assert.equal(a.owner_user_id, OWNER); assert.equal(a.verification_record.verified_by_admin_id, ADMIN1); assert.equal(a.target_channel_id, SH_NG); const state = (await db.query('SELECT assigned_channel_id FROM businesses WHERE id=$1', [BIZ])).rows[0]; assert.equal(state.assigned_channel_id, null); });
        it('manual owner re-verification required', async () => { const d = structuredClone(details); d.verification_record.owner_reverified = false; await assert.rejects(operation(d)); });
        it('business owner cannot request own recovery', () => assert.rejects(operation(details, OWNER)));
        it('invalid request version denied', () => assert.rejects(operation(details, ADMIN1, 0)));
        it('changed document content pointer changes fingerprint', async () => { const a = await evidence([{ type: 'business_document', document_id: BZDOC }]); await db.query('UPDATE business_documents SET file_url=$1 WHERE id=$2', ['/synthetic/replaced.pdf', BZDOC]); const b = await evidence([{ type: 'business_document', document_id: BZDOC }]); assert.notEqual(a[0].snapshot.source_fingerprint, b[0].snapshot.source_fingerprint); });
        it('verification request identity change changes fingerprint without exposing message', async () => { const a = await evidence([{ type: 'verification_request', request_id: VREC }]); await db.query("UPDATE verification_requests SET message='Synthetic private note' WHERE id=$1", [VREC]); const b = await evidence([{ type: 'verification_request', request_id: VREC }]); assert.notEqual(a[0].snapshot.source_fingerprint, b[0].snapshot.source_fingerprint); assert.equal(JSON.stringify(b).includes('Synthetic private note'), false); });
        it('string owner-reverification flag rejected', async () => { const d = { ...details, verification_record: { ...details.verification_record, owner_reverified: 'true' } }; await assert.rejects(operation(d), /owner_reverified_required/); });
        it('malformed irrelevant candidate ID rejected', async () => { const d = { ...details, target_candidate_id: 'malformed' }; await assert.rejects(operation(d), /invalid_target_id/); });
        it('dedicated recovery cannot use shared reassignment shortcut', async () => { await assert.rejects(operation({ ...details, target_action: 'reassign_shared_channel' }), /reassign_requires_shared_business/); });
        it('shared recovery can use shared reassignment', async () => { await db.query("UPDATE businesses SET wa_method='shared',assigned_channel_id=$1 WHERE id=$2", [SH_NG, BIZ]); assert.equal((await operation({ ...details, target_action: 'reassign_shared_channel' })).target_action, 'reassign_shared_channel'); });
        it('ready candidate snapshot and whitespace identity denial', async () => { await db.query("INSERT INTO whatsapp_channel_candidates (id,business_id,connection_source,status,phone_number_normalized,phone_number_id,waba_id,expected_wa_method) VALUES ($1,$2,'embedded_signup','ready','2349000000002','synthetic-pnid','synthetic-waba','transfer')", [CAND, BIZ]); const call = () => db.query('SELECT channel_change_candidate_target($1,$2) AS value', [BIZ, CAND]); const r = await call(); assert.equal(r.rows[0].value.id, CAND); assert.equal('meta_access_token' in r.rows[0].value, false); await db.query("UPDATE whatsapp_channel_candidates SET phone_number_id='  ' WHERE id=$1", [CAND]); await assert.rejects(call(), /target_candidate_invalid/); });
    });
    // ════════════════════════════════════════════════════════════════
    // §6. Identity preservation
    // ════════════════════════════════════════════════════════════════
    describe('Identity preservation', () => {
        it('channel operations do not alter business identity fields', async () => {
            // Snapshot identity before any channel operations
            const { rows: [before] } = await pool.query(`SELECT name, owner_id, slug, subscription_tier, metadata, payment_gateway,
                country_code, verification_level, messaging_suspended, status
         FROM public.businesses WHERE id = $1`, [BIZ]);
            // Perform a full first-connect → replacement → disconnect cycle
            // Step 1: first connect
            await seedCandidate(pool, { assignedId: null, waMethod: 'transfer' });
            await pool.query(`SELECT public.promote_candidate_with_merchant_auth($1, $2, NULL, $3, NULL, NULL)`, [CAND, BIZ, OWNER]);
            // Step 2: disconnect (transition to shared)
            await seedMerchantStepUp(pool, 'channel_disconnect', SH_NG, hashOperationParams({ action: 'channel_disconnect', business_id: BIZ, target_channel_id: SH_NG }));
            await pool.query(`SELECT public.disconnect_with_merchant_auth($1, $2, $3, $6, $4, $5)`, [BIZ, M_SU, OWNER, 'sess-1', hashOperationParams({ action: 'channel_disconnect', business_id: BIZ, target_channel_id: SH_NG }), SH_NG]);
            // Verify all identity fields preserved
            const { rows: [after] } = await pool.query(`SELECT name, owner_id, slug, subscription_tier, metadata, payment_gateway,
                country_code, verification_level, messaging_suspended, status
         FROM public.businesses WHERE id = $1`, [BIZ]);
            expect(after.name).toBe(before.name);
            expect(after.owner_id).toBe(before.owner_id);
            expect(after.slug).toBe(before.slug);
            expect(after.subscription_tier).toBe(before.subscription_tier);
            expect(after.payment_gateway).toBe(before.payment_gateway);
            expect(after.country_code).toBe(before.country_code);
            expect(after.verification_level).toBe(before.verification_level);
            expect(after.messaging_suspended).toBe(before.messaging_suspended);
            expect(after.status).toBe(before.status);
        });
    });
});

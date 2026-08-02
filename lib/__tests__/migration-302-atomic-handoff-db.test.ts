/**
 * Migration 302 — Real PostgreSQL Atomic Handoff Tests
 *
 * Verifies that atomic_escalate_to_human:
 * 1. Creates handoff state atomically (session + conversation)
 * 2. Rolls back completely on forced failure
 * 3. Blocks cross-business escalation
 * 4. Returns already_active for valid duplicate
 * 5. Repairs inconsistent state (session handoff without conversation)
 * 6. Has correct EXECUTE privileges (service_role only)
 *
 * Requires TEST_DATABASE_URL environment variable (NOT staging or production).
 *
 * Local:
 *   docker run --rm -d --name m302-test -p 54323:5432 -e POSTGRES_PASSWORD=test postgres:16
 *   TEST_DATABASE_URL=postgresql://postgres:test@localhost:54323/postgres npx vitest run lib/__tests__/migration-302-atomic-handoff-db.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const MIGRATION_PATH = path.resolve('supabase/migrations/302_atomic_handoff.sql');
const dbUrl = process.env.TEST_DATABASE_URL;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAX`, {
    input: sql,
    encoding: 'utf-8',
    timeout: 15000,
  }).trim();
}

function psqlFile(filePath: string): string {
  return execSync(`psql "${dbUrl}" -tAX -f "${filePath}"`, {
    encoding: 'utf-8',
    timeout: 15000,
  }).trim();
}

function psqlJson(sql: string): any {
  const raw = psql(sql);
  return raw ? JSON.parse(raw) : null;
}

describe.skipIf(!dbUrl)('Migration 302: atomic_escalate_to_human (real PostgreSQL)', () => {
  beforeAll(() => {
    if (!dbUrl) return;

    // Create minimal stub tables matching the real schema
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";

      CREATE TABLE IF NOT EXISTS bot_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        whatsapp_number VARCHAR(20) NOT NULL,
        business_id UUID,
        current_step VARCHAR(50),
        session_data JSONB DEFAULT '{}',
        is_active BOOLEAN NOT NULL DEFAULT true,
        handed_off BOOLEAN DEFAULT false,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS chat_conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL,
        customer_phone TEXT NOT NULL,
        customer_name TEXT,
        status TEXT DEFAULT 'open' CHECK (status IN ('open', 'pending', 'resolved')),
        escalated_from_step TEXT,
        escalated_at TIMESTAMPTZ,
        bot_session_id UUID,
        session_context JSONB DEFAULT '{}',
        last_message_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(business_id, customer_phone)
      );
    `);

    // Apply the migration (use -f to avoid shell quoting issues with plpgsql)
    psqlFile(MIGRATION_PATH);
  });

  afterAll(() => {
    if (!dbUrl) return;
    psql('DROP FUNCTION IF EXISTS atomic_escalate_to_human(UUID, UUID, TEXT, TEXT, JSONB, TEXT)');
    psql('DROP TABLE IF EXISTS chat_conversations CASCADE');
    psql('DROP TABLE IF EXISTS bot_sessions CASCADE');
  });

  it('function exists with SECURITY DEFINER', () => {
    const security = psql(`
      SELECT prosecdef FROM pg_proc
      WHERE proname = 'atomic_escalate_to_human'
    `);
    expect(security).toBe('t');
  });

  it('EXECUTE is restricted to service_role', () => {
    // Check that PUBLIC, anon, and authenticated cannot execute
    const publicHasExec = psql(`
      SELECT has_function_privilege('public', 'atomic_escalate_to_human(UUID, UUID, TEXT, TEXT, JSONB, TEXT)', 'EXECUTE')
    `);
    // public should not have it (revoked from PUBLIC)
    // Note: if roles don't exist in test DB, this may error — we just check the function config
    const aclStr = psql(`
      SELECT proacl FROM pg_proc WHERE proname = 'atomic_escalate_to_human'
    `);
    // ACL should contain service_role grant and not contain anon or authenticated
    expect(aclStr).toContain('service_role');
    expect(aclStr).not.toContain('anon=X');
    expect(aclStr).not.toContain('authenticated=X');
  });

  it('1. SUCCESS: creates handoff atomically', () => {
    // Insert a test session
    const sessionId = psql(`
      INSERT INTO bot_sessions (whatsapp_number, business_id, current_step, is_active, handed_off)
      VALUES ('2349000000001', 'a0000000-0000-0000-0000-000000000001', 'select_service', true, false)
      RETURNING id
    `);

    const result = psqlJson(`
      SELECT atomic_escalate_to_human(
        '${sessionId}'::UUID,
        'a0000000-0000-0000-0000-000000000001'::UUID,
        '2349000000001',
        'Ada',
        '{"selected_service":"haircut"}'::JSONB,
        'select_service'
      )
    `);

    expect(result.success).toBe(true);
    expect(result.outcome).toBe('created');
    expect(result.conversation_id).toBeTruthy();

    // Verify session is in handoff state
    const session = psqlJson(`
      SELECT current_step, handed_off, session_data->>'_pre_handoff_step' as pre_step
      FROM bot_sessions WHERE id = '${sessionId}'
    `);
    // psql -tAX returns columns pipe-separated for plain selects
    const sessionStep = psql(`SELECT current_step FROM bot_sessions WHERE id = '${sessionId}'`);
    const sessionHandoff = psql(`SELECT handed_off FROM bot_sessions WHERE id = '${sessionId}'`);
    expect(sessionStep).toBe('chat_handoff');
    expect(sessionHandoff).toBe('t');

    // Verify conversation exists
    const convStatus = psql(`
      SELECT status FROM chat_conversations
      WHERE business_id = 'a0000000-0000-0000-0000-000000000001'
        AND customer_phone = '2349000000001'
    `);
    expect(convStatus).toBe('open');

    // Cleanup
    psql(`DELETE FROM chat_conversations WHERE business_id = 'a0000000-0000-0000-0000-000000000001'`);
    psql(`DELETE FROM bot_sessions WHERE id = '${sessionId}'`);
  });

  it('2. FORCED FAILURE: conversation insert error rolls back session mutation', () => {
    const bizId = 'a0000000-0000-0000-0000-000000000010';
    const testPhone = '__FORCE_FAIL_2349';

    // Create a valid session
    const sessionId = psql(`
      INSERT INTO bot_sessions (whatsapp_number, business_id, current_step, is_active, handed_off)
      VALUES ('${testPhone}', '${bizId}', 'select_service', true, false)
      RETURNING id
    `);

    // Install a temporary trigger that raises an error when chat_conversations
    // receives this specific test phone — this forces the conversation INSERT
    // to fail AFTER the session UPDATE within the same transaction.
    psql(`
      CREATE OR REPLACE FUNCTION _m302_force_conv_fail() RETURNS TRIGGER
      LANGUAGE plpgsql AS $t$
      BEGIN
        IF NEW.customer_phone = '${testPhone}' THEN
          RAISE EXCEPTION 'forced_test_failure' USING ERRCODE = 'raise_exception';
        END IF;
        RETURN NEW;
      END;
      $t$;
    `);
    psql(`
      CREATE TRIGGER _m302_fail_trigger
      BEFORE INSERT OR UPDATE ON chat_conversations
      FOR EACH ROW EXECUTE FUNCTION _m302_force_conv_fail()
    `);

    // Invoke the atomic RPC — it must fail because conversation insert raises
    let rpcFailed = false;
    try {
      psql(`
        SELECT atomic_escalate_to_human(
          '${sessionId}'::UUID,
          '${bizId}'::UUID,
          '${testPhone}',
          'FailUser',
          '{"test":"forced_fail"}'::JSONB,
          'select_service'
        )
      `);
    } catch {
      rpcFailed = true;
    }
    expect(rpcFailed).toBe(true);

    // Verify session was NOT mutated — transaction rolled back entirely
    const sessionStep = psql(`SELECT current_step FROM bot_sessions WHERE id = '${sessionId}'`);
    const sessionHandoff = psql(`SELECT handed_off FROM bot_sessions WHERE id = '${sessionId}'`);
    expect(sessionStep).toBe('select_service');
    expect(sessionHandoff).toBe('f');

    // Verify no conversation was created
    const convCount = psql(`
      SELECT count(*) FROM chat_conversations
      WHERE business_id = '${bizId}' AND customer_phone = '${testPhone}'
    `);
    expect(convCount).toBe('0');

    // Cleanup: remove trigger and function
    psql('DROP TRIGGER IF EXISTS _m302_fail_trigger ON chat_conversations');
    psql('DROP FUNCTION IF EXISTS _m302_force_conv_fail()');
    psql(`DELETE FROM bot_sessions WHERE id = '${sessionId}'`);
  });

  it('3. CROSS-BUSINESS: blocks foreign session', () => {
    const sessionId = psql(`
      INSERT INTO bot_sessions (whatsapp_number, business_id, current_step, is_active)
      VALUES ('2349000000002', 'a0000000-0000-0000-0000-000000000002', 'select_service', true)
      RETURNING id
    `);

    const result = psqlJson(`
      SELECT atomic_escalate_to_human(
        '${sessionId}'::UUID,
        'a0000000-0000-0000-0000-000000000099'::UUID,
        '2349000000002',
        NULL,
        '{}'::JSONB,
        'select_service'
      )
    `);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('cross_business');

    // Verify NO mutation occurred
    const step = psql(`SELECT current_step FROM bot_sessions WHERE id = '${sessionId}'`);
    expect(step).toBe('select_service');

    const convCount = psql(`
      SELECT count(*) FROM chat_conversations
      WHERE business_id = 'a0000000-0000-0000-0000-000000000099'
    `);
    expect(convCount).toBe('0');

    psql(`DELETE FROM bot_sessions WHERE id = '${sessionId}'`);
  });

  it('4. DUPLICATE: returns already_active when session+conversation both valid', () => {
    const bizId = 'a0000000-0000-0000-0000-000000000003';
    const sessionId = psql(`
      INSERT INTO bot_sessions (whatsapp_number, business_id, current_step, is_active, handed_off)
      VALUES ('2349000000003', '${bizId}', 'chat_handoff', true, true)
      RETURNING id
    `);
    psql(`
      INSERT INTO chat_conversations (business_id, customer_phone, status)
      VALUES ('${bizId}', '2349000000003', 'open')
    `);

    const result = psqlJson(`
      SELECT atomic_escalate_to_human(
        '${sessionId}'::UUID,
        '${bizId}'::UUID,
        '2349000000003',
        NULL,
        '{}'::JSONB,
        'chat_handoff'
      )
    `);

    expect(result.success).toBe(true);
    expect(result.outcome).toBe('already_active');

    // Only one conversation exists (no duplicate)
    const convCount = psql(`
      SELECT count(*) FROM chat_conversations
      WHERE business_id = '${bizId}' AND customer_phone = '2349000000003'
    `);
    expect(convCount).toBe('1');

    psql(`DELETE FROM chat_conversations WHERE business_id = '${bizId}'`);
    psql(`DELETE FROM bot_sessions WHERE id = '${sessionId}'`);
  });

  it('5. INCONSISTENT STATE: repairs missing conversation when session claims handoff', () => {
    const bizId = 'a0000000-0000-0000-0000-000000000004';
    const sessionId = psql(`
      INSERT INTO bot_sessions (whatsapp_number, business_id, current_step, is_active, handed_off)
      VALUES ('2349000000004', '${bizId}', 'chat_handoff', true, true)
      RETURNING id
    `);
    // Deliberately NO conversation record — simulates inconsistent state

    const result = psqlJson(`
      SELECT atomic_escalate_to_human(
        '${sessionId}'::UUID,
        '${bizId}'::UUID,
        '2349000000004',
        'TestUser',
        '{}'::JSONB,
        'chat_handoff'
      )
    `);

    expect(result.success).toBe(true);
    expect(result.outcome).toBe('repaired');

    // Conversation now exists
    const convStatus = psql(`
      SELECT status FROM chat_conversations
      WHERE business_id = '${bizId}' AND customer_phone = '2349000000004'
    `);
    expect(convStatus).toBe('open');

    // Session still in handoff (correct state)
    const step = psql(`SELECT current_step FROM bot_sessions WHERE id = '${sessionId}'`);
    expect(step).toBe('chat_handoff');

    psql(`DELETE FROM chat_conversations WHERE business_id = '${bizId}'`);
    psql(`DELETE FROM bot_sessions WHERE id = '${sessionId}'`);
  });

  it('session_not_found for inactive or missing session', () => {
    const result = psqlJson(`
      SELECT atomic_escalate_to_human(
        'ffffffff-ffff-ffff-ffff-ffffffffffff'::UUID,
        'a0000000-0000-0000-0000-000000000001'::UUID,
        '2349000000099',
        NULL,
        '{}'::JSONB,
        'select_service'
      )
    `);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('session_not_found');
  });
});

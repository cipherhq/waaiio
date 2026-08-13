/**
 * P1-CHAT-1 — Real PostgreSQL Tests: mark_chat_messages_read RPC
 *
 * Requires TEST_DATABASE_URL environment variable.
 * Migrations applied by CI's "Apply all migrations" step.
 *
 * Tests:
 * 1.  Owner can mark messages read via RPC
 * 2.  Active team member can mark messages read via RPC
 * 3.  Cross-business team member denied
 * 4.  Unrelated authenticated user denied
 * 5.  Anonymous denied (auth.uid() = NULL)
 * 6.  Direct team-member UPDATE of message_text denied
 * 7.  Direct team-member UPDATE of business_id denied
 * 8.  Monotonic: false→true succeeds
 * 9.  Idempotent: true→true safe (0 rows, no error)
 * 10. Cannot mark unread (no true→false mechanism)
 * 11. Unread count decreases after RPC
 * 12. Existing INSERT/reply remains intact
 * 13. Service role can execute RPC
 * 14. Owner direct UPDATE still works (existing policy)
 * 15. Inactive team member denied
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;

function psql(sql: string): string {
  const raw = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  });
  return raw.split('\n').filter(l => {
    const t = l.trim();
    return t !== '' && !/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|DO|SET|COMMENT|BEGIN|COMMIT)\b/.test(t);
  }).join('\n').trim();
}

function psqlSafe(sql: string): { stdout: string; error: boolean } {
  try { return { stdout: psql(sql), error: false }; }
  catch (e: any) { return { stdout: e.stderr || e.message || '', error: true }; }
}

/** Run SQL as a specific authenticated user */
function asUser(userId: string, sql: string): string {
  return psql(`
    BEGIN;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $fn$ SELECT '${userId}'::UUID; $fn$ LANGUAGE SQL STABLE;
    SET LOCAL ROLE authenticated;
    ${sql}
    COMMIT;
  `);
}

/** Run SQL as a specific authenticated user, capture errors */
function asUserSafe(userId: string, sql: string): { stdout: string; error: boolean } {
  return psqlSafe(`
    BEGIN;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $fn$ SELECT '${userId}'::UUID; $fn$ LANGUAGE SQL STABLE;
    SET LOCAL ROLE authenticated;
    ${sql}
    COMMIT;
  `);
}

/** Reset auth functions to CI defaults */
function resetAuth(): void {
  psql(`
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$ SELECT '00000000-0000-0000-0000-000000000000'::UUID; $$ LANGUAGE SQL STABLE;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$ SELECT 'authenticated'::TEXT; $$ LANGUAGE SQL STABLE;
  `);
}

const OWNER = '0a300000-0000-0000-0000-000000cc0001';
const OTHER_OWNER = '0a300000-0000-0000-0000-000000cc0002';
const TEAM_MEMBER = '0a300000-0000-0000-0000-000000cc0003';
const UNRELATED = '0a300000-0000-0000-0000-000000cc0004';
const INACTIVE_MEMBER = '0a300000-0000-0000-0000-000000cc0005';
const BIZ = '0a300000-0000-0000-0000-0000000cc001';
const BIZ_2 = '0a300000-0000-0000-0000-0000000cc002';
const MSG_UNREAD = '0a300000-0000-0000-0000-00000ccc0001';
const MSG_READ = '0a300000-0000-0000-0000-00000ccc0002';
const MSG_OTHER = '0a300000-0000-0000-0000-00000ccc0003';
const MSG_OUTBOUND = '0a300000-0000-0000-0000-00000ccc0004';

const describeDb = dbUrl ? describe : describe.skip;

describeDb('P1-CHAT-1: mark_chat_messages_read RPC (Real PostgreSQL)', () => {
  beforeAll(() => {
    psql(`
      ALTER TABLE auth.users DISABLE TRIGGER ALL;
      INSERT INTO auth.users (id) VALUES
        ('${OWNER}'), ('${OTHER_OWNER}'), ('${TEAM_MEMBER}'), ('${UNRELATED}'), ('${INACTIVE_MEMBER}')
      ON CONFLICT DO NOTHING;
      ALTER TABLE auth.users ENABLE TRIGGER ALL;

      INSERT INTO profiles (id, first_name, last_name, email) VALUES
        ('${OWNER}', 'Own', 'Er', 'chtown1@t.l'),
        ('${OTHER_OWNER}', 'Own', 'Er2', 'chtown2@t.l'),
        ('${TEAM_MEMBER}', 'Team', 'M', 'chtteam@t.l'),
        ('${UNRELATED}', 'Un', 'Rel', 'chtunrel@t.l'),
        ('${INACTIVE_MEMBER}', 'Inact', 'M', 'chtinact@t.l')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone, status, country_code)
      VALUES
        ('${BIZ}', 'Chat RPC Biz', 'chat-rpc-1', '${OWNER}', '1 T', 'L', 'V', '+234c001', 'active', 'NG'),
        ('${BIZ_2}', 'Chat RPC Biz2', 'chat-rpc-2', '${OTHER_OWNER}', '2 T', 'L', 'V', '+234c002', 'active', 'NG')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO business_members (business_id, user_id, email, role, status) VALUES
        ('${BIZ}', '${TEAM_MEMBER}', 'chtteam@t.l', 'admin', 'active'),
        ('${BIZ}', '${INACTIVE_MEMBER}', 'chtinact@t.l', 'staff', 'suspended')
      ON CONFLICT DO NOTHING;

      INSERT INTO chat_messages (id, business_id, customer_phone, direction, message_text, is_read) VALUES
        ('${MSG_UNREAD}', '${BIZ}', '+234801', 'inbound', 'Hello', false),
        ('${MSG_READ}', '${BIZ}', '+234801', 'inbound', 'Already read', true),
        ('${MSG_OTHER}', '${BIZ_2}', '+234802', 'inbound', 'Other biz', false),
        ('${MSG_OUTBOUND}', '${BIZ}', '+234801', 'outbound', 'Reply from staff', true)
      ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(() => {
    resetAuth();
    psql(`
      DELETE FROM chat_messages WHERE business_id IN ('${BIZ}', '${BIZ_2}');
      DELETE FROM business_members WHERE business_id IN ('${BIZ}', '${BIZ_2}');
      DELETE FROM businesses WHERE id IN ('${BIZ}', '${BIZ_2}');
      DELETE FROM profiles WHERE id IN ('${OWNER}', '${OTHER_OWNER}', '${TEAM_MEMBER}', '${UNRELATED}', '${INACTIVE_MEMBER}');
      ALTER TABLE auth.users DISABLE TRIGGER ALL;
      DELETE FROM auth.users WHERE id IN ('${OWNER}', '${OTHER_OWNER}', '${TEAM_MEMBER}', '${UNRELATED}', '${INACTIVE_MEMBER}');
      ALTER TABLE auth.users ENABLE TRIGGER ALL;
    `);
  });

  function resetMsg(): void {
    psql(`UPDATE chat_messages SET is_read = false WHERE id = '${MSG_UNREAD}';`);
  }

  it('1. owner can mark messages read via RPC', () => {
    resetMsg();
    const result = asUser(OWNER, `SELECT mark_chat_messages_read('${BIZ}', ARRAY['${MSG_UNREAD}']::UUID[]);`);
    expect(result).toContain('"updated": 1');
    const isRead = psql(`SELECT is_read FROM chat_messages WHERE id = '${MSG_UNREAD}';`);
    expect(isRead).toBe('t');
    resetAuth();
  });

  it('2. active team member can mark messages read via RPC', () => {
    resetMsg();
    const result = asUser(TEAM_MEMBER, `SELECT mark_chat_messages_read('${BIZ}', ARRAY['${MSG_UNREAD}']::UUID[]);`);
    expect(result).toContain('"updated": 1');
    resetAuth();
  });

  it('3. cross-business team member denied', () => {
    const result = asUserSafe(TEAM_MEMBER, `SELECT mark_chat_messages_read('${BIZ_2}', ARRAY['${MSG_OTHER}']::UUID[]);`);
    expect(result.error).toBe(true);
    expect(result.stdout).toContain('authorization_denied');
    const isRead = psql(`SELECT is_read FROM chat_messages WHERE id = '${MSG_OTHER}';`);
    expect(isRead).toBe('f');
    resetAuth();
  });

  it('4. unrelated authenticated user denied', () => {
    const result = asUserSafe(UNRELATED, `SELECT mark_chat_messages_read('${BIZ}', ARRAY['${MSG_UNREAD}']::UUID[]);`);
    expect(result.error).toBe(true);
    expect(result.stdout).toContain('authorization_denied');
    resetAuth();
  });

  it('5. anonymous denied (null auth.uid)', () => {
    const result = psqlSafe(`
      BEGIN;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $fn$ SELECT NULL::UUID; $fn$ LANGUAGE SQL STABLE;
      SET LOCAL ROLE authenticated;
      SELECT mark_chat_messages_read('${BIZ}', ARRAY['${MSG_UNREAD}']::UUID[]);
      COMMIT;
    `);
    expect(result.error).toBe(true);
    expect(result.stdout).toContain('authentication_required');
    resetAuth();
  });

  it('6. direct team-member UPDATE of message_text denied (no UPDATE policy)', () => {
    const result = asUser(TEAM_MEMBER, `UPDATE chat_messages SET message_text = 'hacked' WHERE id = '${MSG_UNREAD}' RETURNING id;`);
    // Team member has no UPDATE policy — 0 rows returned
    expect(result).toBe('');
    const text = psql(`SELECT message_text FROM chat_messages WHERE id = '${MSG_UNREAD}';`);
    expect(text).toBe('Hello');
    resetAuth();
  });

  it('7. direct team-member UPDATE of business_id denied', () => {
    const result = asUser(TEAM_MEMBER, `UPDATE chat_messages SET business_id = '${BIZ_2}' WHERE id = '${MSG_UNREAD}' RETURNING id;`);
    expect(result).toBe('');
    resetAuth();
  });

  it('8. monotonic: false→true succeeds', () => {
    resetMsg();
    const result = asUser(OWNER, `SELECT mark_chat_messages_read('${BIZ}', ARRAY['${MSG_UNREAD}']::UUID[]);`);
    expect(result).toContain('"updated": 1');
    resetAuth();
  });

  it('9. idempotent: true→true safe (0 updated, no error)', () => {
    // MSG_READ is already is_read=true
    const result = asUser(OWNER, `SELECT mark_chat_messages_read('${BIZ}', ARRAY['${MSG_READ}']::UUID[]);`);
    expect(result).toContain('"updated": 0');
    resetAuth();
  });

  it('10. cannot mark unread — RPC only sets true', () => {
    // RPC has no parameter to set is_read=false. The only path is false→true.
    // Verify the function signature doesn't accept a boolean parameter.
    const sig = psql(`
      SELECT pg_get_function_arguments(oid) FROM pg_proc WHERE proname = 'mark_chat_messages_read';
    `);
    expect(sig).not.toContain('boolean');
    expect(sig).toContain('uuid');
    expect(sig).toContain('uuid[]');
  });

  it('11. unread count decreases after RPC', () => {
    resetMsg();
    const before = psql(`SELECT COUNT(*) FROM chat_messages WHERE business_id = '${BIZ}' AND direction = 'inbound' AND is_read = false;`);
    expect(parseInt(before)).toBe(1);

    asUser(OWNER, `SELECT mark_chat_messages_read('${BIZ}', ARRAY['${MSG_UNREAD}']::UUID[]);`);
    resetAuth();

    const after = psql(`SELECT COUNT(*) FROM chat_messages WHERE business_id = '${BIZ}' AND direction = 'inbound' AND is_read = false;`);
    expect(parseInt(after)).toBe(0);
  });

  it('12. existing INSERT/reply remains intact for team member', () => {
    // Team members can INSERT outbound messages (migration 168 policy)
    const result = asUser(TEAM_MEMBER, `
      INSERT INTO chat_messages (business_id, customer_phone, direction, message_text, is_read)
      VALUES ('${BIZ}', '+234801', 'outbound', 'Team reply test', true)
      RETURNING id;
    `);
    expect(result).not.toBe('');
    // Clean up
    psql(`DELETE FROM chat_messages WHERE message_text = 'Team reply test';`);
    resetAuth();
  });

  it('13. service role can execute RPC', () => {
    resetMsg();
    // Override auth.role() AND auth.uid() for service_role context
    const result = psql(`
      BEGIN;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $fn$ SELECT '${OWNER}'::UUID; $fn$ LANGUAGE SQL STABLE;
      CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $fn$ SELECT 'service_role'::TEXT; $fn$ LANGUAGE SQL STABLE;
      SET LOCAL ROLE service_role;
      SELECT mark_chat_messages_read('${BIZ}', ARRAY['${MSG_UNREAD}']::UUID[]);
      COMMIT;
    `);
    expect(result).toContain('"updated": 1');
    resetAuth();
  });

  it('14. owner direct UPDATE still works (existing owner policy)', () => {
    resetMsg();
    const result = asUser(OWNER, `UPDATE chat_messages SET is_read = true WHERE id = '${MSG_UNREAD}' RETURNING id;`);
    expect(result).toContain(MSG_UNREAD);
    resetAuth();
  });

  it('15. inactive team member denied', () => {
    const result = asUserSafe(INACTIVE_MEMBER, `SELECT mark_chat_messages_read('${BIZ}', ARRAY['${MSG_UNREAD}']::UUID[]);`);
    expect(result.error).toBe(true);
    expect(result.stdout).toContain('authorization_denied');
    resetAuth();
  });
});

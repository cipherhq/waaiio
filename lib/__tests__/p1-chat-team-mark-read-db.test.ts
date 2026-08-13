/**
 * P1-CHAT-1 — Real PostgreSQL RLS Tests: Team Member Mark-Read
 *
 * Requires TEST_DATABASE_URL environment variable.
 * Migrations are applied by CI's "Apply all migrations" step.
 *
 * Proves:
 * 1. Business owner can mark messages as read
 * 2. Authorized team member can mark messages as read
 * 3. Team member cannot update another business's messages
 * 4. Unrelated authenticated user cannot update messages
 * 5. Service role can update messages
 * 6. Mark-read is idempotent (already-read message)
 * 7. Team member mark-read actually changes is_read state
 * 8. Cross-business isolation is enforced
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
    return t !== '' && !/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|DO|SET|COMMENT)\b/.test(t);
  }).join('\n').trim();
}

function psqlSafe(sql: string): { stdout: string; error: boolean } {
  try {
    const stdout = psql(sql);
    return { stdout, error: false };
  } catch (e: any) {
    return { stdout: e.stderr || e.message || '', error: true };
  }
}

const OWNER_1 = '0a300000-0000-0000-0000-000000cc0001';
const OWNER_2 = '0a300000-0000-0000-0000-000000cc0002';
const TEAM_MEMBER = '0a300000-0000-0000-0000-000000cc0003';
const UNRELATED_USER = '0a300000-0000-0000-0000-000000cc0004';
const BIZ_1 = '0a300000-0000-0000-0000-0000000cc001';
const BIZ_2 = '0a300000-0000-0000-0000-0000000cc002';

const describeDb = dbUrl ? describe : describe.skip;

describeDb('P1-CHAT-1: chat_messages team-member mark-read RLS (Real PostgreSQL)', () => {
  beforeAll(() => {
    // Create auth users
    psql(`
      ALTER TABLE auth.users DISABLE TRIGGER ALL;
      INSERT INTO auth.users (id) VALUES
        ('${OWNER_1}'), ('${OWNER_2}'), ('${TEAM_MEMBER}'), ('${UNRELATED_USER}')
      ON CONFLICT DO NOTHING;
      ALTER TABLE auth.users ENABLE TRIGGER ALL;
    `);

    // Create profiles
    psql(`
      INSERT INTO profiles (id, first_name, last_name, email) VALUES
        ('${OWNER_1}', 'Owner', 'One', 'owner1@test.local'),
        ('${OWNER_2}', 'Owner', 'Two', 'owner2@test.local'),
        ('${TEAM_MEMBER}', 'Team', 'Member', 'team@test.local'),
        ('${UNRELATED_USER}', 'Unrelated', 'User', 'unrelated@test.local')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Create businesses
    psql(`
      INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone, status, country_code)
      VALUES
        ('${BIZ_1}', 'Chat Test Biz 1', 'chat-test-1', '${OWNER_1}', '1 Test', 'Lagos', 'VI', '+2340001', 'active', 'NG'),
        ('${BIZ_2}', 'Chat Test Biz 2', 'chat-test-2', '${OWNER_2}', '2 Test', 'Lagos', 'VI', '+2340002', 'active', 'NG')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Add team member to biz_1
    psql(`
      INSERT INTO business_members (business_id, user_id, email, role, status)
      VALUES ('${BIZ_1}', '${TEAM_MEMBER}', 'team@test.local', 'admin', 'active')
      ON CONFLICT DO NOTHING;
    `);

    // Create test chat messages
    psql(`
      INSERT INTO chat_messages (id, business_id, customer_phone, direction, message_text, is_read) VALUES
        ('0a300000-0000-0000-0000-00000ccc0001', '${BIZ_1}', '+234801', 'inbound', 'Hello from customer', false),
        ('0a300000-0000-0000-0000-00000ccc0002', '${BIZ_1}', '+234801', 'inbound', 'Already read', true),
        ('0a300000-0000-0000-0000-00000ccc0003', '${BIZ_2}', '+234802', 'inbound', 'Other business msg', false)
      ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(() => {
    psql(`
      DELETE FROM chat_messages WHERE business_id IN ('${BIZ_1}', '${BIZ_2}');
      DELETE FROM business_members WHERE business_id IN ('${BIZ_1}', '${BIZ_2}');
      DELETE FROM businesses WHERE id IN ('${BIZ_1}', '${BIZ_2}');
      DELETE FROM profiles WHERE id IN ('${OWNER_1}', '${OWNER_2}', '${TEAM_MEMBER}', '${UNRELATED_USER}');
      ALTER TABLE auth.users DISABLE TRIGGER ALL;
      DELETE FROM auth.users WHERE id IN ('${OWNER_1}', '${OWNER_2}', '${TEAM_MEMBER}', '${UNRELATED_USER}');
      ALTER TABLE auth.users ENABLE TRIGGER ALL;
    `);
  });

  it('1. owner can mark messages as read', () => {
    // Reset
    psql(`UPDATE chat_messages SET is_read = false WHERE id = '0a300000-0000-0000-0000-00000ccc0001';`);

    // Simulate owner auth context and update
    const result = psql(`
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_1}';
      SET LOCAL request.jwt.claims = '{"sub": "${OWNER_1}"}';
      UPDATE chat_messages SET is_read = true WHERE id = '0a300000-0000-0000-0000-00000ccc0001' RETURNING id;
    `);
    expect(result).toContain('0a300000-0000-0000-0000-00000ccc0001');

    // Verify
    const isRead = psql(`SELECT is_read FROM chat_messages WHERE id = '0a300000-0000-0000-0000-00000ccc0001';`);
    expect(isRead).toBe('t');
  });

  it('2. authorized team member can mark messages as read', () => {
    // Reset
    psql(`UPDATE chat_messages SET is_read = false WHERE id = '0a300000-0000-0000-0000-00000ccc0001';`);

    // Simulate team member auth context
    const result = psql(`
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${TEAM_MEMBER}';
      SET LOCAL request.jwt.claims = '{"sub": "${TEAM_MEMBER}"}';
      UPDATE chat_messages SET is_read = true WHERE id = '0a300000-0000-0000-0000-00000ccc0001' RETURNING id;
    `);
    expect(result).toContain('0a300000-0000-0000-0000-00000ccc0001');
  });

  it('3. team member cannot update another business messages', () => {
    // Team member is in biz_1, not biz_2
    const result = psql(`
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${TEAM_MEMBER}';
      SET LOCAL request.jwt.claims = '{"sub": "${TEAM_MEMBER}"}';
      UPDATE chat_messages SET is_read = true WHERE id = '0a300000-0000-0000-0000-00000ccc0003' RETURNING id;
    `);
    // Should return empty (0 rows updated)
    expect(result).toBe('');

    // Verify message is still unread
    const isRead = psql(`SELECT is_read FROM chat_messages WHERE id = '0a300000-0000-0000-0000-00000ccc0003';`);
    expect(isRead).toBe('f');
  });

  it('4. unrelated authenticated user cannot update messages', () => {
    psql(`UPDATE chat_messages SET is_read = false WHERE id = '0a300000-0000-0000-0000-00000ccc0001';`);

    const result = psql(`
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${UNRELATED_USER}';
      SET LOCAL request.jwt.claims = '{"sub": "${UNRELATED_USER}"}';
      UPDATE chat_messages SET is_read = true WHERE id = '0a300000-0000-0000-0000-00000ccc0001' RETURNING id;
    `);
    expect(result).toBe('');
  });

  it('5. service role can update messages', () => {
    psql(`UPDATE chat_messages SET is_read = false WHERE id = '0a300000-0000-0000-0000-00000ccc0001';`);

    const result = psql(`
      SET LOCAL ROLE service_role;
      UPDATE chat_messages SET is_read = true WHERE id = '0a300000-0000-0000-0000-00000ccc0001' RETURNING id;
    `);
    expect(result).toContain('0a300000-0000-0000-0000-00000ccc0001');
  });

  it('6. mark-read is idempotent (already-read message)', () => {
    // Message is already read
    const result = psql(`
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_1}';
      SET LOCAL request.jwt.claims = '{"sub": "${OWNER_1}"}';
      UPDATE chat_messages SET is_read = true WHERE id = '0a300000-0000-0000-0000-00000ccc0002' RETURNING id;
    `);
    // Returns the row even though no actual change
    expect(result).toContain('0a300000-0000-0000-0000-00000ccc0002');
  });

  it('7. team member mark-read actually changes is_read state', () => {
    psql(`UPDATE chat_messages SET is_read = false WHERE id = '0a300000-0000-0000-0000-00000ccc0001';`);

    // Before: unread
    const before = psql(`SELECT is_read FROM chat_messages WHERE id = '0a300000-0000-0000-0000-00000ccc0001';`);
    expect(before).toBe('f');

    // Team member marks as read
    psql(`
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${TEAM_MEMBER}';
      SET LOCAL request.jwt.claims = '{"sub": "${TEAM_MEMBER}"}';
      UPDATE chat_messages SET is_read = true WHERE id = '0a300000-0000-0000-0000-00000ccc0001';
    `);

    // After: read
    const after = psql(`SELECT is_read FROM chat_messages WHERE id = '0a300000-0000-0000-0000-00000ccc0001';`);
    expect(after).toBe('t');
  });

  it('8. policy name exists on chat_messages', () => {
    const policies = psql(`
      SELECT policyname FROM pg_policies WHERE tablename = 'chat_messages' AND policyname = 'team_members_update_messages';
    `);
    expect(policies).toBe('team_members_update_messages');
  });
});

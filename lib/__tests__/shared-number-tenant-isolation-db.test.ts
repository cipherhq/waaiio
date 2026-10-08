/**
 * #266 Shared-Number Tenant Isolation — Real PostgreSQL Tests
 *
 * Requires TEST_DATABASE_URL. Tests run against the actual DB with
 * M430 RPCs, CHECK constraint, and backfill behavior.
 *
 *   TEST_DATABASE_URL=postgresql://localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/shared-number-tenant-isolation-db.test.ts
 */
import { execSync, spawn } from 'child_process';
import { describe, it, expect, beforeAll } from 'vitest';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 30000,
  }).trim();
}

function psqlMayFail(sql: string): string {
  try {
    return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 30000,
    }).trim();
  } catch (e: unknown) {
    return (e as { stderr?: string }).stderr || String(e);
  }
}

function psqlAsync(sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('psql', [dbUrl, '-tAXq', '-v', 'ON_ERROR_STOP=1'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr || `exit ${code}`));
      else resolve(stdout.trim());
    });
    child.stdin.write(sql);
    child.stdin.end();
  });
}

// ─── Test setup constants ──────────────────────────────────────────
const OWNER_ID = '00000000-0000-0000-0000-000000000266';
const PHONE = '+2349099990266';

describe('#266 Shared-Number Tenant Isolation DB Tests (Migration 430)', () => {
  if (!canRun) throw new Error('TEST_DATABASE_URL is required for #266 real-PG tests — do not skip');

  beforeAll(() => {
    // Create test owner profile
    psqlMayFail(`
      INSERT INTO profiles (id, first_name, last_name, role)
      VALUES ('${OWNER_ID}', 'Test266', 'Owner', 'restaurant_owner')
      ON CONFLICT (id) DO NOTHING;
    `);
  });

  // ── allocate_shared_channel ────────────────────────────────────

  it('1. same-country allocation succeeds', () => {
    // Create a shared channel + business
    const chId = psql(`
      INSERT INTO whatsapp_channels (phone_number, phone_number_id, country_code, channel_type, is_active, provider)
      VALUES ('test-266-ch1', 'pnid-266-1', 'US', 'shared', true, 'meta_cloud')
      RETURNING id;
    `);
    const bizId = psql(`
      INSERT INTO businesses (owner_id, name, slug, bot_code, category, country_code, wa_method, status, phone)
      VALUES ('${OWNER_ID}', 'T266-Alloc-US', 'test266-alloc-us', 'T266ALLOCUS', 'salon', 'US', 'shared', 'pending', '${PHONE}')
      RETURNING id;
    `);

    const result = psql(`SELECT allocate_shared_channel('${bizId}'::uuid, 'US'::text);`);
    expect(result).toContain('"allocated": true');

    // Verify assignment
    const assigned = psql(`SELECT assigned_channel_id FROM businesses WHERE id = '${bizId}';`);
    expect(assigned).toBe(chId);

    // Cleanup
    psql(`DELETE FROM businesses WHERE id = '${bizId}'; DELETE FROM whatsapp_channels WHERE id = '${chId}';`);
  });

  it('2. cross-country allocation fails closed', () => {
    // Create a US-only channel, try to allocate for NG business
    const chId = psql(`
      INSERT INTO whatsapp_channels (phone_number, phone_number_id, country_code, channel_type, is_active, provider)
      VALUES ('test-266-ch2', 'pnid-266-2', 'US', 'shared', true, 'meta_cloud')
      RETURNING id;
    `);
    const bizId = psql(`
      INSERT INTO businesses (owner_id, name, slug, bot_code, category, country_code, wa_method, status, phone)
      VALUES ('${OWNER_ID}', 'T266-NG', 'test266-ng', 'T266NG', 'salon', 'NG', 'shared', 'pending', '${PHONE}')
      RETURNING id;
    `);

    const result = psql(`SELECT allocate_shared_channel('${bizId}'::uuid, 'NG'::text);`);
    expect(result).toContain('"allocated": false');
    expect(result).toContain('no_shared_channel_for_country');

    // Verify NOT assigned
    const assigned = psql(`SELECT assigned_channel_id IS NULL AS unassigned FROM businesses WHERE id = '${bizId}';`);
    expect(assigned).toBe('t');

    psql(`DELETE FROM businesses WHERE id = '${bizId}'; DELETE FROM whatsapp_channels WHERE id = '${chId}';`);
  });

  it('3. allocation at capacity → fails closed', () => {
    // Set capacity to 1, fill it, try second allocation
    psql(`UPDATE platform_settings SET value = '1'::jsonb WHERE key = 'shared_number_capacity';`);

    const chId = psql(`
      INSERT INTO whatsapp_channels (phone_number, phone_number_id, country_code, channel_type, is_active, provider)
      VALUES ('test-266-ch3', 'pnid-266-3', 'US', 'shared', true, 'meta_cloud')
      RETURNING id;
    `);
    const biz1 = psql(`
      INSERT INTO businesses (owner_id, name, slug, bot_code, category, country_code, wa_method, status, phone, assigned_channel_id)
      VALUES ('${OWNER_ID}', 'T266-Fill', 'test266-fill', 'T266FILL', 'salon', 'US', 'shared', 'active', '${PHONE}', '${chId}')
      RETURNING id;
    `);
    const biz2 = psql(`
      INSERT INTO businesses (owner_id, name, slug, bot_code, category, country_code, wa_method, status, phone)
      VALUES ('${OWNER_ID}', 'T266-Over', 'test266-over', 'T266OVER', 'salon', 'US', 'shared', 'pending', '${PHONE}')
      RETURNING id;
    `);

    const result = psql(`SELECT allocate_shared_channel('${biz2}'::uuid, 'US'::text);`);
    expect(result).toContain('"allocated": false');
    expect(result).toContain('all_channels_at_capacity');

    // Restore capacity
    psql(`UPDATE platform_settings SET value = '50'::jsonb WHERE key = 'shared_number_capacity';`);
    psql(`DELETE FROM businesses WHERE id IN ('${biz1}', '${biz2}'); DELETE FROM whatsapp_channels WHERE id = '${chId}';`);
  });

  it('4. concurrent N-1 capacity race → exactly one wins', async () => {
    psql(`UPDATE platform_settings SET value = '1'::jsonb WHERE key = 'shared_number_capacity';`);

    const chId = psql(`
      INSERT INTO whatsapp_channels (phone_number, phone_number_id, country_code, channel_type, is_active, provider)
      VALUES ('test-266-ch4', 'pnid-266-4', 'US', 'shared', true, 'meta_cloud')
      RETURNING id;
    `);
    const biz1 = psql(`
      INSERT INTO businesses (owner_id, name, slug, bot_code, category, country_code, wa_method, status, phone)
      VALUES ('${OWNER_ID}', 'T266-Race1', 'test266-race1', 'T266RACE1', 'salon', 'US', 'shared', 'pending', '${PHONE}')
      RETURNING id;
    `);
    const biz2 = psql(`
      INSERT INTO businesses (owner_id, name, slug, bot_code, category, country_code, wa_method, status, phone)
      VALUES ('${OWNER_ID}', 'T266-Race2', 'test266-race2', 'T266RACE2', 'salon', 'US', 'shared', 'pending', '${PHONE}')
      RETURNING id;
    `);

    // Two concurrent allocations
    const [r1, r2] = await Promise.all([
      psqlAsync(`SELECT allocate_shared_channel('${biz1}'::uuid, 'US'::text);`),
      psqlAsync(`SELECT allocate_shared_channel('${biz2}'::uuid, 'US'::text);`),
    ]);

    const allocated = [r1, r2].filter(r => r.includes('"allocated": true')).length;
    const denied = [r1, r2].filter(r => r.includes('"allocated": false')).length;
    expect(allocated).toBe(1);
    expect(denied).toBe(1);

    // Count never exceeds capacity
    const count = psql(`SELECT count(*) FROM businesses WHERE assigned_channel_id = '${chId}';`);
    expect(parseInt(count)).toBeLessThanOrEqual(1);

    psql(`UPDATE platform_settings SET value = '50'::jsonb WHERE key = 'shared_number_capacity';`);
    psql(`DELETE FROM businesses WHERE id IN ('${biz1}', '${biz2}'); DELETE FROM whatsapp_channels WHERE id = '${chId}';`);
  });

  it('5. idempotent allocation (already assigned)', () => {
    const chId = psql(`
      INSERT INTO whatsapp_channels (phone_number, phone_number_id, country_code, channel_type, is_active, provider)
      VALUES ('test-266-ch5', 'pnid-266-5', 'US', 'shared', true, 'meta_cloud')
      RETURNING id;
    `);
    const bizId = psql(`
      INSERT INTO businesses (owner_id, name, slug, bot_code, category, country_code, wa_method, status, phone, assigned_channel_id)
      VALUES ('${OWNER_ID}', 'T266-Idemp', 'test266-idemp', 'T266IDEMP', 'salon', 'US', 'shared', 'active', '${PHONE}', '${chId}')
      RETURNING id;
    `);

    const result = psql(`SELECT allocate_shared_channel('${bizId}'::uuid, 'US'::text);`);
    expect(result).toContain('"allocated": true');
    expect(result).toContain('"idempotent": true');

    psql(`DELETE FROM businesses WHERE id = '${bizId}'; DELETE FROM whatsapp_channels WHERE id = '${chId}';`);
  });

  // ── CHECK constraint ──────────────────────────────────────────

  it('6. CHECK rejects active + shared + unassigned', () => {
    const err = psqlMayFail(`
      INSERT INTO businesses (owner_id, name, slug, bot_code, category, country_code, wa_method, status, phone)
      VALUES ('${OWNER_ID}', 'T266-CHK', 'test266-chk', 'T266CHK', 'salon', 'US', 'shared', 'active', '${PHONE}');
    `);
    expect(err).toContain('chk_shared_requires_channel');
  });

  it('7. CHECK allows pending + shared + unassigned', () => {
    const bizId = psql(`
      INSERT INTO businesses (owner_id, name, slug, bot_code, category, country_code, wa_method, status, phone)
      VALUES ('${OWNER_ID}', 'T266-Pend', 'test266-pend', 'T266PEND', 'salon', 'US', 'shared', 'pending', '${PHONE}')
      RETURNING id;
    `);
    expect(bizId).toBeTruthy();
    psql(`DELETE FROM businesses WHERE id = '${bizId}';`);
  });

  // ── transition_to_shared ──────────────────────────────────────

  it('8. dedicated→shared failure preserves dedicated state', () => {
    // No shared channel for NG → transition fails → dedicated preserved
    const chId = psql(`
      INSERT INTO whatsapp_channels (phone_number, phone_number_id, country_code, channel_type, is_active, provider, business_id)
      VALUES ('test-266-ded', 'pnid-266-ded', 'NG', 'dedicated', true, 'meta_cloud', null)
      RETURNING id;
    `);
    const bizId = psql(`
      INSERT INTO businesses (owner_id, name, slug, bot_code, category, country_code, wa_method, status, phone, assigned_channel_id, whatsapp_channel_id)
      VALUES ('${OWNER_ID}', 'T266-Ded', 'test266-ded', 'T266DED', 'salon', 'NG', 'transfer', 'active', '${PHONE}', '${chId}', '${chId}')
      RETURNING id;
    `);
    // Update channel to reference business
    psql(`UPDATE whatsapp_channels SET business_id = '${bizId}' WHERE id = '${chId}';`);

    const result = psql(`SELECT transition_to_shared('${bizId}'::uuid);`);
    expect(result).toContain('"transitioned": false');

    // Verify dedicated state preserved
    const state = psql(`SELECT wa_method, assigned_channel_id = '${chId}' AS ch_intact FROM businesses WHERE id = '${bizId}';`);
    expect(state).toContain('transfer');
    expect(state).toContain('t'); // channel intact

    // Dedicated channel still active
    const chActive = psql(`SELECT is_active FROM whatsapp_channels WHERE id = '${chId}';`);
    expect(chActive).toBe('t');

    psql(`DELETE FROM businesses WHERE id = '${bizId}'; DELETE FROM whatsapp_channels WHERE id = '${chId}';`);
  });

  // ── ACL tests ─────────────────────────────────────────────────

  it('9. allocate_shared_channel: anon cannot execute', () => {
    const result = psql(`SELECT has_function_privilege('anon', 'allocate_shared_channel(uuid,text)', 'EXECUTE');`);
    expect(result).toBe('f');
  });

  it('10. transition_to_shared: anon cannot execute', () => {
    const result = psql(`SELECT has_function_privilege('anon', 'transition_to_shared(uuid)', 'EXECUTE');`);
    expect(result).toBe('f');
  });

  it('11. reassign_shared_channel: anon cannot execute', () => {
    const result = psql(`SELECT has_function_privilege('anon', 'reassign_shared_channel(uuid,uuid)', 'EXECUTE');`);
    expect(result).toBe('f');
  });

  it('12. allocate_shared_channel: authenticated cannot execute', () => {
    const result = psql(`SELECT has_function_privilege('authenticated', 'allocate_shared_channel(uuid,text)', 'EXECUTE');`);
    expect(result).toBe('f');
  });

  it('13. get_bot_context: service_role can execute', () => {
    const result = psql(`SELECT has_function_privilege('service_role', 'get_bot_context(text,uuid)', 'EXECUTE');`);
    expect(result).toBe('t');
  });

  it('14. get_bot_context: anon cannot execute', () => {
    const result = psql(`SELECT has_function_privilege('anon', 'get_bot_context(text,uuid)', 'EXECUTE');`);
    expect(result).toBe('f');
  });

  // ── get_bot_context ambiguity ─────────────────────────────────

  it('15. get_bot_context(NULL) with multiple sessions → ambiguous', () => {
    const biz1 = psql(`
      INSERT INTO businesses (owner_id, name, slug, bot_code, category, country_code, wa_method, status, phone)
      VALUES ('${OWNER_ID}', 'T266-Amb1', 'test266-amb1', 'T266AMB1', 'salon', 'US', 'shared', 'pending', '${PHONE}')
      RETURNING id;
    `);
    const biz2 = psql(`
      INSERT INTO businesses (owner_id, name, slug, bot_code, category, country_code, wa_method, status, phone)
      VALUES ('${OWNER_ID}', 'T266-Amb2', 'test266-amb2', 'T266AMB2', 'salon', 'US', 'shared', 'pending', '${PHONE}')
      RETURNING id;
    `);
    // Create two active sessions with different businesses
    psql(`
      INSERT INTO bot_sessions (whatsapp_number, business_id, current_step, is_active, expires_at)
      VALUES ('+266test1', '${biz1}', 'greeting', true, NOW() + interval '1 hour');
      INSERT INTO bot_sessions (whatsapp_number, business_id, current_step, is_active, expires_at)
      VALUES ('+266test1', '${biz2}', 'greeting', true, NOW() + interval '1 hour');
    `);

    const result = psql(`SELECT get_bot_context('+266test1'::text, NULL::uuid);`);
    expect(result).toContain('"ambiguous": true');
    expect(result).toContain('"has_session": true');

    // Cleanup
    psql(`DELETE FROM bot_sessions WHERE whatsapp_number = '+266test1';`);
    psql(`DELETE FROM businesses WHERE id IN ('${biz1}', '${biz2}');`);
  });

  it('16. get_bot_context(NULL) with single session → not ambiguous', () => {
    const bizId = psql(`
      INSERT INTO businesses (owner_id, name, slug, bot_code, category, country_code, wa_method, status, phone)
      VALUES ('${OWNER_ID}', 'T266-Single', 'test266-single', 'T266SINGLE', 'salon', 'US', 'shared', 'pending', '${PHONE}')
      RETURNING id;
    `);
    psql(`
      INSERT INTO bot_sessions (whatsapp_number, business_id, current_step, is_active, expires_at)
      VALUES ('+266test2', '${bizId}', 'greeting', true, NOW() + interval '1 hour');
    `);

    const result = psql(`SELECT get_bot_context('+266test2'::text, NULL::uuid);`);
    expect(result).toContain('"ambiguous": false');
    expect(result).toContain('"has_session": true');

    psql(`DELETE FROM bot_sessions WHERE whatsapp_number = '+266test2';`);
    psql(`DELETE FROM businesses WHERE id = '${bizId}';`);
  });

  // ── reassign_shared_channel ───────────────────────────────────

  it('17. reassignment failure preserves old assignment', () => {
    psql(`UPDATE platform_settings SET value = '1'::jsonb WHERE key = 'shared_number_capacity';`);

    const ch1 = psql(`INSERT INTO whatsapp_channels (phone_number, phone_number_id, country_code, channel_type, is_active, provider) VALUES ('test-266-r1', 'pnid-266-r1', 'US', 'shared', true, 'meta_cloud') RETURNING id;`);
    const ch2 = psql(`INSERT INTO whatsapp_channels (phone_number, phone_number_id, country_code, channel_type, is_active, provider) VALUES ('test-266-r2', 'pnid-266-r2', 'US', 'shared', true, 'meta_cloud') RETURNING id;`);

    // Fill ch2 to capacity
    const filler = psql(`INSERT INTO businesses (owner_id, name, slug, bot_code, category, country_code, wa_method, status, phone, assigned_channel_id) VALUES ('${OWNER_ID}', 'T266-Filler', 'test266-filler', 'T266FILLER', 'salon', 'US', 'shared', 'active', '${PHONE}', '${ch2}') RETURNING id;`);

    // Business on ch1
    const bizId = psql(`INSERT INTO businesses (owner_id, name, slug, bot_code, category, country_code, wa_method, status, phone, assigned_channel_id) VALUES ('${OWNER_ID}', 'T266-Reassign', 'test266-reassign', 'T266REASSIGN', 'salon', 'US', 'shared', 'active', '${PHONE}', '${ch1}') RETURNING id;`);

    // Try reassign to full ch2
    const result = psql(`SELECT reassign_shared_channel('${bizId}'::uuid, '${ch2}'::uuid);`);
    expect(result).toContain('"reassigned": false');
    expect(result).toContain('target_at_capacity');

    // Old assignment preserved
    const assigned = psql(`SELECT assigned_channel_id FROM businesses WHERE id = '${bizId}';`);
    expect(assigned).toBe(ch1);

    psql(`UPDATE platform_settings SET value = '50'::jsonb WHERE key = 'shared_number_capacity';`);
    psql(`DELETE FROM businesses WHERE id IN ('${bizId}', '${filler}'); DELETE FROM whatsapp_channels WHERE id IN ('${ch1}', '${ch2}');`);
  });
});

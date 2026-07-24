/**
 * Platform administrator provisioning.
 *
 * Grants or revokes platform admin status through the Supabase Auth
 * administrative API (app_metadata.role).
 *
 * Identity resolution uses ONLY Supabase Auth — never public.profiles.
 *
 * Requires: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage:
 *   npx tsx scripts/admin-provision.ts grant <auth-user-uuid> admin
 *   npx tsx scripts/admin-provision.ts grant <auth-email> admin
 *   npx tsx scripts/admin-provision.ts revoke <auth-user-uuid>
 *   npx tsx scripts/admin-provision.ts list
 *
 * Production procedure:
 *   1. Obtain the admin's Auth user UUID from the Supabase Auth dashboard
 *   2. Independently confirm their verified Auth email
 *   3. Run: npx tsx scripts/admin-provision.ts grant <UUID> admin
 *   4. Verify: npx tsx scripts/admin-provision.ts list
 *   5. Record UUID, email, role, operator, timestamp
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const VALID_ROLES = ['admin', 'support', 'finance', 'operations'] as const;
export type AdminRole = typeof VALID_ROLES[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

/**
 * Resolve an Auth user by UUID or email.
 * Uses ONLY Supabase Auth admin APIs — never public.profiles.
 */
export async function resolveAuthUser(
  supabase: SupabaseClient,
  identifier: string,
): Promise<{ id: string; email: string }> {
  // UUID path
  if (UUID_RE.test(identifier)) {
    const { data, error } = await supabase.auth.admin.getUserById(identifier);
    if (error) throw new Error(`Auth lookup failed for UUID ${identifier}: ${error.message}`);
    if (!data?.user) throw new Error(`No Auth user found for UUID: ${identifier}`);
    return { id: data.user.id, email: data.user.email || '' };
  }

  // Email path — search Auth users, never public.profiles
  const normalizedEmail = identifier.toLowerCase().trim();
  const matches: Array<{ id: string; email: string }> = [];

  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw new Error(`Auth listUsers failed: ${error.message}`);
    for (const user of data.users) {
      if (user.email?.toLowerCase() === normalizedEmail) {
        matches.push({ id: user.id, email: user.email });
      }
    }
    if (data.users.length < 100) break;
    page++;
  }

  if (matches.length === 0) throw new Error(`No Auth user found with email: ${normalizedEmail}`);
  if (matches.length > 1) throw new Error(`Multiple Auth users (${matches.length}) match email: ${normalizedEmail}. Use UUID instead.`);

  // Re-fetch by ID to confirm
  const { data: confirmed, error: confirmErr } = await supabase.auth.admin.getUserById(matches[0].id);
  if (confirmErr || !confirmed?.user) throw new Error(`Failed to confirm Auth user ${matches[0].id}`);

  return { id: confirmed.user.id, email: confirmed.user.email || '' };
}

/**
 * Grant a platform role.
 * Preserves all unrelated app_metadata keys.
 */
export async function grantPlatformRole(
  supabase: SupabaseClient,
  userId: string,
  role: AdminRole,
): Promise<{ id: string; email: string; role: AdminRole; preservedKeys: string[] }> {
  if (!VALID_ROLES.includes(role)) throw new Error(`Invalid role: ${role}. Valid: ${VALID_ROLES.join(', ')}`);

  // Fetch current user
  const { data: before, error: fetchErr } = await supabase.auth.admin.getUserById(userId);
  if (fetchErr) throw new Error(`Failed to fetch user ${userId}: ${fetchErr.message}`);
  if (!before?.user) throw new Error(`No Auth user found: ${userId}`);

  // Clone and merge metadata
  const beforeMeta = { ...(before.user.app_metadata || {}) };
  const mergedMeta = { ...beforeMeta, role };

  // Update
  const { data: after, error: updateErr } = await supabase.auth.admin.updateUserById(userId, {
    app_metadata: mergedMeta,
  });
  if (updateErr) throw new Error(`Failed to update user ${userId}: ${updateErr.message}`);
  if (!after?.user) throw new Error(`Update returned no user for ${userId}`);

  // Verify role persisted
  const afterMeta = after.user.app_metadata || {};
  if (afterMeta.role !== role) {
    throw new Error(`Verification failed: expected role=${role}, got ${afterMeta.role}`);
  }

  // Verify unrelated keys preserved
  const preservedKeys = Object.keys(beforeMeta).filter(k => k !== 'role');
  for (const key of preservedKeys) {
    if (JSON.stringify(afterMeta[key]) !== JSON.stringify(beforeMeta[key])) {
      throw new Error(`Metadata key '${key}' was lost or changed during grant`);
    }
  }

  return { id: userId, email: after.user.email || '', role, preservedKeys };
}

/**
 * Revoke a platform role.
 * Removes only the role key, preserves everything else.
 */
export async function revokePlatformRole(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ id: string; email: string; preservedKeys: string[] }> {
  // Fetch current user
  const { data: before, error: fetchErr } = await supabase.auth.admin.getUserById(userId);
  if (fetchErr) throw new Error(`Failed to fetch user ${userId}: ${fetchErr.message}`);
  if (!before?.user) throw new Error(`No Auth user found: ${userId}`);

  // Clone without mutating — remove only role
  const beforeMeta = { ...(before.user.app_metadata || {}) };
  const { role: _removed, ...preservedMeta } = beforeMeta;

  // Update
  const { data: after, error: updateErr } = await supabase.auth.admin.updateUserById(userId, {
    app_metadata: preservedMeta,
  });
  if (updateErr) throw new Error(`Failed to update user ${userId}: ${updateErr.message}`);
  if (!after?.user) throw new Error(`Update returned no user for ${userId}`);

  // Verify role is absent
  const afterMeta = after.user.app_metadata || {};
  if (afterMeta.role) {
    throw new Error(`Verification failed: role still present: ${afterMeta.role}`);
  }

  // Verify unrelated keys preserved
  const preservedKeys = Object.keys(preservedMeta);
  for (const key of preservedKeys) {
    if (JSON.stringify(afterMeta[key]) !== JSON.stringify(preservedMeta[key])) {
      throw new Error(`Metadata key '${key}' was lost during revoke`);
    }
  }

  return { id: userId, email: after.user.email || '', preservedKeys };
}

/**
 * List all platform administrators.
 */
export async function listPlatformAdmins(
  supabase: SupabaseClient,
): Promise<Array<{ id: string; email: string; role: string }>> {
  const admins: Array<{ id: string; email: string; role: string }> = [];
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    for (const user of data.users) {
      const role = user.app_metadata?.role;
      if (role && VALID_ROLES.includes(role as AdminRole)) {
        admins.push({ id: user.id, email: user.email || '', role });
      }
    }
    if (data.users.length < 100) break;
    page++;
  }
  return admins;
}

// ── CLI entry point (only when executed directly) ──

async function main() {
  const supabase = getClient();
  const [, , action, target, roleArg] = process.argv;

  if (action === 'list') {
    const admins = await listPlatformAdmins(supabase);
    console.log('Platform administrators (from app_metadata.role):');
    for (const a of admins) console.log(`  ${a.email || '(no email)'} — ${a.role} — ${a.id}`);
    if (admins.length === 0) console.log('  (none found)');
    console.log(`\nTotal: ${admins.length}`);
  } else if (action === 'grant') {
    if (!target) { console.error('Usage: grant <uuid-or-email> [role]'); process.exit(1); }
    const role = (roleArg || 'admin') as AdminRole;
    const user = await resolveAuthUser(supabase, target);
    const result = await grantPlatformRole(supabase, user.id, role);
    console.log(`✅ Granted ${result.role} to ${result.email} (${result.id})`);
    if (result.preservedKeys.length > 0) console.log(`   Preserved: ${result.preservedKeys.join(', ')}`);
  } else if (action === 'revoke') {
    if (!target) { console.error('Usage: revoke <uuid-or-email>'); process.exit(1); }
    const user = await resolveAuthUser(supabase, target);
    const result = await revokePlatformRole(supabase, user.id);
    console.log(`✅ Revoked from ${result.email} (${result.id})`);
    if (result.preservedKeys.length > 0) console.log(`   Preserved: ${result.preservedKeys.join(', ')}`);
  } else {
    console.error('Usage: npx tsx scripts/admin-provision.ts <grant|revoke|list> [uuid-or-email] [role]');
    process.exit(1);
  }
}

// Run only when executed as CLI, not when imported for tests
const isDirectExecution = process.argv[1]?.endsWith('admin-provision.ts') || process.argv[1]?.endsWith('admin-provision');
if (isDirectExecution) {
  main().catch(err => { console.error('Error:', err.message); process.exit(1); });
}

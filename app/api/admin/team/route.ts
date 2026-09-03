/**
 * Platform admin team management API (#217)
 *
 * Server-authoritative role provisioning via Supabase Auth Admin API.
 * Canonical authority: auth.users.raw_app_meta_data.role
 *
 * Reuses the proven helpers from scripts/admin-provision.ts.
 * Never writes profiles.role for platform-role purposes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import {
  resolveAuthUser,
  grantPlatformRole,
  revokePlatformRole,
  listPlatformAdmins,
  type AdminRole,
} from '@/scripts/admin-provision';

const VALID_ROLES: readonly string[] = ['admin', 'support', 'finance', 'operations'];

/**
 * GET /api/admin/team — List platform administrators
 * Role display comes from Auth app_metadata, never profiles.role.
 * Profile name/phone are non-authoritative display enrichment only.
 */
export async function GET(request: NextRequest) {
  const admin = await requirePlatformAdmin(request, { requiredRole: ['admin', 'support'] });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  try {
    const supabase = createServiceClient();
    const admins = await listPlatformAdmins(supabase);

    // Enrich with profile display data (non-authoritative)
    if (admins.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, first_name, last_name, phone')
        .in('id', admins.map(a => a.id));

      const profileMap = new Map((profiles || []).map(p => [p.id, p]));
      return NextResponse.json({
        team: admins.map(a => {
          const profile = profileMap.get(a.id);
          return {
            id: a.id,
            email: a.email,
            role: a.role,
            firstName: profile?.first_name || null,
            lastName: profile?.last_name || null,
            phone: profile?.phone || null,
          };
        }),
      });
    }

    return NextResponse.json({ team: admins });
  } catch (err) {
    console.error('[ADMIN_TEAM] List error:', err);
    return NextResponse.json({ error: 'Failed to list team' }, { status: 500 });
  }
}

/**
 * POST /api/admin/team — Grant a platform role
 * Body: { identifier: string (UUID or email), role: string }
 */
export async function POST(request: NextRequest) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  try {
    const body = await request.json();
    const { identifier, role } = body as { identifier?: string; role?: string };

    if (!identifier?.trim()) {
      return NextResponse.json({ error: 'identifier is required (UUID or email)' }, { status: 400 });
    }
    if (!role || !VALID_ROLES.includes(role)) {
      return NextResponse.json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Resolve the target Auth user (fails closed if not found)
    let targetUser: { id: string; email: string };
    try {
      targetUser = await resolveAuthUser(supabase, identifier.trim());
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      if (/no .* user found/i.test(reason)) {
        return NextResponse.json({
          error: 'AUTH_USER_REQUIRED',
          message: 'No Waaiio account found for this identifier. The user must first create a Waaiio account before they can be assigned a platform role.',
        }, { status: 404 });
      }
      throw err;
    }

    // Reject self role-change
    if (targetUser.id === admin.userId) {
      return NextResponse.json({ error: 'Cannot change your own platform role' }, { status: 400 });
    }

    // Grant the role (preserves unrelated app_metadata keys)
    const result = await grantPlatformRole(supabase, targetUser.id, role as AdminRole);

    // Server-side audit
    await supabase.from('admin_audit_logs').insert({
      actor_id: admin.userId,
      action: 'grant_platform_role',
      entity_type: 'platform_team',
      entity_id: targetUser.id,
      details: { target_email: targetUser.email, role, preserved_keys: result.preservedKeys },
    }).then(() => {}, err => console.error('[ADMIN_TEAM] Audit insert failed:', err));

    return NextResponse.json({
      success: true,
      user: { id: result.id, email: result.email, role: result.role },
    });
  } catch (err) {
    console.error('[ADMIN_TEAM] Grant error:', err);
    return NextResponse.json({ error: 'Failed to grant role' }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/team — Revoke a platform role
 * Body: { identifier: string (UUID or email) }
 */
export async function DELETE(request: NextRequest) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  try {
    const body = await request.json();
    const { identifier } = body as { identifier?: string };

    if (!identifier?.trim()) {
      return NextResponse.json({ error: 'identifier is required (UUID or email)' }, { status: 400 });
    }

    const supabase = createServiceClient();

    let targetUser: { id: string; email: string };
    try {
      targetUser = await resolveAuthUser(supabase, identifier.trim());
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      if (/no .* user found/i.test(reason)) {
        return NextResponse.json({
          error: 'AUTH_USER_REQUIRED',
          message: 'No Waaiio account found for this identifier.',
        }, { status: 404 });
      }
      throw err;
    }

    // Reject self-demotion
    if (targetUser.id === admin.userId) {
      return NextResponse.json({ error: 'Cannot revoke your own platform role' }, { status: 400 });
    }

    // Revoke: removes only the role key, preserves other metadata
    const result = await revokePlatformRole(supabase, targetUser.id);

    // Server-side audit
    await supabase.from('admin_audit_logs').insert({
      actor_id: admin.userId,
      action: 'revoke_platform_role',
      entity_type: 'platform_team',
      entity_id: targetUser.id,
      details: { target_email: targetUser.email, preserved_keys: result.preservedKeys },
    }).then(() => {}, err => console.error('[ADMIN_TEAM] Audit insert failed:', err));

    return NextResponse.json({
      success: true,
      user: { id: result.id, email: result.email },
    });
  } catch (err) {
    console.error('[ADMIN_TEAM] Revoke error:', err);
    return NextResponse.json({ error: 'Failed to revoke role' }, { status: 500 });
  }
}

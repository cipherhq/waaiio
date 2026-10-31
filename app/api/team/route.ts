import { findAuthUser } from '@/lib/onboarding/auth-user';
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { TEAM_LIMITS, type BusinessRole } from '@/lib/permissions';
import { randomBytes } from 'crypto';
import { logger } from '@/lib/logger';
import { WORDMARK_PATH, WORDMARK_ALT, WORDMARK_DISPLAY } from '@/lib/brand';

// GET /api/team — list team members for a business
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const businessId = request.nextUrl.searchParams.get('business_id');
  if (!businessId) return NextResponse.json({ error: 'Missing business_id' }, { status: 400 });

  // Verify user is owner or active member
  const service = createServiceClient();
  const { data: biz } = await service.from('businesses').select('id, owner_id, subscription_tier').eq('id', businessId).single();
  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

  const isOwner = biz.owner_id === user.id;
  if (!isOwner) {
    const { data: membership } = await service.from('business_members')
      .select('role').eq('business_id', businessId).eq('user_id', user.id).eq('status', 'active').maybeSingle();
    if (!membership || !['admin', 'manager'].includes(membership.role)) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }
  }

  const { data: members } = await service
    .from('business_members')
    .select('id, email, role, status, invited_at, joined_at, user_id')
    .eq('business_id', businessId)
    .order('created_at', { ascending: true });

  // Get owner info
  const { data: ownerProfile } = await service
    .from('profiles')
    .select('email, first_name, last_name')
    .eq('id', biz.owner_id)
    .single();

  return NextResponse.json({
    members: [
      {
        id: 'owner',
        email: ownerProfile?.email || '',
        name: ownerProfile ? `${ownerProfile.first_name || ''} ${ownerProfile.last_name || ''}`.trim() : '',
        role: 'owner' as BusinessRole,
        status: 'active',
        isOwner: true,
      },
      ...(members || []).map(m => ({
        ...m,
        isOwner: false,
      })),
    ],
    limit: TEAM_LIMITS[biz.subscription_tier || 'free'] || 1,
  });
}

// POST /api/team — invite a new team member
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { business_id, email: rawEmail, role } = await request.json() as {
    business_id: string;
    email: string;
    role: BusinessRole;
  };

  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
  if (!business_id || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !role) {
    return NextResponse.json({ error: 'Missing business_id, email, or role' }, { status: 400 });
  }

  if (!['admin', 'manager', 'staff', 'finance', 'support'].includes(role)) {
    return NextResponse.json({ error: 'Cannot invite as owner' }, { status: 400 });
  }

  const service = createServiceClient();

  // Verify requester is owner or admin
  const { data: biz } = await service.from('businesses')
    .select('id, owner_id, name, subscription_tier')
    .eq('id', business_id).single();
  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

  const isOwner = biz.owner_id === user.id;
  if (!isOwner) {
    const { data: m } = await service.from('business_members')
      .select('role').eq('business_id', business_id).eq('user_id', user.id).eq('status', 'active').maybeSingle();
    if (!m || m.role !== 'admin') {
      return NextResponse.json({ error: 'Only owners and admins can invite members' }, { status: 403 });
    }
  }

  const { data: existing, error: lookupError } = await service.from('business_members')
    .select('id, status').eq('business_id', business_id).eq('email', email).maybeSingle();
  if (lookupError) return NextResponse.json({ error: 'Could not check membership' }, { status: 500 });
  if (existing?.status === 'active') return NextResponse.json({ error: 'This person is already a team member' }, { status: 400 });

  const tier = biz.subscription_tier || 'free';
  const limit = TEAM_LIMITS[tier] || 1;
  const { count, error: countError } = await service.from('business_members')
    .select('id', { count: 'exact', head: true }).eq('business_id', business_id).in('status', ['invited', 'active']);
  if (countError) return NextResponse.json({ error: 'Could not check team limit' }, { status: 500 });
  if (existing?.status !== 'invited' && (count || 0) + 1 >= limit) {
    return NextResponse.json({ error: `Team limit reached (${limit} members on ${tier} plan). Upgrade for more.` }, { status: 403 });
  }
  const inviteToken = randomBytes(32).toString('hex');
  const member = { business_id, email, role, status: 'invited', invite_token: inviteToken,
    invited_by: user.id, invited_at: new Date().toISOString() };
  const write = existing
    ? service.from('business_members').update(member).eq('id', existing.id).eq('business_id', business_id).neq('status', 'active')
    : service.from('business_members').insert(member);
  const { data: saved, error: insertError } = await write.select('id').maybeSingle();
  if (insertError || !saved) return NextResponse.json({ error: 'Failed to save invitation. Please retry.' }, { status: 409 });

  // Send invite email
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
  let inviteUrl = `${appUrl}/invite/${inviteToken}`;
  try {
    const authUser = await findAuthUser(service, email);
    if (!authUser || !authUser.email_confirmed_at) {
      // Recover an unconfirmed invite identity left by a failed/expired email.
      // Established accounts keep their password and use normal sign-in.
      const linkType = authUser ? 'recovery' : 'invite';
      const { data: link, error: linkError } = await service.auth.admin.generateLink({
        type: linkType, email,
      });
      if (linkError || !link?.properties?.hashed_token) throw new Error('Unable to prepare account invitation');
      const callback = new URL('/auth/callback', appUrl);
      callback.searchParams.set('token_hash', link.properties.hashed_token);
      callback.searchParams.set('type', linkType);
      callback.searchParams.set('next', `/invite/${inviteToken}?setup=1`);
      inviteUrl = callback.toString();
    }
  } catch {
    return NextResponse.json({ error: 'Invitation saved, but account setup could not be prepared. Please send the invitation again.' }, { status: 502 });
  }

  try {
    const delivery = await sendEmail({
      to: email,
      subject: `You're invited to join ${biz.name} on Waaiio`,
      html: `
        <div style="max-width:480px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#1a1a1a">
          <div style="text-align:center;padding:32px 0 24px"><img src="${appUrl}${WORDMARK_PATH}" alt="${WORDMARK_ALT}" height="${WORDMARK_DISPLAY.standard.height}"/></div>
          <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px">
            <h1 style="font-size:20px;font-weight:700;margin:0 0 8px">You're invited!</h1>
            <p style="font-size:14px;color:#6b7280;margin:0 0 24px;line-height:1.5">
              <strong>${String(biz.name).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))}</strong> has invited you to join their team on Waaiio as <strong>${role}</strong>.
            </p>
            <div style="text-align:center;margin:24px 0">
              <a href="${inviteUrl}" style="display:inline-block;background:#7c3aed;color:#fff;font-size:14px;font-weight:600;text-decoration:none;padding:12px 32px;border-radius:8px">Accept Invitation</a>
            </div>
            <p style="font-size:12px;color:#9ca3af;margin:24px 0 0;line-height:1.5">This team invitation expires in 7 days. The secure account setup link may expire sooner; ask the owner to resend if needed.</p>
          </div>
          <div style="text-align:center;padding:24px 0"><p style="font-size:11px;color:#9ca3af;margin:0">Waaiio — WhatsApp Automation for Every Business</p></div>
        </div>
      `,
    });
    if (!delivery.success) throw new Error('Email delivery failed');
  } catch (emailErr) {
    logger.error('[TEAM] Invite email error:', emailErr);
    return NextResponse.json({ error: 'Invitation saved but email delivery failed. Please send the invitation again.' }, { status: 502 });
  }

  return NextResponse.json({ success: true, message: `Invitation sent to ${email}` }, { status: 201 });
}

// DELETE /api/team — remove a team member
export async function DELETE(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const memberId = request.nextUrl.searchParams.get('member_id');
  const businessId = request.nextUrl.searchParams.get('business_id');
  if (!memberId || !businessId) return NextResponse.json({ error: 'Missing params' }, { status: 400 });

  const service = createServiceClient();
  const { data: biz } = await service.from('businesses').select('owner_id').eq('id', businessId).single();
  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

  // Only owner/admin can remove
  const isOwner = biz.owner_id === user.id;
  if (!isOwner) {
    const { data: m } = await service.from('business_members')
      .select('role').eq('business_id', businessId).eq('user_id', user.id).eq('status', 'active').maybeSingle();
    if (!m || m.role !== 'admin') {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }
  }

  await service.from('business_members').delete().eq('id', memberId).eq('business_id', businessId);
  return NextResponse.json({ success: true });
}

// PATCH /api/team — update member role
export async function PATCH(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { member_id, business_id, role } = await request.json();
  if (!['admin', 'manager', 'staff', 'finance', 'support'].includes(role)) return NextResponse.json({ error: 'Invalid team role' }, { status: 400 });
  if (!member_id || !business_id || !role) return NextResponse.json({ error: 'Missing params' }, { status: 400 });

  const service = createServiceClient();
  const { data: biz } = await service.from('businesses').select('owner_id').eq('id', business_id).single();
  if (!biz || biz.owner_id !== user.id) return NextResponse.json({ error: 'Only owner can change roles' }, { status: 403 });

  const { data: updated, error: updateError } = await service.from('business_members').update({ role, updated_at: new Date().toISOString() }).eq('id', member_id).eq('business_id', business_id).select('id').maybeSingle();
  if (updateError || !updated) return NextResponse.json({ error: 'Role could not be updated' }, { status: 409 });
  return NextResponse.json({ success: true });
}

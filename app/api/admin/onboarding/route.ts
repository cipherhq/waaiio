import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync } from '@/lib/rate-limit';
import { sendEmail } from '@/lib/email/client';
import { provisionAdminBusiness, validateAdminOnboardingInput, type AdminOnboardingInput } from '@/lib/onboarding/admin-assisted';
import { OnboardingProvisionError } from '@/lib/onboarding/provision-business';
import { authUserExists } from '@/lib/onboarding/auth-user';
import { logAdminAudit } from '@/lib/admin-audit';
import { buildVerifiedWhatsAppLink, isAssignedWhatsAppChannelReady } from '@/lib/onboarding/whatsapp-readiness';

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

export async function GET(request: NextRequest) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: request.headers.get('authorization') ? 'Forbidden' : 'Unauthorized' }, { status: request.headers.get('authorization') ? 403 : 401 });
  const service = createServiceClient({ noStore: true });

  // Actionable-first queue with deterministic pagination.
  // PostgREST caps results at max-rows (typically 1000). We paginate
  // actionable records so none are silently dropped. Terminal records
  // are bounded to 100 for performance.
  const PAGE_SIZE = 1000;
  const actionableRows: Array<Record<string, unknown>> = [];
  let actionableError: { message: string } | null = null;
  for (let page = 0; ; page++) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await service.from('admin_onboarding_invites').select('*')
      .not('status', 'in', '("active","cancelled","completed")')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to);
    if (error) { actionableError = error; break; }
    if (data) actionableRows.push(...data);
    if (!data || data.length < PAGE_SIZE) break; // last page
  }

  const [terminalResult, countriesResult, categoriesResult] = await Promise.all([
    service.from('admin_onboarding_invites').select('*')
      .in('status', ['active', 'cancelled', 'completed'])
      .order('created_at', { ascending: false })
      .limit(100),
    service.from('countries').select('code, name, dialing_code').eq('is_active', true).order('sort_order'),
    service.from('category_templates').select('key, name').eq('is_active', true).order('name'),
  ]);
  if (actionableError || terminalResult.error || countriesResult.error || categoriesResult.error) {
    return NextResponse.json({ error: 'Unable to load onboarding queue and authority options' }, { status: 500 });
  }

  // Read-only connection readiness. Never expose WhatsApp access tokens or assume
  // country availability implies an allocated, active shared channel.
  const queued = [...actionableRows, ...(terminalResult.data || [])];
  const businessIds = [...new Set(queued.map(row => row.business_id).filter((id): id is string => typeof id === 'string' && !!id))];
  let businesses: Array<{ id: string; status: string; wa_method: string | null; assigned_channel_id: string | null; whatsapp_channel_id: string | null; bot_code: string | null; country_code: string | null; messaging_suspended: boolean | null }> = [];
  let channels: Array<{ id: string; channel_type: string | null; is_active: boolean; connection_status: string | null; country_code: string | null; business_id: string | null; phone_number: string | null }> = [];
  // Fetch businesses and channels in bounded chunks to avoid URL-length overflow
  // when the .in() UUID array is serialized into the PostgREST query string.
  const CHUNK = 200;
  for (let i = 0; i < businessIds.length; i += CHUNK) {
    const chunk = businessIds.slice(i, i + CHUNK);
    const { data, error: businessError } = await service.from('businesses')
      .select('id, status, wa_method, assigned_channel_id, whatsapp_channel_id, bot_code, country_code, messaging_suspended')
      .in('id', chunk);
    if (businessError) return NextResponse.json({ error: 'Unable to verify WhatsApp readiness' }, { status: 500 });
    if (data) businesses.push(...data);
  }
  if (businesses.length) {
    const channelIds = [...new Set(businesses.flatMap(b => [b.assigned_channel_id, b.whatsapp_channel_id]).filter((id): id is string => !!id))];
    for (let i = 0; i < channelIds.length; i += CHUNK) {
      const chunk = channelIds.slice(i, i + CHUNK);
      const { data: channelRows, error: channelsError } = await service.from('whatsapp_channels')
        .select('id, channel_type, is_active, connection_status, country_code, business_id, phone_number')
        .in('id', chunk);
      if (channelsError) return NextResponse.json({ error: 'Unable to verify WhatsApp channel status' }, { status: 500 });
      if (channelRows) channels.push(...channelRows);
    }
  }
  const byBusiness = new Map(businesses.map(b => [b.id, b]));
  const byChannel = new Map(channels.map(c => [c.id, c]));
  const onboardings = queued.map(row => {
    const biz = row.business_id ? byBusiness.get(row.business_id) : null;
    const ch = biz ? byChannel.get(biz.assigned_channel_id || biz.whatsapp_channel_id || '') : null;
    const channelReady = isAssignedWhatsAppChannelReady(biz, ch);
    const requested = String(row.whatsapp_method || 'shared');
    return {
      ...row,
      whatsapp_setup: {
        requested_method: requested,
        current_method: biz?.wa_method || null,
        business_status: biz?.status || null,
        messaging_suspended: biz?.messaging_suspended === true,
        country_code: biz?.country_code || null,
        bot_code: biz?.bot_code || null,
        channel_ready: channelReady,
        whatsapp_link: buildVerifiedWhatsAppLink(biz, ch),
        channel_type: ch?.channel_type || null,
        connection_status: ch?.connection_status || null,
        owner_connection_required: requested !== 'shared' && !(channelReady && ch?.channel_type === 'dedicated'),
      },
    };
  });
  return NextResponse.json({ onboardings, options: { countries: countriesResult.data || [], categories: categoriesResult.data || [] } });
}

export async function POST(request: NextRequest) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: request.headers.get('authorization') ? 'Forbidden' : 'Unauthorized' }, { status: request.headers.get('authorization') ? 403 : 401 });
  const limit = await rateLimitResponseAsync(`admin-onboarding-create:${admin.userId}`, 10, 60 * 60_000);
  if (limit) return limit;

  const service = createServiceClient({ noStore: true });
  let input: AdminOnboardingInput;
  try {
    input = await validateAdminOnboardingInput(service, await request.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid request' }, { status: 400 });
  }

  const { data: prior } = await service.from('admin_onboarding_invites').select('*')
    .eq('created_by_admin_id', admin.userId).eq('request_key', input.request_key).maybeSingle();
  if (prior) {
    if (prior.status === 'failed') return NextResponse.json({ error: 'This request previously failed. Use the queue retry action.', onboarding: prior, idempotent: true }, { status: 409 });
    if (prior.status === 'cancelled') return NextResponse.json({ error: 'This request was cancelled. Start again with a new review submission.', onboarding: prior, idempotent: true }, { status: 409 });
    return NextResponse.json({ onboarding: prior, idempotent: true });
  }

  try {
    if (await authUserExists(service, input.owner_email)) {
      return NextResponse.json({ error: 'An account already exists for this email. No business was created.' }, { status: 409 });
    }
  } catch {
    return NextResponse.json({ error: 'Unable to verify that the email is safe to invite. No business was created.' }, { status: 503 });
  }

  const { data: onboarding, error: recordError } = await service.from('admin_onboarding_invites').insert({
    created_by_admin_id: admin.userId,
    target_email: input.owner_email,
    status: 'provisioning',
    intended_plan: input.intended_plan,
    whatsapp_method: input.whatsapp_method,
    request_key: input.request_key,
    metadata: { input },
  }).select('*').single();
  if (recordError || !onboarding) return NextResponse.json({ error: recordError?.code === '23505' ? 'An onboarding already exists for this email.' : 'Unable to start onboarding' }, { status: recordError?.code === '23505' ? 409 : 500 });

  const { error: createAuditError } = await logAdminAudit({
    actorId: admin.userId,
    action: 'admin_onboarding_create',
    entityType: 'admin_onboarding',
    entityId: onboarding.id,
    details: { target_email: input.owner_email, intended_plan: input.intended_plan, whatsapp_method: input.whatsapp_method },
  });
  if (createAuditError) {
    await service.from('admin_onboarding_invites').update({ status: 'failed', last_error: 'Create audit failed' }).eq('id', onboarding.id);
    return NextResponse.json({ error: 'Onboarding was not provisioned because its audit record could not be written.', onboarding_id: onboarding.id }, { status: 500 });
  }

  let userId: string | undefined;
  let businessId: string | undefined;
  try {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;
    const { data: linkData, error: linkError } = await service.auth.admin.generateLink({
      type: 'invite',
      email: input.owner_email,
      options: { data: { first_name: input.owner_first_name, last_name: input.owner_last_name }, redirectTo: `${appUrl}/auth/callback?next=/activate` },
    });
    if (linkError || !linkData.user || !linkData.properties?.action_link) throw new Error(linkError?.message || 'Invite creation failed');
    userId = linkData.user.id;
    const business = await provisionAdminBusiness(service, input, userId, onboarding.id);
    businessId = business.id;

    const email = await sendEmail({
      to: input.owner_email,
      subject: `Activate your Waaiio account for ${input.business_name}`,
      html: `<h1>Your business is ready to activate</h1><p>A Waaiio administrator prepared <strong>${escapeHtml(input.business_name)}</strong> for you.</p><p>You must set your own password and accept Waaiio's terms and privacy policy. Paid plans and dedicated WhatsApp still require your authorization.</p><p><a href="${linkData.properties.action_link}">Activate my account</a></p>`,
    });
    if (!email.success) throw new Error('Activation email delivery failed');

    const { error: updateError } = await service.from('admin_onboarding_invites').update({
      target_user_id: userId,
      business_id: businessId,
      status: 'customer_action_required',
      invite_sent_at: new Date().toISOString(),
      last_error: null,
    }).eq('id', onboarding.id).eq('status', 'provisioning');
    if (updateError) throw new Error(`Onboarding state update failed: ${updateError.message}`);
    const { error: auditError } = await logAdminAudit({
      actorId: admin.userId,
      action: 'admin_onboarding_invitation_sent',
      entityType: 'admin_onboarding',
      entityId: onboarding.id,
      details: { target_email: input.owner_email, target_user_id: userId, business_id: businessId, intended_plan: input.intended_plan, whatsapp_method: input.whatsapp_method },
    });
    if (auditError) throw new Error(`Audit write failed: ${auditError}`);
    return NextResponse.json({ onboarding: { ...onboarding, target_user_id: userId, business_id: businessId, status: 'customer_action_required' } }, { status: 201 });
  } catch (error) {
    // Extract businessId from provisioning error if the local variable was never set
    if (!businessId && error instanceof OnboardingProvisionError && error.businessId) {
      businessId = error.businessId;
    }
    const cleanupFailures: string[] = [];
    let bizCleaned = false;
    let userCleaned = false;
    if (businessId) {
      const { error: bizErr } = await service.from('businesses').delete().eq('id', businessId).eq('status', 'pending');
      if (bizErr) cleanupFailures.push(`business ${businessId}`);
      else bizCleaned = true;
    }
    if (userId) {
      const { error: userErr } = await service.auth.admin.deleteUser(userId);
      if (userErr) cleanupFailures.push(`user ${userId}`);
      else userCleaned = true;
    }
    const reason = error instanceof Error ? error.message : 'Provisioning failed';
    const durableError = cleanupFailures.length > 0
      ? `${reason} — cleanup incomplete: ${cleanupFailures.join(', ')}`
      : reason;
    // Preserve IDs for resources that still exist; only null IDs for resources actually deleted
    await service.from('admin_onboarding_invites').update({
      status: 'failed',
      last_error: durableError,
      target_user_id: userCleaned ? null : userId ?? null,
      business_id: bizCleaned ? null : businessId ?? null,
    }).eq('id', onboarding.id);
    await logAdminAudit({ actorId: admin.userId, action: 'admin_onboarding_failed', entityType: 'admin_onboarding', entityId: onboarding.id, details: { target_email: input.owner_email, reason, cleanup_failures: cleanupFailures } });
    const safetyNote = cleanupFailures.length > 0
      ? `Cleanup incomplete — manual reconciliation required for: ${cleanupFailures.join(', ')}.`
      : 'Resources cleaned up successfully.';
    return NextResponse.json({ error: `Onboarding failed. ${safetyNote}`, onboarding_id: onboarding.id }, { status: 500 });
  }
}

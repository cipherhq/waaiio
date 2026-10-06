import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync } from '@/lib/rate-limit';
import { sendEmail } from '@/lib/email/client';
import { provisionAdminBusiness, validateAdminOnboardingInput, type AdminOnboardingInput } from '@/lib/onboarding/admin-assisted';
import { CAPABILITY_TIER_REQUIREMENTS, tierMeetsRequirement, type CapabilityId, type SubscriptionTier } from '@/shared/capabilities';
import { authUserExists } from '@/lib/onboarding/auth-user';

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: request.headers.get('authorization') ? 'Forbidden' : 'Unauthorized' }, { status: request.headers.get('authorization') ? 403 : 401 });
  const service = createServiceClient({ noStore: true });
  const body = await request.json();
  const action = String(body.action || '');
  const { data: onboarding, error } = await service.from('admin_onboarding_invites').select('*').eq('id', params.id).maybeSingle();
  if (error || !onboarding) return NextResponse.json({ error: 'Onboarding not found' }, { status: 404 });

  if (action === 'resend') {
    const limit = await rateLimitResponseAsync(`admin-onboarding-resend:${onboarding.id}`, 3, 60 * 60_000);
    if (limit) return limit;
    if (!onboarding.target_user_id || !['invite_sent', 'customer_action_required'].includes(onboarding.status)) {
      return NextResponse.json({ error: 'This onboarding is not awaiting activation' }, { status: 409 });
    }
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;
    const { data: linkData, error: linkError } = await service.auth.admin.generateLink({
      type: 'recovery', email: onboarding.target_email, options: { redirectTo: `${appUrl}/auth/callback?next=/activate` },
    });
    if (linkError || !linkData.properties?.action_link) return NextResponse.json({ error: 'Unable to generate a secure activation link' }, { status: 500 });
    const sent = await sendEmail({
      to: onboarding.target_email,
      subject: 'Your Waaiio activation link',
      html: `<h1>Activate your Waaiio account</h1><p>This one-time link lets you set your password and finish activation.</p><p><a href="${linkData.properties.action_link}">Activate my account</a></p>`,
    });
    if (!sent.success) return NextResponse.json({ error: 'Activation email delivery failed' }, { status: 502 });
    await service.from('admin_onboarding_invites').update({ invite_sent_at: new Date().toISOString(), last_error: null }).eq('id', onboarding.id);
    const { error: auditError } = await service.from('admin_audit_logs').insert({ actor_id: admin.userId, action: 'admin_onboarding_invite_resend', entity_type: 'admin_onboarding', entity_id: onboarding.id, details: { target_email: onboarding.target_email, business_id: onboarding.business_id } });
    if (auditError) {
      await service.from('admin_onboarding_invites').update({ last_error: 'Invite sent but audit write failed; reconcile before resending.' }).eq('id', onboarding.id);
      return NextResponse.json({ error: 'Invite sent, but the audit record failed. Reconcile before continuing.', mutationApplied: true, auditRecorded: false }, { status: 207 });
    }
    return NextResponse.json({ success: true });
  }

  if (action === 'cancel') {
    if (!['provisioning', 'invite_pending', 'invite_sent', 'customer_action_required', 'failed'].includes(onboarding.status)) {
      return NextResponse.json({ error: 'This onboarding can no longer be cancelled' }, { status: 409 });
    }
    if (onboarding.target_user_id) {
      const { data: target, error: targetError } = await service.auth.admin.getUserById(onboarding.target_user_id);
      if (targetError) return NextResponse.json({ error: 'Invited account could not be checked safely' }, { status: 500 });
      if (target.user?.email_confirmed_at) return NextResponse.json({ error: 'Customer activation has started; cancellation is no longer safe.' }, { status: 409 });
    }
    if (onboarding.business_id) {
      const { error: businessError } = await service.from('businesses').delete().eq('id', onboarding.business_id).eq('status', 'pending');
      if (businessError) return NextResponse.json({ error: 'Pending business could not be cancelled safely' }, { status: 409 });
    }
    if (onboarding.target_user_id) {
      const { error: userError } = await service.auth.admin.deleteUser(onboarding.target_user_id);
      if (userError) return NextResponse.json({ error: 'Invited account could not be cancelled safely' }, { status: 500 });
    }
    await service.from('admin_onboarding_invites').update({ status: 'cancelled', cancelled_at: new Date().toISOString(), target_user_id: null, business_id: null }).eq('id', onboarding.id);
    const { error: auditError } = await service.from('admin_audit_logs').insert({ actor_id: admin.userId, action: 'admin_onboarding_cancel', entity_type: 'admin_onboarding', entity_id: onboarding.id, details: { target_email: onboarding.target_email } });
    if (auditError) return NextResponse.json({ error: 'Cancellation applied, but audit write failed. Reconcile before continuing.', mutationApplied: true, auditRecorded: false }, { status: 207 });
    return NextResponse.json({ success: true });
  }

  if (action === 'change_plan') {
    if (!['invite_sent', 'customer_action_required'].includes(onboarding.status)) {
      return NextResponse.json({ error: 'Plan intent can only change before activation' }, { status: 409 });
    }
    const intendedPlan = String(body.intended_plan || '') as SubscriptionTier;
    if (!['free', 'growth', 'business'].includes(intendedPlan)) return NextResponse.json({ error: 'Invalid intended plan' }, { status: 400 });
    const stored = (onboarding.metadata as { input?: AdminOnboardingInput } | null)?.input;
    const capabilities = (stored?.capabilities || []) as CapabilityId[];
    if (capabilities.some(capability => !tierMeetsRequirement(intendedPlan, CAPABILITY_TIER_REQUIREMENTS[capability]))) {
      return NextResponse.json({ error: 'The intended plan does not support the selected capabilities' }, { status: 400 });
    }
    const metadata = { ...(onboarding.metadata || {}), input: { ...stored, intended_plan: intendedPlan } };
    const { error: updateError } = await service.from('admin_onboarding_invites').update({ intended_plan: intendedPlan, metadata })
      .eq('id', onboarding.id).eq('status', onboarding.status);
    if (updateError) return NextResponse.json({ error: 'Unable to change intended plan' }, { status: 500 });
    const { error: auditError } = await service.from('admin_audit_logs').insert({ actor_id: admin.userId, action: 'admin_onboarding_intended_plan_changed', entity_type: 'admin_onboarding', entity_id: onboarding.id, details: { from: onboarding.intended_plan, to: intendedPlan, target_user_id: onboarding.target_user_id, business_id: onboarding.business_id } });
    if (auditError) return NextResponse.json({ error: 'Plan intent changed, but audit write failed. Reconcile before continuing.', mutationApplied: true, auditRecorded: false }, { status: 207 });
    return NextResponse.json({ success: true });
  }

  if (action === 'retry') {
    if (onboarding.status !== 'failed') return NextResponse.json({ error: 'Only failed onboarding can be retried' }, { status: 409 });
    const limit = await rateLimitResponseAsync(`admin-onboarding-retry:${onboarding.id}`, 5, 60 * 60_000);
    if (limit) return limit;
    let input: AdminOnboardingInput;
    try {
      input = await validateAdminOnboardingInput(service, (onboarding.metadata as { input?: Partial<AdminOnboardingInput> } | null)?.input || {});
    } catch (validationError) {
      return NextResponse.json({ error: validationError instanceof Error ? validationError.message : 'Stored onboarding input is invalid' }, { status: 400 });
    }
    let userId: string | undefined;
    let businessId: string | undefined;
    await service.from('admin_onboarding_invites').update({ status: 'provisioning', last_error: null }).eq('id', onboarding.id).eq('status', 'failed');
    try {
      if (await authUserExists(service, input.owner_email)) throw new Error('An account now exists for this email');
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;
      const { data: linkData, error: linkError } = await service.auth.admin.generateLink({ type: 'invite', email: input.owner_email, options: { data: { first_name: input.owner_first_name, last_name: input.owner_last_name }, redirectTo: `${appUrl}/auth/callback?next=/activate` } });
      if (linkError || !linkData.user || !linkData.properties?.action_link) throw new Error(linkError?.message || 'Invite creation failed');
      userId = linkData.user.id;
      const business = await provisionAdminBusiness(service, input, userId, onboarding.id);
      businessId = business.id;
      const sent = await sendEmail({ to: input.owner_email, subject: `Activate your Waaiio account for ${input.business_name}`, html: `<h1>Your business is ready to activate</h1><p>Set your password and complete customer-owned authorization.</p><p><a href="${linkData.properties.action_link}">Activate my account</a></p>` });
      if (!sent.success) throw new Error('Activation email delivery failed');
      await service.from('admin_onboarding_invites').update({ target_user_id: userId, business_id: businessId, status: 'customer_action_required', invite_sent_at: new Date().toISOString(), last_error: null }).eq('id', onboarding.id).eq('status', 'provisioning');
      const { error: auditError } = await service.from('admin_audit_logs').insert({ actor_id: admin.userId, action: 'admin_onboarding_retry', entity_type: 'admin_onboarding', entity_id: onboarding.id, details: { target_email: input.owner_email, target_user_id: userId, business_id: businessId } });
      if (auditError) throw new Error(`Audit write failed: ${auditError.message}`);
      return NextResponse.json({ success: true });
    } catch (retryError) {
      if (businessId) await service.from('businesses').delete().eq('id', businessId).eq('status', 'pending');
      if (userId) await service.auth.admin.deleteUser(userId);
      await service.from('admin_onboarding_invites').update({ status: 'failed', target_user_id: null, business_id: null, last_error: retryError instanceof Error ? retryError.message : 'Retry failed' }).eq('id', onboarding.id);
      return NextResponse.json({ error: 'Retry failed safely; no active business was created.' }, { status: 500 });
    }
  }

  return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
}

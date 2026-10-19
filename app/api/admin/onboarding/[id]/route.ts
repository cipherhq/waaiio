import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { consumeStepUp, StepUpError } from '@/lib/admin-step-up';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync } from '@/lib/rate-limit';
import { sendEmail } from '@/lib/email/client';
import { provisionAdminBusiness, validateAdminOnboardingInput, type AdminOnboardingInput } from '@/lib/onboarding/admin-assisted';
import { OnboardingProvisionError } from '@/lib/onboarding/provision-business';
import {
  allocateSharedChannelWithFallback,
  getSharedChannelFallbackPolicy,
  isAssignedWhatsAppChannelReady,
} from '@/lib/onboarding/whatsapp-readiness';
import { CAPABILITY_TIER_REQUIREMENTS, tierMeetsRequirement, type CapabilityId, type SubscriptionTier } from '@/shared/capabilities';
import { authUserExists } from '@/lib/onboarding/auth-user';
import { logAdminAudit } from '@/lib/admin-audit';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: request.headers.get('authorization') ? 'Forbidden' : 'Unauthorized' }, { status: request.headers.get('authorization') ? 403 : 401 });
  const service = createServiceClient({ noStore: true });
  const body = await request.json();
  const action = String(body.action || '');
  const { id } = await params;
  const { data: onboarding, error } = await service.from('admin_onboarding_invites').select('*').eq('id', id).maybeSingle();
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
    const { error: auditError } = await logAdminAudit({ actorId: admin.userId, action: 'admin_onboarding_invite_resend', entityType: 'admin_onboarding', entityId: onboarding.id, details: { target_email: onboarding.target_email, business_id: onboarding.business_id } });
    if (auditError) {
      await service.from('admin_onboarding_invites').update({ last_error: 'Invite sent but audit write failed; reconcile before resending.' }).eq('id', onboarding.id);
      return NextResponse.json({ error: 'Invite sent, but the audit record failed. Reconcile before continuing.', mutationApplied: true, auditRecorded: false }, { status: 207 });
    }
    return NextResponse.json({ success: true });
  }

  if (action === 'ensure_shared_channel') {
    const limit = await rateLimitResponseAsync(`admin-shared-channel:${onboarding.id}`, 5, 60 * 60_000);
    if (limit) return limit;
    if (!onboarding.business_id || !onboarding.target_user_id || ['cancelled', 'failed'].includes(onboarding.status)) {
      return NextResponse.json({ error: 'Business onboarding is not eligible for shared routing' }, { status: 409 });
    }
    // P2-2: Column is whatsapp_method per M429, not wa_method
    if (onboarding.whatsapp_method && onboarding.whatsapp_method !== 'shared') {
      return NextResponse.json({ error: 'This onboarding is configured for an owner-managed dedicated number' }, { status: 409 });
    }
    if (onboarding.whatsapp_channel_id) {
      return NextResponse.json({ error: 'A dedicated WhatsApp channel is already linked to this onboarding' }, { status: 409 });
    }
    const { data: business, error: bizError } = await service.from('businesses')
      .select('id, owner_id, country_code, wa_method, status, assigned_channel_id')
      .eq('id', onboarding.business_id).maybeSingle();
    if (bizError || !business || business.owner_id !== onboarding.target_user_id) {
      return NextResponse.json({ error: 'Business ownership could not be verified' }, { status: 409 });
    }
    // Never silently replace an already connected business-owned WABA.
    if (business.wa_method !== 'shared' || !['pending', 'active'].includes(business.status)) {
      return NextResponse.json({ error: 'This business requires an explicit owner-led channel transition' }, { status: 409 });
    }

    // P1-2: Fail closed on dedicated-channel query errors
    const { data: activeDedicated, error: dedicatedErr } = await service
      .from('whatsapp_channels')
      .select('id')
      .eq('business_id', business.id)
      .eq('channel_type', 'dedicated')
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();
    if (dedicatedErr) {
      return NextResponse.json({ error: 'Unable to verify dedicated channel state. Retry or check database connectivity.' }, { status: 500 });
    }
    if (activeDedicated) {
      return NextResponse.json({ error: 'Cannot allocate a shared channel when the business has an active dedicated WABA channel' }, { status: 409 });
    }

    // P1-1: Use actual candidate states from M391 schema; P1-2: fail closed on error
    const { data: openCandidate, error: candidateErr } = await service
      .from('whatsapp_channel_candidates')
      .select('id, status')
      .eq('business_id', business.id)
      .in('status', ['pending', 'validating', 'ready'])
      .limit(1)
      .maybeSingle();
    if (candidateErr) {
      return NextResponse.json({ error: 'Unable to verify WABA candidate state. Retry or check database connectivity.' }, { status: 500 });
    }
    if (openCandidate) {
      return NextResponse.json({ error: 'Cannot allocate a shared channel while an owner WABA setup candidate is in progress' }, { status: 409 });
    }

    // If the business already has a ready assigned shared channel, return idempotently without consuming step-up
    const previousChannelId = business.assigned_channel_id ?? null;
    if (previousChannelId) {
      const { data: existingChannel } = await service
        .from('whatsapp_channels')
        .select('id, phone_number, channel_type, is_active, connection_status, country_code, business_id')
        .eq('id', previousChannelId)
        .maybeSingle();
      if (isAssignedWhatsAppChannelReady(business, existingChannel)) {
        return NextResponse.json({
          success: true,
          allocated: true,
          idempotent: true,
          channel_id: existingChannel?.id ?? previousChannelId,
          phone_number: existingChannel?.phone_number ?? null,
          channel_country: existingChannel?.country_code ?? null,
          fallback_used: existingChannel?.country_code !== business.country_code,
          recheck_readiness: true,
        });
      }
    }

    // Operation-bound single-use step-up MFA verification (SEC-005)
    const stepUpId = String(body.stepUpId || '');
    const authoritativeStepUpParams = {
      operation: 'ensure_shared_channel',
      onboarding_id: String(onboarding.id),
      business_id: String(business.id),
      business_country: String(business.country_code || ''),
      fallback_policy: getSharedChannelFallbackPolicy(business.country_code),
      expected_wa_method: 'shared',
    };
    try {
      await consumeStepUp(admin, stepUpId, 'messaging_config', String(onboarding.id), authoritativeStepUpParams);
    } catch (stepUpErr) {
      // Only expose StepUpError messages (generic auth failure text).
      // Other errors (e.g. database) use a safe fallback to avoid leaking internals.
      const safeMessage = stepUpErr instanceof StepUpError
        ? stepUpErr.message
        : 'Step-up MFA verification required for shared channel allocation';
      return NextResponse.json(
        {
          error: safeMessage,
          code: 'STEP_UP_REQUIRED',
          step_up_context: authoritativeStepUpParams,
        },
        { status: 403 },
      );
    }

    // P1-3: Re-verify dedicated/candidate state after step-up to narrow race window.
    // Between the initial check and step-up consumption, an owner could have started
    // WABA setup via embedded signup. The M430 RPC locks the business row, but it
    // does not check for candidates — that's our responsibility.
    {
      const { data: raceDedicated, error: raceDE } = await service
        .from('whatsapp_channels').select('id')
        .eq('business_id', business.id).eq('channel_type', 'dedicated').eq('is_active', true)
        .limit(1).maybeSingle();
      if (raceDE || raceDedicated) {
        return NextResponse.json({ error: 'A dedicated channel appeared during MFA verification. Shared allocation aborted.' }, { status: 409 });
      }
      const { data: raceCandidate, error: raceCE } = await service
        .from('whatsapp_channel_candidates').select('id')
        .eq('business_id', business.id).in('status', ['pending', 'validating', 'ready'])
        .limit(1).maybeSingle();
      if (raceCE || raceCandidate) {
        return NextResponse.json({ error: 'An owner WABA setup started during MFA verification. Shared allocation aborted.' }, { status: 409 });
      }
    }

    const { data: allocation, error: allocationError } = await allocateSharedChannelWithFallback(
      service,
      business.id,
      business.country_code,
      { repairStaleSharedChannel: true },
    );
    if (allocationError || !allocation || !allocation.allocated) {
      return NextResponse.json({
        error: 'No eligible shared channel could be allocated. Check country-specific platform routing.',
        reason: allocationError?.message || allocation?.reason || 'allocation_failed',
      }, { status: 409 });
    }

    // Post-allocation readiness verification
    const { data: updatedBusiness, error: postBizErr } = await service
      .from('businesses')
      .select('id, country_code, assigned_channel_id')
      .eq('id', business.id)
      .maybeSingle();
    const { data: assignedChannel, error: postChErr } = updatedBusiness?.assigned_channel_id
      ? await service
          .from('whatsapp_channels')
          .select('id, phone_number, channel_type, is_active, connection_status, country_code, business_id')
          .eq('id', updatedBusiness.assigned_channel_id)
          .maybeSingle()
      : { data: null, error: null };

    if (postBizErr || postChErr || !isAssignedWhatsAppChannelReady(updatedBusiness, assignedChannel)) {
      // Readiness failed — compensate by clearing the unusable assignment.
      // The business stays in its previous state (pending/active without a
      // working shared channel). This prevents an unverified assignment from
      // being treated as live by the resolver or QR link generator.
      // P2-3: Verify CAS compensation actually updated the expected row.
      const danglingId = updatedBusiness?.assigned_channel_id ?? allocation.channel_id ?? null;
      let compensated = false;
      if (danglingId) {
        const { data: cleared, error: clearErr } = await service
          .from('businesses')
          .update({ assigned_channel_id: null })
          .eq('id', business.id)
          .eq('assigned_channel_id', danglingId) // CAS: only clear if still the same
          .select('id');
        compensated = !clearErr && Array.isArray(cleared) && cleared.length === 1;
      }
      await logAdminAudit({
        actorId: admin.userId,
        action: 'admin_onboarding_shared_channel_readiness_failed',
        entityType: 'admin_onboarding',
        entityId: onboarding.id,
        details: {
          business_id: business.id,
          allocated_channel_id: danglingId,
          post_biz_error: postBizErr?.message ?? null,
          post_ch_error: postChErr?.message ?? null,
          compensated,
          readiness_passed: false,
        },
      });
      return NextResponse.json(
        { error: `Shared channel failed readiness verification. ${compensated ? 'The unusable assignment was cleared.' : 'Manual reconciliation may be required.'}` },
        { status: 422 },
      );
    }

    // P1-2/P1-3 (post-allocation): Verify no concurrent dedicated setup appeared.
    // Fail closed on query errors — do not report successful allocation with uncertain state.
    {
      const { data: postDedicated, error: postDedErr } = await service
        .from('whatsapp_channels').select('id')
        .eq('business_id', business.id).eq('channel_type', 'dedicated').eq('is_active', true)
        .limit(1).maybeSingle();
      if (postDedErr) {
        await logAdminAudit({
          actorId: admin.userId,
          action: 'admin_onboarding_shared_channel_post_conflict_query_failed',
          entityType: 'admin_onboarding',
          entityId: onboarding.id,
          details: { business_id: business.id, error: postDedErr.message, allocated_channel_id: assignedChannel?.id },
        });
        return NextResponse.json(
          { error: 'Unable to verify dedicated-channel state after allocation. Retry or reconcile manually.' },
          { status: 500 },
        );
      }
      if (postDedicated) {
        await logAdminAudit({
          actorId: admin.userId,
          action: 'admin_onboarding_shared_channel_concurrent_dedicated_conflict',
          entityType: 'admin_onboarding',
          entityId: onboarding.id,
          details: { business_id: business.id, shared_channel_id: assignedChannel?.id, dedicated_channel_id: postDedicated.id },
        });
        return NextResponse.json(
          { error: 'A dedicated WABA channel was connected concurrently. Shared allocation is inconsistent; reconciliation required.' },
          { status: 409 },
        );
      }
    }

    if (
      typeof onboarding.last_error === 'string' &&
      onboarding.last_error.toLowerCase().includes('shared')
    ) {
      await service
        .from('admin_onboarding_invites')
        .update({ last_error: null, updated_at: new Date().toISOString() })
        .eq('id', onboarding.id);
    }

    const { error: auditError } = await logAdminAudit({
      actorId: admin.userId,
      action: 'admin_onboarding_shared_channel_reallocation',
      entityType: 'admin_onboarding',
      entityId: onboarding.id,
      details: {
        business_id: business.id,
        business_country: business.country_code,
        previous_channel_id: previousChannelId,
        allocated_channel_id: assignedChannel?.id ?? allocation.channel_id ?? null,
        channel_country: assignedChannel?.country_code ?? allocation.channel_country ?? business.country_code,
        fallback_used: Boolean(allocation.fallback_used || (assignedChannel?.country_code && assignedChannel.country_code !== business.country_code)),
        step_up_verified: true,
      },
    });
    if (auditError) return NextResponse.json({
      error: 'Shared allocation applied but the audit record failed; reconcile before further changes.',
      mutationApplied: true, auditRecorded: false,
    }, { status: 207 });
    return NextResponse.json({
      success: true,
      allocated: true,
      channel_id: assignedChannel?.id ?? allocation.channel_id ?? null,
      phone_number: assignedChannel?.phone_number ?? allocation.phone_number ?? null,
      channel_country: assignedChannel?.country_code ?? allocation.channel_country ?? business.country_code,
      fallback_used: Boolean(allocation.fallback_used || (assignedChannel?.country_code && assignedChannel.country_code !== business.country_code)),
      recheck_readiness: true,
    });
  }

  if (action === 'whatsapp_instructions') {
    // Admins can guide owners, never complete Meta OAuth/OTP on the owner's behalf.
    // Only send the customer-owned dashboard link; do not mint an admin-access token.
    const limit = await rateLimitResponseAsync(`admin-whatsapp-handoff:${onboarding.id}`, 3, 24 * 60 * 60_000);
    if (limit) return limit;
    if (!onboarding.target_user_id || !onboarding.business_id || ['cancelled', 'failed'].includes(onboarding.status)) {
      return NextResponse.json({ error: 'Business onboarding is not ready for WhatsApp assistance' }, { status: 409 });
    }
    const { data: business, error: businessError } = await service.from('businesses')
      .select('id, owner_id, status').eq('id', onboarding.business_id).maybeSingle();
    if (businessError || !business || business.owner_id !== onboarding.target_user_id) {
      return NextResponse.json({ error: 'Business ownership could not be verified' }, { status: 409 });
    }
    const appUrl = process.env.NEXT_PUBLIC_APP_URL;
    if (!appUrl) return NextResponse.json({ error: 'Customer app URL is not configured' }, { status: 503 });
    let destination: URL;
    try {
      destination = new URL('/dashboard/whatsapp/connect', appUrl);
      if (destination.protocol !== 'https:' || new URL(appUrl).pathname !== '/') throw new Error('invalid app origin');
    } catch {
      return NextResponse.json({ error: 'Customer app URL is invalid' }, { status: 503 });
    }
    const sent = await sendEmail({
      to: onboarding.target_email,
      subject: 'Complete your Waaiio WhatsApp connection',
      html: `<h1>Connect your business WhatsApp number</h1>
<p>A Waaiio administrator can guide you through setup. Please sign in to your own Waaiio account and finish activation if it is still pending.</p>
<p>To connect your number, you must personally authorize Waaiio in Meta and complete any verification. Never share your WhatsApp code, Meta password, or access tokens with support.</p>
<p><a href="${destination.toString()}">Open your secure WhatsApp setup</a></p>
<p>Prefer Waaiio's shared number? Contact your Waaiio administrator so they can check your country's channel availability.</p>`,
    });
    if (!sent.success) return NextResponse.json({ error: 'WhatsApp setup instructions could not be delivered' }, { status: 502 });
    const { error: auditError } = await logAdminAudit({
      actorId: admin.userId, action: 'admin_whatsapp_owner_handoff',
      entityType: 'admin_onboarding', entityId: onboarding.id,
      details: { business_id: business.id, target_user_id: onboarding.target_user_id },
    });
    if (auditError) {
      return NextResponse.json({ error: 'Instructions were sent, but the audit write failed; reconcile before resending.', mutationApplied: true, auditRecorded: false }, { status: 207 });
    }
    return NextResponse.json({ success: true, owner_action_required: true });
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
    let bizCleaned = false;
    if (onboarding.business_id) {
      const { error: businessError } = await service.from('businesses').delete().eq('id', onboarding.business_id).eq('status', 'pending');
      if (businessError) return NextResponse.json({ error: 'Pending business could not be cancelled safely. No resources were modified.' }, { status: 409 });
      bizCleaned = true;
    }
    if (onboarding.target_user_id) {
      const { error: userError } = await service.auth.admin.deleteUser(onboarding.target_user_id);
      if (userError) {
        // Persist durable partial-cancellation state — business was deleted but user still exists
        const partialError = bizCleaned
          ? `Business ${onboarding.business_id} deleted but user ${onboarding.target_user_id} could not be removed.`
          : `User ${onboarding.target_user_id} could not be removed.`;
        await service.from('admin_onboarding_invites').update({
          status: 'cancelled',
          cancelled_at: new Date().toISOString(),
          business_id: bizCleaned ? null : onboarding.business_id,
          last_error: partialError,
        }).eq('id', onboarding.id);
        await logAdminAudit({
          actorId: admin.userId, action: 'admin_onboarding_cancel_partial',
          entityType: 'admin_onboarding', entityId: onboarding.id,
          details: { target_email: onboarding.target_email, business_deleted: bizCleaned, user_deleted: false, orphaned_user_id: onboarding.target_user_id },
        });
        return NextResponse.json({ error: partialError, partiallyApplied: true }, { status: 500 });
      }
    }
    await service.from('admin_onboarding_invites').update({ status: 'cancelled', cancelled_at: new Date().toISOString(), target_user_id: null, business_id: null }).eq('id', onboarding.id);
    const { error: auditError } = await logAdminAudit({ actorId: admin.userId, action: 'admin_onboarding_cancel', entityType: 'admin_onboarding', entityId: onboarding.id, details: { target_email: onboarding.target_email } });
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
    const { error: auditError } = await logAdminAudit({ actorId: admin.userId, action: 'admin_onboarding_intended_plan_changed', entityType: 'admin_onboarding', entityId: onboarding.id, details: { from: onboarding.intended_plan, to: intendedPlan, target_user_id: onboarding.target_user_id, business_id: onboarding.business_id } });
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
      const { error: auditError } = await logAdminAudit({ actorId: admin.userId, action: 'admin_onboarding_retry', entityType: 'admin_onboarding', entityId: onboarding.id, details: { target_email: input.owner_email, target_user_id: userId, business_id: businessId } });
      if (auditError) throw new Error(`Audit write failed: ${auditError}`);
      return NextResponse.json({ success: true });
    } catch (retryError) {
      if (!businessId && retryError instanceof OnboardingProvisionError && retryError.businessId) {
        businessId = retryError.businessId;
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
      const reason = retryError instanceof Error ? retryError.message : 'Retry failed';
      const durableError = cleanupFailures.length > 0
        ? `${reason} — cleanup incomplete: ${cleanupFailures.join(', ')}`
        : reason;
      await service.from('admin_onboarding_invites').update({
        status: 'failed',
        target_user_id: userCleaned ? null : userId ?? null,
        business_id: bizCleaned ? null : businessId ?? null,
        last_error: durableError,
      }).eq('id', onboarding.id);
      const safetyNote = cleanupFailures.length > 0
        ? `Cleanup incomplete — manual reconciliation required for: ${cleanupFailures.join(', ')}.`
        : 'Resources cleaned up successfully.';
      return NextResponse.json({ error: `Retry failed. ${safetyNote}` }, { status: 500 });
    }
  }

  return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
}

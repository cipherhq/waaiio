import { listSignupPhones } from '@/lib/whatsapp/embedded-signup-assets';
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { MetaCloudService } from '@/lib/channels/meta-cloud';
import { encryptToken } from '@/lib/encryption';
import { consumeSignupSession } from '@/lib/whatsapp/embedded-signup-session';
import { randomInt } from 'crypto';
import { logger } from '@/lib/logger';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logAdminAudit } from '@/lib/admin-audit';

/** Finalize an explicit selection from a merchant-bound, one-use discovery session. */
export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (origin && origin !== request.nextUrl.origin) {
    return NextResponse.json({ message: 'Invalid request origin' }, { status: 403 });
  }
  const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'fb-callback'), 5, 60_000);
  if (rateLimit) return rateLimit;

  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }

    const {
      business_id,
      access_token: providedAccessToken,
      connection_id,
      code,
      waba_id: providedWabaId,
      phone_number_id: providedPhoneNumberId,
      connection_method,
    } = await request.json();

    // Coexistence MUST NOT fall through to standard Cloud API registration.
    // An untrusted browser connection_method value is not Meta provider evidence.
    // The dedicated Meta Business App onboarding + signed FINISH attestation
    // requires a separate audited implementation before any number mutation.
    if (connection_method === 'coexist' || connection_method === 'coexistence') {
      return NextResponse.json({
        error: 'coexistence_not_ready',
        message: 'Business App Connect requires Meta eligibility verification and dedicated onboarding. Your existing WhatsApp Business app number has not been changed.',
      }, { status: 409 });
    }
    if (connection_method && connection_method !== 'transfer') {
      return NextResponse.json({ error: 'Unsupported connection method' }, { status: 400 });
    }

    if (!business_id || typeof connection_id !== 'string' || !providedWabaId || !providedPhoneNumberId || code || providedAccessToken) {
      return NextResponse.json(
        { message: 'Choose an account and number from a fresh Meta connection.' },
        { status: 400 }
      );
    }

    let waba_id = providedWabaId || '';
    let phone_number_id = providedPhoneNumberId || '';

    // Verify business ownership
    const { data: business } = await supabase
      .from('businesses')
      .select('id, owner_id, name, country_code, address, assigned_channel_id, whatsapp_channel_id, wa_method, status')
      .eq('id', business_id)
      .single();

    if (!business || business.owner_id !== user.id) {
      return NextResponse.json({ message: 'Business not found or not owned by you' }, { status: 403 });
    }

    const session = await consumeSignupSession(user.id, business_id, connection_id);
    if (!session) {
      return NextResponse.json({ message: 'This Meta connection expired or was already used. Please reconnect with Meta.' }, { status: 409 });
    }
    const account = session.accounts.find(account => account.waba_id === waba_id);
    if (!account?.phones.some(phone => phone.id === phone_number_id)) {
      return NextResponse.json({ message: 'Choose a number shared by this Meta account.' }, { status: 403 });
    }
    const longLivedToken = session.accessToken;
    const tokenExpiresAt = session.tokenExpiresAt;

    // Recheck current account membership before any database/provider mutation.
    const currentPhones = await listSignupPhones(waba_id, longLivedToken);
    if (!currentPhones.some(phone => phone.id === phone_number_id)) {
      return NextResponse.json({ message: 'This number is no longer shared by the selected account. Please reconnect.' }, { status: 403 });
    }

    // Get phone number info from Meta
    const cloudService = new MetaCloudService({
      accessToken: longLivedToken,
      phoneNumberId: phone_number_id,
      wabaId: waba_id,
    });

    let displayName = business.name;
    let phoneNumber = '';
    let qualityRating = '';
    let messagingLimit = '';

    try {
      const phoneInfo = await cloudService.getPhoneNumberInfo();
      displayName = phoneInfo.verified_name || business.name;
      phoneNumber = phoneInfo.display_phone_number || '';
      qualityRating = phoneInfo.quality_rating || '';
      messagingLimit = phoneInfo.messaging_limit || '';
    } catch (err) {
      logger.error('Failed to get phone info:', err);
      return NextResponse.json({ message: 'Unable to verify the selected number with Meta. Please reconnect.' }, { status: 422 });
    }

    if (!phoneNumber) return NextResponse.json({ message: 'Meta did not return a verified phone identity.' }, { status: 422 });

    // ── Candidate-based connection (R9 §5: fence BEFORE provider mutation) ──
    const service = createServiceClient();
    const bizWaMethod = connection_method || 'transfer';
    const normalized = phoneNumber ? phoneNumber.replace(/[^0-9]/g, '') : null;

    // Conflict check via DB helper (R9 §2)
    if (normalized) {
      const { data: conflict, error: conflictError } = await service.rpc('check_phone_conflict', {
        p_normalized_phone: normalized,
        p_business_id: business_id,
        p_connection_source: 'embedded_signup',
      });
      if (conflictError) return NextResponse.json({ message: 'Unable to verify number availability. Please retry.' }, { status: 503 });
      if ((conflict as { conflict?: boolean })?.conflict) {
        const reason = (conflict as { reason?: string })?.reason || 'phone_conflict';
        return NextResponse.json(
          { error: reason === 'phone_owned_by_other_business'
              ? 'This number is already connected to another business.'
              : reason === 'cross_source_migration_unsupported'
              ? 'This number is already connected via a different method. Cross-method migration is not yet supported.'
              : 'This number requires support assistance to reconnect. Please contact support.'
          },
          { status: 409 },
        );
      }
    }

    // CAS snapshot
    const { data: existingDedicated } = await service
      .from('whatsapp_channels')
      .select('id')
      .eq('business_id', business_id)
      .eq('channel_type', 'dedicated')
      .eq('is_active', true)
      .maybeSingle();

    // Generate secure PIN (H7)
    const pin = String(randomInt(100000, 1000000));

    // INSERT fenced candidate BEFORE any provider mutation
    const { data: candidate, error: candErr } = await service
      .from('whatsapp_channel_candidates')
      .insert({
        business_id,
        connection_source: 'embedded_signup',
        business_wa_method: bizWaMethod,
        provider: 'meta_cloud',
        phone_number: phoneNumber,
        phone_number_normalized: normalized,
        phone_number_id,
        waba_id,
        meta_access_token: encryptToken(longLivedToken),
        meta_token_expires_at: tokenExpiresAt,
        display_name: displayName,
        country_code: business.country_code || 'NG',
        status: 'pending',
        expected_assigned_channel_id: business.assigned_channel_id || null,
        expected_whatsapp_channel_id: business.whatsapp_channel_id || null,
        expected_wa_method: business.wa_method || null,
        replacing_dedicated_channel_id: existingDedicated?.id || null,
        provider_state: {},
        encrypted_registration_pin: encryptToken(pin),
      })
      .select('id')
      .single();

    if (candErr || !candidate) {
      if (candErr?.code === '23505') {
        return NextResponse.json({ error: 'A connection attempt is already in progress.' }, { status: 409 });
      }
      logger.error('[FB-CALLBACK] Candidate creation failed:', candErr);
      return NextResponse.json({ message: 'Failed to start WhatsApp connection' }, { status: 500 });
    }

    // Mark validating before provider work
    await service.from('whatsapp_channel_candidates').update({
      status: 'validating',
      updated_at: new Date().toISOString(),
    }).eq('id', candidate.id);

    // ── Provider validation chain (all FATAL) ──
    let providerState: Record<string, unknown> = {};

    // 1. Register the phone number for Cloud API messaging — REQUIRED
    try {
      await cloudService.registerPhoneNumber(pin);
      providerState.registered = true;
      logger.debug('[FB-CALLBACK] Phone registered for Cloud API');
    } catch (regErr) {
      logger.error('[FB-CALLBACK] Phone registration FAILED:', regErr);
      providerState.registered = false;
      await service.from('whatsapp_channel_candidates').update({
        status: 'failed',
        failure_reason: `Phone registration failed: ${String(regErr)}`,
        provider_state: providerState,
        updated_at: new Date().toISOString(),
      }).eq('id', candidate.id);
      return NextResponse.json(
        { error: 'Phone registration failed. Please try again or contact support.', recoverable: true },
        { status: 422 },
      );
    }

    // 2. Subscribe Waaiio app to receive webhooks — REQUIRED
    try {
      const subRes = await fetch(
        `https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION || 'v22.0'}/${waba_id}/subscribed_apps`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${longLivedToken}` },
        }
      );
      if (!subRes.ok) {
        const subErrText = await subRes.text();
        throw new Error(`Subscription failed: ${subRes.status} ${subErrText}`);
      }
      const subData = await subRes.json();
      if (!subData.success) {
        throw new Error(`Subscription returned success=false: ${JSON.stringify(subData)}`);
      }
      providerState.webhook_subscribed = true;
      logger.debug('[FB-CALLBACK] Webhook subscription: ok');
    } catch (subErr) {
      logger.error('[FB-CALLBACK] WABA subscription FAILED:', subErr);
      providerState.webhook_subscribed = false;
      await service.from('whatsapp_channel_candidates').update({
        status: 'failed',
        failure_reason: `Webhook subscription failed: ${String(subErr)}`,
        provider_state: providerState,
        updated_at: new Date().toISOString(),
      }).eq('id', candidate.id);
      return NextResponse.json(
        { error: 'WhatsApp webhook subscription failed. Please try again or contact support.', recoverable: true },
        { status: 422 },
      );
    }

    // 3. All READY gates passed — mark candidate ready
    await service.from('whatsapp_channel_candidates').update({
      status: 'ready',
      provider_state: providerState,
      updated_at: new Date().toISOString(),
    }).eq('id', candidate.id);

    // 4. Atomic promotion with merchant auth (#799)
    // Original provider endpoint: always NULL step_up_id for genuine first connect.
    // If business has existing authority, SQL raises step_up_required and the
    // user must use the /finish endpoint with a verified step-up.
    const { data: promoResult, error: promoErr } = await service.rpc(
      'promote_candidate_with_merchant_auth',
      {
        p_candidate_id: candidate.id,
        p_business_id: business_id,
        p_step_up_id: null,
        p_owner_user_id: user.id,
      },
    );

    if (promoErr) {
      const msg = promoErr.message || 'unknown';
      logger.error('[FB-CALLBACK] Promotion failed:', msg);
      if (msg.includes('step_up_required')) {
        return NextResponse.json(
          { error: 'Two-factor authentication is required to replace your existing WhatsApp number.', code: 'STEP_UP_REQUIRED', candidate_id: candidate.id },
          { status: 403 },
        );
      }
      if (msg.includes('step_up_invalid')) {
        return NextResponse.json(
          { error: 'MFA authorization invalid, expired, or already used.', code: 'STEP_UP_INVALID', candidate_id: candidate.id },
          { status: 403 },
        );
      }
      await service.from('whatsapp_channel_candidates').update({
        status: 'failed',
        failure_reason: `Promotion failed: ${msg}`,
        updated_at: new Date().toISOString(),
      }).eq('id', candidate.id);
      return NextResponse.json(
        { error: 'Channel activation failed. Please try again.', recoverable: true, reason: msg },
        { status: 409 },
      );
    }

    if (!(promoResult as { ok?: boolean })?.ok) {
      const reason = (promoResult as { reason?: string })?.reason || 'unknown';
      logger.error('[FB-CALLBACK] Promotion returned not-ok:', reason);
      await service.from('whatsapp_channel_candidates').update({
        status: 'failed',
        failure_reason: `Promotion failed: ${reason}`,
        updated_at: new Date().toISOString(),
      }).eq('id', candidate.id);
      return NextResponse.json(
        { error: 'Channel activation failed. Please try again.', recoverable: true, reason },
        { status: 409 },
      );
    }

    const channelId = (promoResult as { channel_id?: string })?.channel_id;

    // 5. Reconcile paid allowance (non-fatal)
    try {
      await service.rpc('reconcile_paid_allowance', { p_business_id: business_id });
    } catch (reconcileErr) {
      logger.warn('[FB-CALLBACK] Paid allowance reconciliation (non-fatal):', reconcileErr);
    }

    // 6. Auto-set WhatsApp Business Profile (non-fatal)
    try {
      await cloudService.setBusinessProfile({
        about: `${business.name} — powered by Waaiio`,
        description: `Book appointments, make payments, and more — all on WhatsApp.`,
        address: business.address || undefined,
        websites: [process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'],
      });
      logger.debug('[FB-CALLBACK] Business profile set');
    } catch (err) {
      logger.error('[FB-CALLBACK] Business profile warning:', err);
    }

    // 7. Auto-provision templates (non-fatal)
    try {
      const { provisionTemplates } = await import('@/lib/channels/provision-templates');
      const templateResult = await provisionTemplates(waba_id, longLivedToken);
      logger.debug('[FB-CALLBACK] Templates provisioned:', templateResult);
    } catch (err) {
      logger.error('[FB-CALLBACK] Template provisioning warning:', err);
    }

    // Finish an assisted onboarding only after both canonical business activation
    // and the customer's successful Meta authorization are proven.
    if (business.status === 'active') {
      const { data: assisted } = await service.from('admin_onboarding_invites')
        .select('id, created_by_admin_id, target_user_id').eq('business_id', business_id)
        .eq('status', 'customer_action_required').in('whatsapp_method', ['dedicated', 'coexistence']).maybeSingle();
      if (assisted) {
        const activatedAt = new Date().toISOString();
        const { error: auditError } = await logAdminAudit({ actorId: assisted.created_by_admin_id, action: 'admin_onboarding_activated', entityType: 'admin_onboarding', entityId: assisted.id, details: { target_user_id: assisted.target_user_id, business_id, meta_authorized_by_customer: true, channel_id: channelId } });
        if (auditError) {
          logger.error('[FB-CALLBACK] Assisted onboarding completion audit failed:', auditError);
        } else {
          await service.from('admin_onboarding_invites')
            .update({ status: 'active', activated_at: activatedAt, last_error: null })
            .eq('id', assisted.id).eq('status', 'customer_action_required');
        }
      }
    }

    return NextResponse.json({
      message: 'WhatsApp number connected successfully',
      channel_id: channelId,
      display_name: displayName,
      phone_number: phoneNumber,
      connection_status: 'active',
    });
  } catch (error) {
    logger.error('Facebook callback error:', error);
    return NextResponse.json(
      { message: 'Something went wrong' },
      { status: 500 }
    );
  }
}

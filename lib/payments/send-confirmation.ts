import type { SupabaseClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';
import { stripPlus } from '@/lib/utils/phone';
import { getCustomerName } from '@/lib/bot/flows/shared/user';
import { getCalendarLinksText } from '@/lib/calendar/generate-links';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';
import type { ResolvedChannel } from '@/lib/channels/channel-resolver';

/** Log a non-fatal error with safe structured metadata. */
function logSafeError(prefix: string, label: string, error: unknown): void {
  logger.withContext({ op: `send-confirmation.${label}`, ...safeLogErrorContext(error) })
    .error(`${prefix} ${label.replace(/-/g, ' ')} error`);
}

// ── Centralized lifecycle RPC helpers ──
// Every helper inspects both { data, error } and validates the semantic result.

type LifecycleResult = { ok: boolean; reason?: string };

async function renewConfirmationClaim(
  supabase: SupabaseClient, paymentId: string, claimToken: string, logPrefix: string,
): Promise<LifecycleResult> {
  const { data, error } = await supabase.rpc('renew_payment_confirmation_claim', {
    p_payment_id: paymentId, p_claim_token: claimToken,
  });
  if (error) {
    logSafeError(logPrefix, 'renew-rpc', error);
    Sentry.captureException(error, { tags: { component: 'send-confirmation', operation: 'renew' } });
    return { ok: false, reason: 'rpc_error' };
  }
  if (!data?.renewed) {
    return { ok: false, reason: data?.reason || 'unknown' };
  }
  return { ok: true };
}

async function releaseConfirmationClaim(
  supabase: SupabaseClient, paymentId: string, claimToken: string, logPrefix: string,
): Promise<LifecycleResult> {
  const { data, error } = await supabase.rpc('release_payment_confirmation', {
    p_payment_id: paymentId, p_claim_token: claimToken,
  });
  if (error) {
    logSafeError(logPrefix, 'release-rpc', error);
    return { ok: false, reason: 'rpc_error' };
  }
  if (!data?.released) {
    return { ok: false, reason: data?.reason || 'unknown' };
  }
  logger.info(`${logPrefix} Confirmation claim released for retry`);
  return { ok: true };
}

async function finalizeConfirmationClaim(
  supabase: SupabaseClient, paymentId: string, claimToken: string, logPrefix: string,
): Promise<LifecycleResult> {
  // First attempt
  let { data, error } = await supabase.rpc('finalize_payment_confirmation', {
    p_payment_id: paymentId, p_claim_token: claimToken,
  });

  // Retry once on RPC/db error (idempotent operation)
  if (error) {
    logSafeError(logPrefix, 'finalize-rpc-attempt1', error);
    const retry = await supabase.rpc('finalize_payment_confirmation', {
      p_payment_id: paymentId, p_claim_token: claimToken,
    });
    data = retry.data;
    error = retry.error;
  }

  if (error) {
    logSafeError(logPrefix, 'finalize-rpc-attempt2', error);
    Sentry.captureException(error, { tags: { component: 'send-confirmation', operation: 'finalize' } });
    // Leave claim in place — do NOT release after sends occurred.
    // Stale recovery or reconciliation will handle.
    return { ok: false, reason: 'rpc_error' };
  }
  if (data?.finalized) {
    if (data.already_finalized) {
      logger.info(`${logPrefix} Confirmation already finalized`);
    } else {
      logger.info(`${logPrefix} Confirmation finalized`);
    }
    return { ok: true };
  }
  // token_mismatch or unexpected state — claim may belong to another worker
  logger.warn(`${logPrefix} Finalization not confirmed: ${data?.reason || 'unknown'}`);
  return { ok: false, reason: data?.reason || 'unknown' };
}

interface PaymentForConfirmation {
  id: string;
  amount: number;
  booking_id: string | null;
  invoice_id: string | null;
  campaign_id: string | null;
  reservation_id?: string | null;
  order_id?: string | null;
  payment_authority_version?: number | null;
}

/** Explicit result from sendProactiveConfirmation for callers that need to distinguish outcomes. */
export type ConfirmationResult =
  | { status: 'completed' }
  | { status: 'already_completed' }
  | { status: 'processing'; retryable: true }
  | { status: 'retryable_failed'; retryable: true; reason: string }
  | { status: 'not_deliverable'; retryable: false; reason: string };

/**
 * Send proactive WhatsApp confirmation after a successful payment.
 * Shared across all 5 gateway webhooks + payment-success page.
 *
 * Handles:
 * 1. Find customer phone + business info from booking/invoice/order
 * 2. Resolve the WhatsApp channel (prefer inbound channel from session)
 * 3. Send confirmation message with emojis
 * 4. Run post-completion (loyalty, feedback, referral)
 * 5. Send tickets for ticketing bookings
 * 6. Reset session to select_capability (keep user with business)
 */
export async function sendProactiveConfirmation(
  supabase: SupabaseClient,
  payment: PaymentForConfirmation,
  logPrefixOrOpts: string | { logPrefix?: string; exactEntityFamily?: boolean } = '[WEBHOOK]',
): Promise<ConfirmationResult> {
  const logPrefix = typeof logPrefixOrOpts === 'string' ? logPrefixOrOpts : (logPrefixOrOpts.logPrefix ?? '[WEBHOOK]');
  // When true, this payment is linked to a booking/order/reservation family whose session
  // lifecycle is owned by Stage 2.5 exact-origin terminalization. Stage 3 must NOT run the
  // broad business+phone heuristic for these families — even for legacy_null origins.
  // Only invoice/campaign families (exactEntityFamily=false) retain the broad heuristic.
  const exactEntityFamily = typeof logPrefixOrOpts === 'object' ? (logPrefixOrOpts.exactEntityFamily ?? false) : false;
  // ── Atomic claim: only one concurrent caller wins processing rights ──
  const { data: claim, error: claimError } = await supabase.rpc('claim_payment_confirmation', {
    p_payment_id: payment.id,
  });

  if (claimError) {
    logSafeError(logPrefix, 'claim-rpc', claimError);
    Sentry.captureException(claimError, { tags: { component: 'send-confirmation', operation: 'claim' } });
    return { status: 'retryable_failed', retryable: true, reason: 'claim_rpc_error' };
  }

  if (!claim?.claimed) {
    if (claim?.already_completed) {
      logger.info(`${logPrefix} Confirmation already sent for payment ${payment.id} — skipping`);
      return { status: 'already_completed' };
    }
    logger.info(`${logPrefix} Confirmation claim not granted for payment ${payment.id}: ${claim?.reason || 'unknown'}`);
    return { status: 'processing', retryable: true };
  }

  const claimToken = claim.claim_token as string;
  if (!claimToken || !claim.payment_id) {
    logger.error(`${logPrefix} Claim succeeded but returned incomplete data for payment ${payment.id}`);
    return { status: 'retryable_failed', retryable: true, reason: 'claim_incomplete_data' };
  }

  // Use the claim's authoritative payment data (includes payment_authority_version for Phase-A detection)
  payment = {
    id: claim.payment_id,
    amount: claim.amount,
    booking_id: claim.booking_id || null,
    invoice_id: claim.invoice_id || null,
    campaign_id: claim.campaign_id || null,
    reservation_id: claim.reservation_id || null,
    order_id: claim.order_id || null,
    payment_authority_version: claim.payment_authority_version ?? null,
  };

  // Track whether any external sends have occurred (affects release safety)
  // Conservative: set BEFORE attempting any external/non-idempotent operation.
  // Once true, never returns to false. Prevents claim release after indeterminate sends.
  let sideEffectsMayHaveOccurred = false;

  try {
  // ── Post-claim processing: any failure releases the claim for retry ──

  let customerPhone: string | null = null;
  let customerEmail: string | null = null;
  let donationReceiptEmailAddress: string | null = null;
  let businessId: string | null = null;
  let businessName = 'Business';
  let serviceName = 'Payment';
  let referenceCode = '';
  let countryCode: CountryCode = 'US';
  let bookingDate: string | undefined;
  let bookingTime: string | undefined;
  let bookingAddress: string | undefined;
  let bookingDuration: number | undefined;
  let balanceRemaining = 0;
  let balanceBookingId: string | null = null;
  let balanceReservationId: string | null = null;
  let bookingFlowType: string | undefined;
  let bookingServiceType: string | undefined;

  // ── 1. Resolve customer + business from booking ──
  if (payment.booking_id) {
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .select('guest_phone, guest_email, reference_code, business_id, date, time, flow_type, total_amount, deposit_amount, businesses(name, country_code, address, payment_gateway), services(name, duration_minutes, service_type)')
      .eq('id', payment.booking_id)
      .single();

    if (bookingError) {
      logSafeError(logPrefix, 'booking-lookup', bookingError);
    }

    if (booking) {
      customerPhone = booking.guest_phone;
      customerEmail = booking.guest_email || null;
      businessId = booking.business_id;
      referenceCode = booking.reference_code || '';
      const biz = booking.businesses as unknown as { name: string; country_code?: string; address?: string; payment_gateway?: string } | null;
      const svc = booking.services as unknown as { name: string; duration_minutes?: number; service_type?: string } | null;
      bookingFlowType = booking.flow_type || undefined;
      bookingServiceType = svc?.service_type || undefined;
      if (biz?.name) businessName = biz.name;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      if (svc?.name) serviceName = svc.name;
      if (booking.date && booking.time && booking.flow_type !== 'ordering') {
        bookingDate = booking.date;
        bookingTime = booking.time;
        bookingAddress = biz?.address || undefined;
        bookingDuration = svc?.duration_minutes || undefined;
      }
      // Check for remaining balance (deposit scenario)
      const total = Number(booking.total_amount || 0);
      const deposit = Number(booking.deposit_amount || 0);
      if (total > 0 && deposit > 0 && total > deposit) {
        balanceRemaining = total - deposit;
        balanceBookingId = payment.booking_id!;
      }
    }
  }

  // ── 1b. Try reservation ──
  if (!customerPhone && payment.reservation_id) {
    const { data: reservation } = await supabase
      .from('reservations')
      .select('guest_phone, reference_code, business_id, guest_name, check_in, check_out, total_amount, deposit_amount, businesses:business_id(name, country_code, payment_gateway)')
      .eq('id', payment.reservation_id)
      .single();

    if (reservation) {
      customerPhone = reservation.guest_phone;
      businessId = reservation.business_id;
      referenceCode = reservation.reference_code || '';
      const biz = reservation.businesses as unknown as { name: string; country_code?: string; payment_gateway?: string } | null;
      if (biz?.name) businessName = biz.name;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      const checkIn = new Date(reservation.check_in + 'T00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
      const checkOut = new Date(reservation.check_out + 'T00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
      serviceName = `Reservation ${checkIn} - ${checkOut}`;
      // Check for remaining balance
      const total = Number(reservation.total_amount || 0);
      const deposit = Number(reservation.deposit_amount || 0);
      if (total > 0 && deposit > 0 && total > deposit) {
        balanceRemaining = total - deposit;
        balanceReservationId = payment.reservation_id!;
      }
    }
  }

  // ── 2. Try invoice ──
  if (!customerPhone && payment.invoice_id) {
    const { data: invoice } = await supabase
      .from('invoices')
      .select('customer_phone, reference_code, description, business_id, businesses:business_id(name, country_code)')
      .eq('id', payment.invoice_id)
      .single();

    if (invoice) {
      customerPhone = invoice.customer_phone;
      businessId = invoice.business_id;
      referenceCode = invoice.reference_code || '';
      const biz = invoice.businesses as unknown as { name: string; country_code?: string } | null;
      if (biz?.name) businessName = biz.name;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      serviceName = invoice.description || `Invoice ${referenceCode}`;
    }
  }

  // ── 3. Fallback: orders via payment metadata ──
  if (!customerPhone) {
    const { data: paymentFull } = await supabase
      .from('payments')
      .select('user_id, metadata')
      .eq('id', payment.id)
      .single();

    const meta = (paymentFull?.metadata || {}) as Record<string, unknown>;
    if (meta.order_id) {
      const { data: order } = await supabase
        .from('orders')
        .select('delivery_phone, reference_code, business_id, businesses(name, country_code)')
        .eq('id', meta.order_id as string)
        .maybeSingle();
      if (order) {
        customerPhone = order.delivery_phone;
        businessId = order.business_id;
        referenceCode = order.reference_code || '';
        const biz = order.businesses as unknown as { name: string; country_code?: string } | null;
        if (biz?.name) businessName = biz.name;
        if (biz?.country_code) countryCode = biz.country_code as CountryCode;
        serviceName = `Order ${referenceCode}`;
      }
    }

    if (!customerPhone && paymentFull?.user_id) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('phone')
        .eq('id', paymentFull.user_id)
        .single();
      customerPhone = profile?.phone || null;
    }
  }

  if (!businessId) {
    logger.warn(`${logPrefix} Proactive confirmation skipped — no business`);
    await releaseConfirmationClaim(supabase, payment.id, claimToken, logPrefix);
    return { status: 'retryable_failed', retryable: true, reason: 'no_business_resolved' };
  }

  // Fetch subscription tier for white-label checks on emails
  let isWl = false;
  try {
    const { data: bizTier } = await supabase.from('businesses').select('subscription_tier').eq('id', businessId).single();
    const { isWhiteLabel } = await import('@/lib/whitelabel');
    isWl = isWhiteLabel(bizTier?.subscription_tier);
  } catch { /* non-critical */ }

  // For web channel bookings, we may not have a phone but should still send email
  if (!customerPhone) {
    // Try to send email-only confirmation for web channel bookings
    let guestEmail: string | null = null;
    if (payment.booking_id) {
      const { data: emailBooking } = await supabase
        .from('bookings')
        .select('guest_email, channel')
        .eq('id', payment.booking_id)
        .single();
      guestEmail = emailBooking?.guest_email || null;
      customerEmail = guestEmail;
    }
    if (!guestEmail) {
      logger.warn(`${logPrefix} Proactive confirmation skipped — no phone or email`);
      // Atomic claim-fenced termination (v13): sets confirmation_terminal_reason + clears claim
      const { data: termResult, error: termError } = await supabase.rpc('terminate_payment_confirmation', {
        p_payment_id: payment.id,
        p_claim_token: claimToken,
        p_terminal_reason: 'not_deliverable',
      });
      if (termError || !termResult) {
        logger.error(`${logPrefix} terminate_payment_confirmation RPC failed`, termError);
        return { status: 'retryable_failed', retryable: true, reason: 'termination_rpc_failed' };
      }
      if (termResult.terminated === true || termResult.already_terminated === true) {
        return { status: 'not_deliverable', retryable: false, reason: 'no_phone_or_email' };
      }
      return { status: 'retryable_failed', retryable: true, reason: termResult.reason || 'termination_unexpected' };
    }
    // We have email but no phone — send email-only below
    logger.info(`${logPrefix} No phone found, will attempt email-only confirmation`);
  }

  logger.info(`${logPrefix} Sending proactive confirmation for ${businessName}`);

  // ── 4. Build confirmation message (local string work — no external calls) ──
  const lines = [
    `✅ *Payment Confirmed!*`,
    '',
    `🏢 ${businessName}`,
    `📋 ${serviceName}`,
    `💰 Amount: ${formatCurrency(payment.amount, countryCode)}`,
    referenceCode ? `🔑 Ref: *${referenceCode}*` : '',
    '',
    'Thank you for your payment! 🙏',
  ].filter(Boolean);

  // ── CHECKPOINT 1: Renew ownership before ANY external/non-idempotent operation ──
  // This must happen before balance-payment initialization (which contacts a payment provider)
  // and before the customer WhatsApp send.
  const preExternal = await renewConfirmationClaim(supabase, payment.id, claimToken, logPrefix);
  if (!preExternal.ok) {
    logger.warn(`${logPrefix} Ownership lost before external operations: ${preExternal.reason}`);
    return { status: 'processing', retryable: true }; // claim may belong to another worker
  }

  // Resolve the actual WhatsApp sender before freezing optional manifest effects.
  // A customer phone is only a destination; it is not evidence that a usable
  // sender/channel exists. The resolved channel is reused by the send phase.
  let resolved: ResolvedChannel | null = null;
  let inboundChId: string | undefined;
  let confirmationOrigin: string | undefined;
  let whatsappOriginMissingChannel = false;
  if (customerPhone) {
    const { ChannelResolver } = await import('@/lib/channels/channel-resolver');
    const resolver = new ChannelResolver(supabase);
    const { data: payChMeta } = await supabase.from('payments').select('metadata').eq('id', payment.id).single();
    const payMeta = (payChMeta?.metadata || {}) as Record<string, unknown>;
    inboundChId = payMeta._inbound_channel_id as string | undefined;
    confirmationOrigin = payMeta._confirmation_origin as string | undefined;
    // Non-WhatsApp origin or legacy (no _confirmation_origin) may use the
    // existing business fallback; WhatsApp origin never borrows another channel.
    if (!inboundChId && confirmationOrigin !== 'whatsapp') {
      const { data: bizSession } = await supabase
        .from('bot_sessions').select('session_data')
        .eq('whatsapp_number', customerPhone).eq('business_id', businessId)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      inboundChId = (bizSession?.session_data as Record<string, unknown>)?._inbound_channel_id as string | undefined;
    }
    if (inboundChId) resolved = await resolver.resolveByChannelId(inboundChId);
    if (!resolved && confirmationOrigin === 'whatsapp') {
      whatsappOriginMissingChannel = true;
    } else if (!resolved) {
      resolved = await resolver.resolveByBusinessId(businessId);
    }
  }

  // ── MANIFEST INITIALIZATION: Register all applicable Stage-3 effects ──
  // Fail-closed for Phase-A payments (payment_authority_version >= 1).
  // Historical payments without authority version use legacy path.
  let manifestInitialized = false;
  const effectTokens: Record<string, string> = {};
  const isPhaseAPayment = payment.payment_authority_version != null;
  try {
    const { computeApplicableEffects, initializeManifest } = await import('@/lib/payments/terminal-effects');

    // Derive loyalty applicability from canonical capability resolver + business config
    let hasLoyalty = false;
    let hasReferral = false;
    let hasMembership = false;
    let hasFeedback = false;
    let skipLoyaltyFlag = false;
    if (businessId) {
      try {
        const { getEnabledCapabilities } = await import('@/lib/capabilities/service');
        const caps = await getEnabledCapabilities(supabase, businessId);
        const { data: bizMeta } = await supabase.from('businesses').select('metadata').eq('id', businessId).single();
        const meta = (bizMeta?.metadata || {}) as Record<string, unknown>;
        const loyaltyEnabled = meta.loyalty_earning_enabled === true;
        hasLoyalty = caps.includes('loyalty') && loyaltyEnabled;
        hasReferral = caps.includes('referral');
        hasMembership = caps.includes('membership');
        hasFeedback = caps.includes('feedback');
        // Giving/ambiguous classification from booking data
        const isPaymentFamily = bookingFlowType === 'payment';
        const isGivingPayment = isPaymentFamily && bookingServiceType === 'giving';
        const isAmbiguousPayment = isPaymentFamily && bookingServiceType !== 'booking' && bookingServiceType !== 'giving';
        skipLoyaltyFlag = isGivingPayment || isAmbiguousPayment;
      } catch (capabilityError) {
        // Applicability is part of the frozen manifest. An unreadable capability
        // snapshot is not equivalent to a legitimate all-disabled snapshot.
        throw new Error(`effect_capability_discovery_failed:${String(capabilityError)}`);
      }
    }

    if (payment.campaign_id) {
      const { data: donation, error: donationError } = await supabase
        .from('campaign_donations')
        .select('donor_phone')
        .eq('payment_id', payment.id)
        .eq('status', 'success')
        .maybeSingle();
      if (donationError) throw new Error(`donation_email_discovery_failed:${donationError.message}`);
      if (donation?.donor_phone) {
        const phoneP = donation.donor_phone.startsWith('+') ? donation.donor_phone : `+${donation.donor_phone}`;
        const phoneN = donation.donor_phone.startsWith('+') ? donation.donor_phone.slice(1) : donation.donor_phone;
        const { data: donorProfile, error: donorProfileError } = await supabase
          .from('profiles')
          .select('email')
          .or(`phone.eq.${sanitizeFilterValue(phoneP)},phone.eq.${sanitizeFilterValue(phoneN)}`)
          .limit(1)
          .maybeSingle();
        if (donorProfileError) throw new Error(`donation_email_profile_lookup_failed:${donorProfileError.message}`);
        donationReceiptEmailAddress = donorProfile?.email || null;
      }
    }

    const applicableEffects = computeApplicableEffects(payment, {
      hasCustomerPhone: !!customerPhone,
      hasGuestEmail: !!customerEmail,
      hasDonationEmail: !!donationReceiptEmailAddress,
      hasSender: !!resolved?.sender,
      hasLoyalty,
      hasReferral,
      hasMembership,
      hasFeedback,
      isTicketing: bookingFlowType === 'ticketing',
      skipLoyalty: skipLoyaltyFlag,
      skipAutomation: !!payment.order_id || !!payment.campaign_id || !!payment.invoice_id,
      amountPaid: payment.amount,
    });

    const initResult = await initializeManifest(supabase, payment.id, claimToken, applicableEffects);
    manifestInitialized = initResult.ok;
    if (!initResult.ok && isPhaseAPayment) {
      // Fail-closed: Phase-A payments MUST have a manifest to finalize
      logger.error(`${logPrefix} Manifest initialization failed (fail-closed for Phase-A): ${initResult.error}`);
      await releaseConfirmationClaim(supabase, payment.id, claimToken, logPrefix);
      return { status: 'retryable_failed', retryable: true, reason: 'manifest_init_failed' };
    }
  } catch (manifestErr) {
    if (isPhaseAPayment) {
      logger.error(`${logPrefix} Manifest initialization error (fail-closed):`, manifestErr);
      await releaseConfirmationClaim(supabase, payment.id, claimToken, logPrefix);
      return { status: 'retryable_failed', retryable: true, reason: 'manifest_init_error' };
    }
    logger.warn(`${logPrefix} Manifest initialization error (legacy bypass):`, manifestErr);
  }

  // Add balance info if deposit was partial
  if (balanceRemaining > 0) {
    lines.push('', `💳 Remaining balance: *${formatCurrency(balanceRemaining, countryCode)}*`);

    // Generate payment link for the balance — contacts the payment provider
    try {
      const phoneForLookup = customerPhone || '';
      const phoneP = phoneForLookup.startsWith('+') ? phoneForLookup : `+${phoneForLookup}`;
      const phoneN = phoneForLookup.startsWith('+') ? phoneForLookup.slice(1) : phoneForLookup;
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .or(`phone.eq.${sanitizeFilterValue(phoneP)},phone.eq.${sanitizeFilterValue(phoneN)}`)
        .limit(1)
        .maybeSingle();

      if (profile && businessId) {
        sideEffectsMayHaveOccurred = true; // Provider initialization — indeterminate on failure
        const { initializePayment } = await import('@/lib/bot/flows/shared/payment');
        const result = await initializePayment(supabase, {
          bookingId: balanceBookingId || undefined,
          reservationId: balanceReservationId || undefined,
          userId: profile.id,
          amount: balanceRemaining,
          referenceCode,
          businessName,
          phone: phoneForLookup,
          countryCode,
          businessId,
        });
        if (result?.url) {
          lines.push(`💰 Pay now: ${result.url}`);
        }
      }
    } catch {
      // Non-critical — balance info still shown without link.
      // sideEffectsMayHaveOccurred remains true — provider may have accepted the request.
    }
  }

  lines.push('', 'Type *receipt* to get your receipt', 'Type *my bookings* to view your bookings');

  // Add calendar links for bookings with specific date+time (not orders, invoices, donations)
  if (bookingDate && bookingTime && referenceCode) {
    const calLinks = getCalendarLinksText({
      businessName,
      businessAddress: bookingAddress,
      serviceName,
      referenceCode,
      date: bookingDate,
      time: bookingTime,
      durationMinutes: bookingDuration || 60,
    });
    if (calLinks) {
      lines.push(calLinks);
    }
  }

  // Show "save card" tip only for Paystack + first payment or new card (not on every confirmation)
  let showSaveCardTip = false;
  if (businessId) {
    const { data: paymentGw } = await supabase.from('payments').select('gateway, metadata').eq('id', payment.id).single();
    if (paymentGw?.gateway === 'paystack' && customerPhone) {
      const phoneP = customerPhone.startsWith('+') ? customerPhone : `+${customerPhone}`;
      // Check if customer already has a saved card for this business
      const { data: existingSaved } = await supabase
        .from('saved_payment_methods')
        .select('id, card_last4')
        .eq('business_id', businessId)
        .eq('customer_phone', phoneP)
        .eq('is_active', true)
        .maybeSingle();

      if (!existingSaved) {
        // No saved card — check if this is their first payment or a new card
        const auth = (paymentGw.metadata as Record<string, unknown>)?._card_authorization as Record<string, unknown> | undefined;
        if (auth?.reusable) {
          showSaveCardTip = true;
        }
      }
    }
  }

  if (showSaveCardTip) {
    lines.push('');
    lines.push('💳 Type *save card* to save this card for faster checkout next time');
  }

  // ── 5. Resolve channel + send (protected by checkpoint 1 above) ──
  try {
    if (whatsappOriginMissingChannel) {
      logger.warn(`${logPrefix} Customer WhatsApp send skipped — no origin channel for WhatsApp-originated payment ${payment.id}`);
    }

    // ── Customer WhatsApp delivery via delivery-attempt authority (#197) ──
    // The delivery-attempt table owns ONLY the customer WhatsApp send effect.
    // Stage-3 master claim (claim_payment_confirmation) still owns the full lifecycle.
    if (resolved && customerPhone) {
      const phone = stripPlus(customerPhone);

      // Check/claim delivery attempt (payment-wide, source is provenance only)
      const { data: deliveryClaim, error: deliveryClaimErr } = await supabase.rpc('claim_confirmation_delivery', {
        p_payment_id: payment.id,
        p_attempt_source: 'webhook_stage3',
      });

      if (deliveryClaimErr) {
        logSafeError(logPrefix, 'delivery-claim-rpc', deliveryClaimErr);
      }

      if (deliveryClaim?.claimed) {
        const attemptId = deliveryClaim.attempt_id as string;
        const deliveryToken = deliveryClaim.claim_token as string;

        // Authorize send (claiming → sending)
        const { data: sendAuth, error: sendAuthErr } = await supabase.rpc('begin_confirmation_send', {
          p_attempt_id: attemptId,
          p_claim_token: deliveryToken,
        });

        if (sendAuthErr) {
          logSafeError(logPrefix, 'begin-send-rpc', sendAuthErr);
        }

        if (sendAuth?.authorized) {
          sideEffectsMayHaveOccurred = true;
          try {
            const sendResult = await resolved.sender.sendText({ to: phone, text: lines.join('\n') });
            const wamid = sendResult?.messageId;

            if (wamid) {
              // Record Meta acceptance with WAMID (sending → accepted)
              // Retry once on DB write failure — losing the WAMID attachment creates
              // a permanently uncorrelated attempt (#197 WAMID-race contract)
              const { data: completeResult, error: completeErr } = await supabase.rpc('complete_confirmation_send', {
                p_attempt_id: attemptId,
                p_claim_token: deliveryToken,
                p_meta_message_id: wamid,
                p_accepted_at: new Date().toISOString(),
              });

              if (completeErr || !completeResult?.completed) {
                // Retry once — idempotent for same attempt/WAMID
                logSafeError(logPrefix, 'complete-send-rpc-attempt1', completeErr || completeResult);
                const { data: retryResult, error: retryErr } = await supabase.rpc('complete_confirmation_send', {
                  p_attempt_id: attemptId,
                  p_claim_token: deliveryToken,
                  p_meta_message_id: wamid,
                  p_accepted_at: new Date().toISOString(),
                });
                if (retryErr || !retryResult?.completed) {
                  logSafeError(logPrefix, 'complete-send-rpc-attempt2', retryErr || retryResult);
                  // #197: Automatic WAMID recovery via recover_wamid_attachment RPC.
                  // Uses the same advisory-lock + atomic drain semantics as complete_confirmation_send.
                  // Does NOT bypass the approved DB authority or skip unmatched-callback drain.
                  const { data: recoveryResult, error: recoveryErr } = await supabase.rpc('recover_wamid_attachment', {
                    p_attempt_id: attemptId,
                    p_meta_message_id: wamid,
                    p_accepted_at: new Date().toISOString(),
                  });
                  if (recoveryErr || !recoveryResult?.recovered) {
                    // Truly unrecoverable — emit high-severity alert
                    logSafeError(logPrefix, 'wamid-recovery-rpc', recoveryErr || recoveryResult);
                    Sentry.captureException(
                      new Error(`WAMID attachment permanently failed: payment=${payment.id} wamid=${wamid}`),
                      { tags: { component: 'send-confirmation', operation: 'wamid-attach-permanent-failure' } },
                    );
                  } else {
                    logger.info(`${logPrefix} WAMID recovery succeeded for payment ${payment.id} (already_attached=${recoveryResult.already_attached})`);
                  }
                }
              }
            } else {
              // No WAMID returned but no error thrown — indeterminate
              await supabase.rpc('fail_confirmation_send', {
                p_attempt_id: attemptId,
                p_claim_token: deliveryToken,
                p_failure_type: 'indeterminate',
                p_failure_reason: 'no_wamid_in_response',
              });
              Sentry.captureException(
                new Error(`Confirmation send returned no WAMID for payment ${payment.id}`),
                { tags: { component: 'send-confirmation', operation: 'indeterminate-no-wamid' } },
              );
            }
          } catch (sendErr) {
            sideEffectsMayHaveOccurred = true;
            // #197: Only explicit provider rejection (Meta error response with code/title)
            // can be known 'failed'. All ambiguous transport/network errors (timeout,
            // ECONNRESET, fetch failed, DNS, TLS, abort) must be 'indeterminate' because
            // Meta may have accepted the request despite the local failure.
            const sendErrorDescription = sendErr instanceof Error ? sendErr.message : String(sendErr);
            // #197: Only explicit provider rejection (Meta 4xx error response) can be
            // known 'failed'. 5xx/transport/timeout/DNS/ECONNRESET = indeterminate
            // because Meta may have accepted the request despite the local failure.
            const { MetaApiError } = await import('@/lib/channels/meta-api-error');
            const isExplicitProviderRejection = sendErr instanceof MetaApiError && sendErr.httpStatus < 500;
            const failureType = isExplicitProviderRejection ? 'failed' : 'indeterminate';

            await supabase.rpc('fail_confirmation_send', {
              p_attempt_id: attemptId,
              p_claim_token: deliveryToken,
              p_failure_type: failureType,
              p_failure_reason: sendErrorDescription.slice(0, 500),
            });
            if (failureType === 'indeterminate') {
              Sentry.captureException(sendErr, { tags: { component: 'send-confirmation', operation: 'indeterminate-send-error' } });
            }
          }
        }
        // else: send not authorized (expired claim) — skip customer send
      } else if (deliveryClaim?.reason === 'already_delivered') {
        logger.info(`${logPrefix} Customer message already delivered for payment ${payment.id}`);
      } else if (deliveryClaim?.reason?.startsWith('active_delivery_')) {
        // sending/accepted/sent/indeterminate exists — DO NOT resend
        logger.info(`${logPrefix} Active delivery exists (${deliveryClaim.reason}) for payment ${payment.id} — skipping resend`);
      } else if (deliveryClaim?.reason === 'max_attempts_exceeded') {
        // Delivery exhausted — customer delivery terminally failed
        // Allow Stage-3 to complete remaining safe work and finalize master claim
        logger.warn(`${logPrefix} Customer delivery exhausted (max attempts) for payment ${payment.id}`);
      }
    } else {
      logger.info(`${logPrefix} No WhatsApp channel resolved — will attempt email-only confirmation`);
    }

    // ── Renew ownership before post-completion mutations ──
    const prePostCompletion = await renewConfirmationClaim(supabase, payment.id, claimToken, logPrefix);
    if (!prePostCompletion.ok) {
      logger.warn(`${logPrefix} Ownership lost before post-completion: ${prePostCompletion.reason}`);
      return { status: 'processing', retryable: true };
    }

    // ── 6. Post-completion (loyalty, feedback, referral, customer profile) ──
    sideEffectsMayHaveOccurred = true; // loyalty points, referral codes, feedback — non-idempotent
    if (customerPhone) {
      try {
        const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
        const customerName = await getCustomerName(supabase, customerPhone);
        // Orders: amountPaid=0 (existing ACC-008 behavior, unchanged by #161).
        // Bookings/Reservations: real payment.amount for receipts/loyalty + skipCustomerSpend
        // because Stage 2 owns durable spend via apply_payment_spend_once.
        const isOrderPayment = !!payment.order_id;
        const isBookingPayment = !!payment.booking_id;
        const isReservationPayment = !!payment.reservation_id;
        const isCampaignPayment = !!payment.campaign_id;
        const isInvoicePayment = !!payment.invoice_id;
        // #167: Two-dimensional Giving classifier (fail-closed for ambiguous payment)
        const isPaymentFamily = bookingFlowType === 'payment';
        const isGivingPayment = isPaymentFamily && bookingServiceType === 'giving';
        const isAmbiguousPayment = isPaymentFamily && bookingServiceType !== 'booking' && bookingServiceType !== 'giving';
        if (isAmbiguousPayment) {
          logger.warn(`${logPrefix} Ambiguous payment classification: flow_type=payment, service_type=${bookingServiceType ?? 'null'}, booking_id=${payment.booking_id}`);
        }
        await handlePostCompletion({
          supabase, businessId, customerPhone, customerName,
          paymentId: payment.id,
          claimToken: manifestInitialized ? claimToken : undefined,
          // Entity-correct serviceType: reservation uses booking semantics (#173)
          serviceType: (isBookingPayment || isReservationPayment) ? 'booking' : 'order',
          referenceId: payment.booking_id || payment.reservation_id || undefined,
          sender: resolved?.sender,
          amountPaid: isOrderPayment ? 0 : payment.amount,
          // Skip automation for entities that don't have booking/order semantics (#173)
          skipAutomation: isOrderPayment || isCampaignPayment || isInvoicePayment,
          // Only booking/reservation: suppress legacy additive spend (Stage 2 owns it).
          // Orders: do NOT set skipCustomerSpend — existing amountPaid=0 behavior is unchanged.
          skipCustomerSpend: isBookingPayment || isReservationPayment,
          // #167: Direct Giving skips loyalty; ambiguous payment-family fails closed
          skipLoyalty: isGivingPayment || isAmbiguousPayment,
          serviceName, referenceCode,
        });
      } catch (pcErr) {
        logSafeError(logPrefix, 'post-completion', pcErr);
        Sentry.captureException(pcErr, { tags: { component: 'send-confirmation', operation: 'post-completion' } });
      }
    }

    // Post-completion internal effects (loyalty, CRM visit, referral, etc.) are driven
    // by exactly-once RPCs inside handlePostCompletion. The manifest completion for these
    // is atomically coupled: apply_payment_loyalty_once succeeds → loyalty_award is completed
    // in the manifest by post-completion.ts after the RPC returns.
    // Other internal effects (membership, feedback, automation, receipt) are tracked after
    // their actual mutations in post-completion.ts.

    // ── CHECKPOINT 3: Renew before owner notifications and email ──
    const preOwnerNotify = await renewConfirmationClaim(supabase, payment.id, claimToken, logPrefix);
    if (!preOwnerNotify.ok) {
      logger.warn(`${logPrefix} Ownership lost before owner notify: ${preOwnerNotify.reason}`);
      return { status: 'processing', retryable: true };
    }

    // ── 7. Owner notification ──
    // For manifest-initialized payments: each channel runs inside its lifecycle driver.
    // For legacy payments: original code runs unchanged (preserving mock test behavior).
    sideEffectsMayHaveOccurred = true; // owner WhatsApp + email
    if (manifestInitialized) {
      // ── MANIFEST PATH: real effects inside lifecycle drivers ──
      try {
        const te = await import('@/lib/payments/terminal-effects');
        const { data: ownerNotifBooking } = payment.booking_id
          ? await supabase.from('bookings').select('date, time, party_size, guest_name, flow_type, services(name)').eq('id', payment.booking_id).single()
          : { data: null };

        // 7a. owner_notif_inapp — REAL INSERT inside lifecycle
        await te.driveInternalEffect(supabase, payment.id, 'owner_notif_inapp', claimToken, async () => {
          if (payment.booking_id && ownerNotifBooking?.flow_type === 'payment') {
            const svc = ownerNotifBooking.services as unknown as { name: string } | null;
            await supabase.from('notifications').insert({ business_id: businessId, booking_id: payment.booking_id, type: 'payment', channel: 'whatsapp',
              body: `Payment received: ${svc?.name || 'Payment'} ${referenceCode}. Amount: ${formatCurrency(payment.amount, countryCode)}`, status: 'delivered', delivered_at: new Date().toISOString() });
          } else if (payment.reservation_id && !payment.booking_id) {
            const { createNotification } = await import('@/lib/bot/flows/shared/notifications');
            await createNotification(supabase, { businessId, type: 'booking_confirmation', channel: 'whatsapp', body: `Reservation confirmed (paid): ${serviceName} ${referenceCode}. Amount: ${formatCurrency(payment.amount, countryCode)}` });
          } else if (payment.campaign_id) {
            const { data: don } = await supabase.from('campaign_donations').select('donor_name, reference_code, campaigns(title)').eq('payment_id', payment.id).eq('status', 'success').maybeSingle();
            const ct = (don?.campaigns as unknown as { title: string } | null)?.title || 'Campaign';
            const { createNotification } = await import('@/lib/bot/flows/shared/notifications');
            await createNotification(supabase, { businessId, type: 'payment', channel: 'whatsapp', body: `New donation of ${formatCurrency(payment.amount, countryCode)} for ${ct}${don?.donor_name ? ` from ${don.donor_name}` : ''}. Ref: ${don?.reference_code || referenceCode}` });
          }
        });

        // 7b. owner_notif_whatsapp — REAL notifyOwner* inside emission fence
        await te.driveExternalEffect(supabase, payment.id, 'owner_notif_whatsapp', claimToken, async () => {
          if (!resolved) return false;
          if (payment.booking_id && ownerNotifBooking) {
            if (ownerNotifBooking.flow_type === 'payment') {
              const svc = ownerNotifBooking.services as unknown as { name: string } | null;
              const { notifyOwnerNewPayment } = await import('@/lib/bot/flows/shared/notify-owner');
              await notifyOwnerNewPayment({ supabase, sender: resolved.sender, businessId, businessName, countryCode, referenceCode, customerName: ownerNotifBooking.guest_name || 'Customer', amount: payment.amount, categoryName: svc?.name || 'Payment' });
            } else {
              const { notifyOwnerNewBooking } = await import('@/lib/bot/flows/shared/notify-owner');
              await notifyOwnerNewBooking({ supabase, sender: resolved.sender, businessId, businessName, countryCode, referenceCode, customerName: ownerNotifBooking.guest_name || 'Customer', date: ownerNotifBooking.date, time: ownerNotifBooking.time, quantity: ownerNotifBooking.party_size || 1, quantityLabel: 'guest(s)', amount: payment.amount });
            }
          } else if (payment.reservation_id && !payment.booking_id) {
            const { data: res } = await supabase.from('reservations').select('guest_name, check_in, check_out, guest_count').eq('id', payment.reservation_id).single();
            if (res) { const ci = new Date(res.check_in + 'T00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short' }); const co = new Date(res.check_out + 'T00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short' }); const { notifyOwnerNewBooking } = await import('@/lib/bot/flows/shared/notify-owner'); await notifyOwnerNewBooking({ supabase, sender: resolved.sender, businessId, businessName, countryCode, referenceCode, customerName: res.guest_name || 'Guest', date: ci, time: `→ ${co}`, quantity: res.guest_count || 1, quantityLabel: 'guest(s)', amount: payment.amount }); }
          } else if (payment.invoice_id) {
            const { data: inv } = await supabase.from('invoices').select('reference_code, customer_name').eq('id', payment.invoice_id).single();
            if (inv) { const { notifyOwnerNewInvoicePayment } = await import('@/lib/bot/flows/shared/notify-owner'); await notifyOwnerNewInvoicePayment({ supabase, sender: resolved.sender, businessId, businessName, countryCode, referenceCode: inv.reference_code || referenceCode, customerName: inv.customer_name || 'Customer', amount: payment.amount, invoiceNumber: inv.reference_code || referenceCode }); }
          } else if (payment.campaign_id) {
            const { data: don } = await supabase.from('campaign_donations').select('donor_name, reference_code, campaigns(title)').eq('payment_id', payment.id).eq('status', 'success').maybeSingle();
            const ct = (don?.campaigns as unknown as { title: string } | null)?.title || 'Campaign';
            const { notifyOwnerNewDonation } = await import('@/lib/bot/flows/shared/notify-owner');
            await notifyOwnerNewDonation({ supabase, sender: resolved.sender, businessId, businessName, countryCode, referenceCode: don?.reference_code || referenceCode, donorName: don?.donor_name || null, amount: payment.amount, campaignTitle: ct });
          } else if (payment.order_id) {
            const { data: ord } = await supabase.from('orders').select('reference_code, delivery_name, delivery_address, order_items(product_name, variant_label, quantity, unit_price)').eq('id', payment.order_id).single();
            if (ord) { const its = ((ord.order_items || []) as Array<{ product_name: string; variant_label?: string; quantity: number; unit_price: number }>).map(i => ({ name: i.variant_label ? `${i.product_name} (${i.variant_label})` : i.product_name, quantity: i.quantity, price: i.unit_price * i.quantity })); const { notifyOwnerNewOrder } = await import('@/lib/bot/flows/shared/notify-owner'); await notifyOwnerNewOrder({ supabase, sender: resolved.sender, businessId, businessName, countryCode, referenceCode: ord.reference_code || referenceCode, customerName: ord.delivery_name || 'Customer', items: its, totalAmount: payment.amount, deliveryAddress: ord.delivery_address || undefined }); }
          }
          return true;
        });

        // 7c. owner_notif_email — REAL sendEmail inside emission fence
        await te.driveExternalEffect(supabase, payment.id, 'owner_notif_email', claimToken, async () => {
          const { data: biz } = await supabase.from('businesses').select('owner_id').eq('id', businessId).single();
          if (biz?.owner_id) {
            const { data: ownerProfile } = await supabase.from('profiles').select('email').eq('id', biz.owner_id).single();
            if (ownerProfile?.email) {
              const { sendEmail } = await import('@/lib/email/client');
              const { paymentReceivedEmail } = await import('@/lib/email/templates');
              await sendEmail({ to: ownerProfile.email, ...paymentReceivedEmail(businessName, formatCurrency(payment.amount, countryCode), serviceName) });
            }
          }
          return true;
        });
      } catch (err) { logSafeError(logPrefix, 'owner-notification-manifest', err); }
    } else {
      // ── LEGACY PATH: original section 7 code unchanged for mock test compatibility ──
      try {
        if (payment.booking_id) {
          const { data: ownerNotifBooking } = await supabase.from('bookings')
            .select('date, time, party_size, guest_name, flow_type, services(name)')
            .eq('id', payment.booking_id).single();

          if (ownerNotifBooking && ownerNotifBooking.flow_type === 'payment') {
            const svc = ownerNotifBooking.services as unknown as { name: string } | null;
            try {
              const { error: notifErr } = await supabase.from('notifications').insert({
                business_id: businessId, booking_id: payment.booking_id, type: 'payment', channel: 'whatsapp',
                body: `Payment received: ${svc?.name || 'Payment'} ${referenceCode}. Amount: ${formatCurrency(payment.amount, countryCode)}`,
                status: 'delivered', delivered_at: new Date().toISOString(),
              });
              if (notifErr) logSafeError(logPrefix, 'payment-in-app-notification-insert', notifErr);
            } catch (notifEx) { logSafeError(logPrefix, 'payment-in-app-notification', notifEx); }

            if (resolved) {
              const { notifyOwnerNewPayment } = await import('@/lib/bot/flows/shared/notify-owner');
              await notifyOwnerNewPayment({ supabase, sender: resolved.sender, businessId, businessName, countryCode,
                referenceCode, customerName: ownerNotifBooking.guest_name || 'Customer', amount: payment.amount, categoryName: svc?.name || 'Payment' });
            }
          } else if (ownerNotifBooking && resolved) {
            const { notifyOwnerNewBooking } = await import('@/lib/bot/flows/shared/notify-owner');
            await notifyOwnerNewBooking({ supabase, sender: resolved.sender, businessId, businessName, countryCode,
              referenceCode, customerName: ownerNotifBooking.guest_name || 'Customer',
              date: ownerNotifBooking.date, time: ownerNotifBooking.time,
              quantity: ownerNotifBooking.party_size || 1, quantityLabel: 'guest(s)', amount: payment.amount });
          }
        }
        if (payment.reservation_id && !payment.booking_id && resolved) {
          const { notifyOwnerNewBooking } = await import('@/lib/bot/flows/shared/notify-owner');
          const { data: reservation } = await supabase.from('reservations').select('guest_name, check_in, check_out, guest_count').eq('id', payment.reservation_id).single();
          if (reservation) {
            const checkIn = new Date(reservation.check_in + 'T00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
            const checkOut = new Date(reservation.check_out + 'T00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
            await notifyOwnerNewBooking({ supabase, sender: resolved.sender, businessId, businessName, countryCode, referenceCode, customerName: reservation.guest_name || 'Guest', date: checkIn, time: `→ ${checkOut}`, quantity: reservation.guest_count || 1, quantityLabel: 'guest(s)', amount: payment.amount });
          }
          const { createNotification } = await import('@/lib/bot/flows/shared/notifications');
          createNotification(supabase, { businessId, type: 'booking_confirmation', channel: 'whatsapp', body: `Reservation confirmed (paid): ${serviceName} ${referenceCode}. Amount: ${formatCurrency(payment.amount, countryCode)}` }).catch(err => logSafeError(logPrefix, 'reservation-in-app-notification', err));
        }
        if (payment.invoice_id && resolved) {
          const { notifyOwnerNewInvoicePayment } = await import('@/lib/bot/flows/shared/notify-owner');
          const { data: invoice } = await supabase.from('invoices').select('reference_code, customer_name, customer_phone').eq('id', payment.invoice_id).single();
          if (invoice) { notifyOwnerNewInvoicePayment({ supabase, sender: resolved.sender, businessId, businessName, countryCode, referenceCode: invoice.reference_code || referenceCode, customerName: invoice.customer_name || 'Customer', amount: payment.amount, invoiceNumber: invoice.reference_code || referenceCode }).catch(err => logSafeError(logPrefix, 'invoice-owner-notify', err)); }
        }
        if (payment.campaign_id && resolved) {
          const { notifyOwnerNewDonation } = await import('@/lib/bot/flows/shared/notify-owner');
          const { data: donation } = await supabase.from('campaign_donations').select('donor_name, reference_code, campaigns(title)').eq('payment_id', payment.id).eq('status', 'success').maybeSingle();
          const campaignTitle = (donation?.campaigns as unknown as { title: string } | null)?.title || 'Campaign';
          notifyOwnerNewDonation({ supabase, sender: resolved.sender, businessId, businessName, countryCode, referenceCode: donation?.reference_code || referenceCode, donorName: donation?.donor_name || null, amount: payment.amount, campaignTitle }).catch(err => logSafeError(logPrefix, 'donation-owner-notify', err));
          const { createNotification } = await import('@/lib/bot/flows/shared/notifications');
          createNotification(supabase, { businessId, type: 'payment', channel: 'whatsapp', body: `New donation of ${formatCurrency(payment.amount, countryCode)} for ${campaignTitle}${donation?.donor_name ? ` from ${donation.donor_name}` : ''}. Ref: ${donation?.reference_code || referenceCode}` }).catch(err => logSafeError(logPrefix, 'campaign-in-app-notification', err));
        }
        if (payment.order_id && resolved) {
          const { notifyOwnerNewOrder } = await import('@/lib/bot/flows/shared/notify-owner');
          const { data: order } = await supabase.from('orders').select('reference_code, delivery_name, delivery_address, order_items(product_name, variant_label, quantity, unit_price)').eq('id', payment.order_id).single();
          if (order) {
            const items = ((order.order_items || []) as Array<{ product_name: string; variant_label?: string; quantity: number; unit_price: number }>).map(i => ({ name: i.variant_label ? `${i.product_name} (${i.variant_label})` : i.product_name, quantity: i.quantity, price: i.unit_price * i.quantity }));
            notifyOwnerNewOrder({ supabase, sender: resolved.sender, businessId, businessName, countryCode, referenceCode: order.reference_code || referenceCode, customerName: order.delivery_name || 'Customer', items, totalAmount: payment.amount, deliveryAddress: order.delivery_address || undefined }).catch(err => logSafeError(logPrefix, 'order-owner-notify', err));
          }
        }
        try {
          const { data: biz } = await supabase.from('businesses').select('owner_id').eq('id', businessId).single();
          if (biz?.owner_id) {
            const { data: ownerProfile } = await supabase.from('profiles').select('email').eq('id', biz.owner_id).single();
            if (ownerProfile?.email) {
              const { sendEmail } = await import('@/lib/email/client');
              const { paymentReceivedEmail } = await import('@/lib/email/templates');
              await sendEmail({ to: ownerProfile.email, ...paymentReceivedEmail(businessName, formatCurrency(payment.amount, countryCode), serviceName) });
            }
          }
        } catch (emailErr) { logSafeError(logPrefix, 'owner-email', emailErr); }
      } catch (notifyErr) { logSafeError(logPrefix, 'owner-notification', notifyErr); }
    }

    // ── CHECKPOINT 4: Renew before tickets, customer emails, donation receipt ──
    const preTickets = await renewConfirmationClaim(supabase, payment.id, claimToken, logPrefix);
    if (!preTickets.ok) {
      logger.warn(`${logPrefix} Ownership lost before tickets/emails: ${preTickets.reason}`);
      return { status: 'processing', retryable: true };
    }
    sideEffectsMayHaveOccurred = true; // tickets, customer email, donation receipt

    // ── 8. Ticketing bookings: finalize inventory, create ticket rows, deliver ──
    // Sequence: inventory finalization → canonical ticket rows → delivery
    // Inventory finalization and ticket rows must succeed before confirmation is marked complete.
    let ticketStateComplete = true; // non-ticketing bookings are "complete" by default
    try {
      if (payment.booking_id) {
        const { data: ticketBooking, error: ticketBookingError } = await supabase
          .from('bookings')
          .select('flow_type, event_id, bot_session_id, date, time, party_size, guest_name, guest_phone, guest_email, notes')
          .eq('id', payment.booking_id)
          .single();

        // BLOCKER 2: booking lookup error → fail closed
        if (ticketBookingError) {
          logSafeError(logPrefix, 'ticket-booking-lookup', ticketBookingError);
          ticketStateComplete = false;
        } else if (ticketBooking?.flow_type === 'ticketing' && ticketBooking.event_id) {
          ticketStateComplete = false; // must be proven complete
          const ticketQty = ticketBooking.party_size || 1;

          // ── 8a. Determine if event is typed (has event_ticket_types) ──
          // Query ALL types (not just active) — a type purchased before deactivation is still valid
          const { data: ticketTypes, error: typeQueryError } = await supabase
            .from('event_ticket_types')
            .select('id')
            .eq('event_id', ticketBooking.event_id)
            .limit(1);

          // BLOCKER 1: type query error → fail closed (don't treat as untyped)
          if (typeQueryError) {
            logSafeError(logPrefix, 'ticket-type-query', typeQueryError);
            // ticketStateComplete stays false → retryable
          } else {
            const isTypedEvent = (ticketTypes?.length ?? 0) > 0;

            // ── 8b. Resolve ticket_type_id from EXACT originating bot session ──
            let ticketTypeId: string | null = null;
            let typeResolutionFailed = false;
            if (ticketBooking.bot_session_id) {
              const { data: originSession, error: sessionError } = await supabase
                .from('bot_sessions')
                .select('session_data')
                .eq('id', ticketBooking.bot_session_id)
                .single();
              if (sessionError) {
                logSafeError(logPrefix, 'ticket-type-session-lookup', sessionError);
                typeResolutionFailed = true;
              } else {
                ticketTypeId = (originSession?.session_data as Record<string, unknown>)?.ticket_type_id as string || null;
              }
            } else if (isTypedEvent) {
              typeResolutionFailed = true;
            }

            // ── 8c. For typed events, validate ticket_type_id belongs to this event ──
            if (isTypedEvent && ticketTypeId && !typeResolutionFailed) {
              const { data: typeOwnership, error: ownershipError } = await supabase
                .from('event_ticket_types')
                .select('id')
                .eq('id', ticketTypeId)
                .eq('event_id', ticketBooking.event_id)
                .maybeSingle();
              if (ownershipError || !typeOwnership) {
                logger.error(`${logPrefix} ticket_type_id ${ticketTypeId} does not belong to event ${ticketBooking.event_id}`);
                typeResolutionFailed = true;
              }
            }

            if (isTypedEvent && (!ticketTypeId || typeResolutionFailed)) {
              logger.error(`${logPrefix} Typed event ${ticketBooking.event_id} — cannot resolve ticket_type_id, failing closed`);
              // ticketStateComplete stays false
            } else {
              const ticketModule = await import('@/lib/bot/flows/shared/send-tickets');
              const finalizeInventory = async () => {
                const { data: finResult, error: finError } = await supabase.rpc('finalize_free_ticket_booking', {
                  p_booking_id: payment.booking_id,
                  p_event_id: ticketBooking.event_id,
                  p_ticket_type_id: ticketTypeId,
                  p_quantity: ticketQty,
                });
                if (finError || finResult?.success !== true) {
                  throw new Error(`ticket_counter_finalize_failed:${finError?.message || finResult?.reason || 'unknown'}`);
                }
              };

              if (manifestInitialized) {
                const te = await import('@/lib/payments/terminal-effects');
                const inventoryEffect = await te.driveInternalEffect(
                  supabase, payment.id, 'ticket_inventory_finalization', claimToken, finalizeInventory,
                );
                if (!inventoryEffect.ok) throw new Error(inventoryEffect.error);
              } else {
                await finalizeInventory();
              }

              const { data: event, error: eventError } = await supabase
                .from('events')
                .select('id, name, date, time, venue')
                .eq('id', ticketBooking.event_id)
                .single();
              if (eventError) throw new Error(`ticket_event_lookup_failed:${eventError.message}`);

              const ticketOptions = {
                supabase,
                sender: resolved?.sender,
                businessId,
                bookingId: payment.booking_id,
                eventId: ticketBooking.event_id,
                eventName: event?.name || ticketBooking.notes?.replace('Tickets for: ', '') || 'Event',
                eventDate: new Date((event?.date || ticketBooking.date) + 'T00:00').toLocaleDateString('en-US', {
                  weekday: 'long', day: 'numeric', month: 'long',
                }),
                eventTime: event?.time || ticketBooking.time || undefined,
                venue: event?.venue || '',
                guestName: ticketBooking.guest_name || 'Guest',
                guestPhone: ticketBooking.guest_phone || customerPhone || '',
                guestEmail: ticketBooking.guest_email || undefined,
                referenceCode,
                quantity: ticketQty,
                amount: payment.amount,
                countryCode,
              };

              let ticketResult: Awaited<ReturnType<typeof ticketModule.ensureCanonicalTicketRows>> | null = null;
              const convergeRows = async () => {
                ticketResult = await ticketModule.ensureCanonicalTicketRows(ticketOptions);
                if (!ticketResult.success || ticketResult.tickets.length !== ticketQty) {
                  throw new Error(`ticket_rows_incomplete:${ticketResult.error || ticketResult.tickets.length}`);
                }
              };
              if (manifestInitialized) {
                const te = await import('@/lib/payments/terminal-effects');
                const rowEffect = await te.driveInternalEffect(
                  supabase, payment.id, 'ticket_row_creation', claimToken, convergeRows,
                );
                if (!rowEffect.ok) throw new Error(rowEffect.error);
                if (!ticketResult) await convergeRows(); // terminal retry: authoritative row re-read/convergence

                if (resolved?.sender) {
                  const whatsappEffect = await te.driveExternalEffect(
                    supabase, payment.id, 'ticket_delivery_whatsapp', claimToken,
                    async () => {
                      await ticketModule.deliverTicketsWhatsApp({ ...ticketOptions, tickets: ticketResult!.tickets });
                      return true;
                    },
                  );
                  if (!whatsappEffect.ok) throw new Error(whatsappEffect.error);
                } else {
                  const whatsappEffect = await te.skipOptionalEffect(
                    supabase, payment.id, 'ticket_delivery_whatsapp', claimToken, 'no_resolved_whatsapp_sender',
                  );
                  if (!whatsappEffect.ok) throw new Error(whatsappEffect.error);
                }
                if (ticketBooking.guest_email) {
                  const emailEffect = await te.driveExternalEffect(
                    supabase, payment.id, 'ticket_delivery_email', claimToken,
                    async () => {
                      await ticketModule.deliverTicketsEmail({ ...ticketOptions, tickets: ticketResult!.tickets });
                      return true;
                    },
                  );
                  if (!emailEffect.ok) throw new Error(emailEffect.error);
                }
              } else {
                const legacyResult = await ticketModule.sendTicketsAfterPurchase(ticketOptions);
                ticketResult = legacyResult;
              }
              ticketStateComplete = !!ticketResult?.success && ticketResult.tickets.length === ticketQty;
            }
          }
        }
      }
    } catch (ticketErr) {
      logSafeError(logPrefix, 'ticket-send', ticketErr);
      Sentry.captureException(ticketErr, { tags: { component: 'send-confirmation', operation: 'ticket-send' } });
      ticketStateComplete = false;
    }

    // ── 8b. Send email confirmation — always send if guest has email (WhatsApp + email) ──
    if (payment.booking_id && bookingFlowType !== 'ticketing') {
      try {
        const { data: emailBooking } = await supabase
          .from('bookings')
          .select('guest_email, guest_name, date, time, party_size')
          .eq('id', payment.booking_id)
          .single();
        const guestEmail = emailBooking?.guest_email || null;
        if (guestEmail) {
          const { sendEmail } = await import('@/lib/email/client');
          const { bookingConfirmationEmail } = await import('@/lib/email/templates');
          // Generate Google Calendar URL for the email button
          let googleCalUrl: string | undefined;
          if (emailBooking?.date && emailBooking?.time) {
            const { generateGoogleCalendarUrl, buildCalendarEvent } = await import('@/lib/calendar/generate-links');
            const calEvent = buildCalendarEvent({
              businessName,
              businessAddress: bookingAddress,
              serviceName,
              referenceCode,
              date: emailBooking.date,
              time: emailBooking.time,
              durationMinutes: bookingDuration || 60,
            });
            if (calEvent) {
              googleCalUrl = generateGoogleCalendarUrl(calEvent);
            }
          }
          const emailContent = bookingConfirmationEmail({
            firstName: emailBooking?.guest_name?.split(' ')[0] || 'there',
            businessName,
            date: emailBooking?.date || '',
            time: emailBooking?.time || '',
            quantity: emailBooking?.party_size || 1,
            referenceCode,
            amount: payment.amount,
            formattedAmount: formatCurrency(payment.amount, countryCode),
            quantityLabel: 'Guest(s)',
            confirmationEmoji: '✅',
            googleCalendarUrl: googleCalUrl,
            whitelabel: isWl,
          });
          const sendBookingEmail = async () => {
            const result = await sendEmail({ to: guestEmail, ...emailContent });
            if (!result.success) throw new Error('booking_email_send_failed');
            return true;
          };
          if (manifestInitialized) {
            const te = await import('@/lib/payments/terminal-effects');
            const effect = await te.driveExternalEffect(
              supabase, payment.id, 'customer_booking_email', claimToken, sendBookingEmail,
            );
            if (!effect.ok) throw new Error(effect.error);
          } else {
            await sendBookingEmail();
          }
          logger.info(`${logPrefix} Email confirmation sent`);
        }
      } catch (emailErr) {
        logSafeError(logPrefix, 'email-confirmation', emailErr);
      }
    }

    // ── 8c. Send email receipt for campaign donations ──
    if (payment.campaign_id) {
      try {
        // Payment-scoped lookup (#173)
        const { data: donation } = await supabase
          .from('campaign_donations')
          .select('donor_name, donor_phone, reference_code, campaigns(title)')
          .eq('payment_id', payment.id)
          .eq('status', 'success')
          .maybeSingle();

        if (donation?.donor_phone) {
          // Look up donor email from profiles via phone
          const phoneP = donation.donor_phone.startsWith('+') ? donation.donor_phone : `+${donation.donor_phone}`;
          const phoneN = donation.donor_phone.startsWith('+') ? donation.donor_phone.slice(1) : donation.donor_phone;
          const { data: donorProfile } = await supabase
            .from('profiles')
            .select('email')
            .or(`phone.eq.${sanitizeFilterValue(phoneP)},phone.eq.${sanitizeFilterValue(phoneN)}`)
            .limit(1)
            .maybeSingle();

          const donorEmail = donorProfile?.email || null;
          if (donorEmail) {
            const campaignTitle = (donation.campaigns as unknown as { title: string } | null)?.title || 'Campaign';
            const { sendEmail } = await import('@/lib/email/client');
            const { donationReceiptEmail } = await import('@/lib/email/templates');
            const emailContent = donationReceiptEmail({
              donorName: donation.donor_name || 'Donor',
              businessName,
              campaignTitle,
              formattedAmount: formatCurrency(payment.amount, countryCode),
              referenceCode: donation.reference_code || referenceCode,
              whitelabel: isWl,
            });
            const sendDonationEmail = async () => {
              const result = await sendEmail({ to: donorEmail, ...emailContent });
              if (!result.success) throw new Error('donation_receipt_email_send_failed');
              return true;
            };
            if (manifestInitialized) {
              const te = await import('@/lib/payments/terminal-effects');
              const effect = await te.driveExternalEffect(
                supabase, payment.id, 'donation_receipt_email', claimToken, sendDonationEmail,
              );
              if (!effect.ok) throw new Error(effect.error);
            } else {
              await sendDonationEmail();
            }
            logger.info(`${logPrefix} Donation receipt email sent`);
          }
        }
      } catch (donationEmailErr) {
        logSafeError(logPrefix, 'donation-receipt-email', donationEmailErr);
      }
    }

    // ── Bridge the customer delivery subsystem's durable outcome ──
    // Migration 342 owns the customer WhatsApp emission fence. The manifest mirrors
    // its persisted outcome and never calls the provider a second time.
    if (manifestInitialized) {
      try {
        const te = await import('@/lib/payments/terminal-effects');
        const { data: deliveryRows, error: deliveryReadError } = await supabase
          .from('payment_confirmation_deliveries')
          .select('delivery_status')
          .eq('payment_id', payment.id);
        if (deliveryReadError) throw new Error(`customer_delivery_read_failed:${deliveryReadError.message}`);
        const statuses = (deliveryRows || []).map(row => row.delivery_status as string);
        const outcome = statuses.some(status => ['accepted', 'sent', 'delivered', 'read'].includes(status))
          ? 'completed'
          : statuses.some(status => ['sending', 'indeterminate'].includes(status))
            ? 'indeterminate'
            : 'failed';
        const bridge = await te.bridgeExternalEffect(
          supabase, payment.id, 'customer_whatsapp', claimToken, outcome, 'delivery_subsystem_terminal_state',
        );
        if (!bridge.ok) throw new Error(bridge.error);
      } catch (effectErr) {
        logger.warn(`${logPrefix} Customer delivery bridge failed:`, effectErr);
      }
    }

    // ── CHECKPOINT 5: Renew before session mutation and finalization ──
    const preFinalize = await renewConfirmationClaim(supabase, payment.id, claimToken, logPrefix);
    if (!preFinalize.ok) {
      logger.warn(`${logPrefix} Ownership lost before session/finalize: ${preFinalize.reason}`);
      return { status: 'processing', retryable: true };
    }

    // ── 9. Deactivate the payment-waiting session ──
    // The REAL session mutation happens inside the manifest lifecycle driver.
    if (manifestInitialized) {
      try {
        const te = await import('@/lib/payments/terminal-effects');
        await te.driveInternalEffect(supabase, payment.id, 'session_deactivation', claimToken, async () => {
          // REAL MUTATION inside lifecycle authority
          if (customerPhone && !exactEntityFamily) {
            await supabase
              .from('bot_sessions')
              .update({ is_active: false, current_step: 'complete' })
              .or(`whatsapp_number.eq.${stripPlus(customerPhone)},whatsapp_number.eq.+${stripPlus(customerPhone)}`)
              .eq('business_id', businessId)
              .eq('is_active', true)
              .in('current_step', ['await_invoice_payment', 'await_donation_payment']);
          }
        });
      } catch { /* non-fatal */ }
    } else {
      // Legacy path: no manifest, execute directly
      if (customerPhone && !exactEntityFamily) {
        await supabase
          .from('bot_sessions')
          .update({ is_active: false, current_step: 'complete' })
          .or(`whatsapp_number.eq.${stripPlus(customerPhone)},whatsapp_number.eq.+${stripPlus(customerPhone)}`)
          .eq('business_id', businessId)
          .eq('is_active', true)
          .in('current_step', ['await_invoice_payment', 'await_donation_payment']);
      }
    }

    // ── 10. Finalize: mark confirmation as successfully completed ──
    // #219: WhatsApp-origin missing channel — do NOT finalize (would falsely set confirmation_sent_at).
    // Release the claim so a later retry (after channel context is repaired) can succeed.
    if (whatsappOriginMissingChannel) {
      logger.warn(`${logPrefix} WhatsApp-origin missing channel — releasing claim for retry, not finalizing`);
      await releaseConfirmationClaim(supabase, payment.id, claimToken, logPrefix);
      return { status: 'retryable_failed', retryable: true, reason: 'whatsapp_origin_missing_channel' };
    }

    // For ticketing bookings, only finalize if ticket inventory + rows are complete.
    if (!ticketStateComplete) {
      logger.warn(`${logPrefix} Ticket state incomplete — not finalizing confirmation claim`);
      return { status: 'retryable_failed', retryable: true, reason: 'ticket_state_incomplete' };
    }
    const finalizeResult = await finalizeConfirmationClaim(supabase, payment.id, claimToken, logPrefix);
    if (!finalizeResult.ok) {
      return { status: 'retryable_failed', retryable: true, reason: 'confirmation_finalize_failed' };
    }

    // #165: Post-finalization recurring offer (separate lifecycle, non-blocking)
    try {
      const { checkAndOfferRecurring } = await import('@/lib/payments/recurring-offer');
      await checkAndOfferRecurring(supabase, payment, businessId, resolved?.sender || null, customerPhone || null, logPrefix);
    } catch (recurringErr) {
      // NEVER affects payment finalization
      logSafeError(logPrefix, 'recurring-offer', recurringErr);
    }

    return { status: 'completed' };

  } catch (err) {
    logSafeError(logPrefix, 'send-confirmation', err);
    Sentry.captureException(err, { tags: { component: 'send-confirmation', operation: 'send-confirmation' } });

    if (!sideEffectsMayHaveOccurred) {
      await releaseConfirmationClaim(supabase, payment.id, claimToken, logPrefix);
    } else {
      logger.warn(`${logPrefix} External sends occurred — leaving claim for stale recovery, not releasing`);
    }
    return { status: 'retryable_failed', retryable: true, reason: 'send_confirmation_error' };
  }

  } catch (outerErr) {
    logSafeError(logPrefix, 'confirmation-outer', outerErr);
    Sentry.captureException(outerErr, { tags: { component: 'send-confirmation', operation: 'confirmation-outer' } });

    if (!sideEffectsMayHaveOccurred) {
      await releaseConfirmationClaim(supabase, payment.id, claimToken, logPrefix);
    } else {
      logger.warn(`${logPrefix} Side effects may have occurred — leaving claim for stale recovery, not releasing`);
    }
    return { status: 'retryable_failed', retryable: true, reason: 'confirmation_outer_error' };
  }
}

import type { SupabaseClient } from '@supabase/supabase-js';
import { type SubscriptionTier, type CountryCode, type PaymentGatewayName } from '@/lib/constants';
import { getPlatformFees } from '@/lib/getPlatformFees';
import { getPaymentGateway, getPaymentGatewayByName } from '@/lib/payments/factory';
import { observe } from '@/lib/observability';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';
import { resolveTrialStatus } from '@/lib/trial-status';

export async function initializePayment(
  supabase: SupabaseClient,
  opts: {
    bookingId?: string;
    orderId?: string;
    invoiceId?: string;
    reservationId?: string;
    userId: string;
    amount: number;
    referenceCode: string;
    businessName: string;
    phone: string;
    userEmail?: string;
    countryCode?: CountryCode;
    /** Per-business gateway override (from businesses.payment_gateway) */
    gatewayOverride?: string | null;
    /** Business ID for split payment lookup */
    businessId?: string;
    /** Campaign ID for donation tracking */
    campaignId?: string;
    /** Donor name for campaign donations */
    donorName?: string;
    /** #219: Exact inbound WhatsApp channel ID for post-payment confirmation routing */
    inboundChannelId?: string;
    /** #219: Interaction origin — determines confirmation delivery behavior */
    confirmationOrigin?: 'whatsapp' | 'web';
    /** #264: Server-derived transaction category for fee policy */
    transactionCategory?: string;
  },
): Promise<{ url: string; reference: string } | null> {
  try {
    // #219: WhatsApp-originated payment MUST have a proven current origin channel
    // before checkout is returned. Without it, post-payment confirmation cannot
    // reach the customer on the correct WhatsApp number.
    if (opts.confirmationOrigin === 'whatsapp' && !opts.inboundChannelId) {
      logger.warn('[PAYMENT] WhatsApp-origin payment blocked — no current inbound channel');
      return null;
    }

    // #264: Fail closed on conflicting entity IDs
    const entityIds = [opts.bookingId, opts.orderId, opts.invoiceId, opts.reservationId, opts.campaignId].filter(Boolean);
    if (entityIds.length > 1) {
      logger.error('[PAYMENT] Conflicting entity IDs — blocking payment', {
        bookingId: opts.bookingId, orderId: opts.orderId, invoiceId: opts.invoiceId,
        reservationId: opts.reservationId, campaignId: opts.campaignId,
      });
      return null;
    }

    const countryCode = opts.countryCode || 'NG';

    // Per-business gateway override takes priority
    const gateway = opts.gatewayOverride
      ? getPaymentGatewayByName(opts.gatewayOverride as PaymentGatewayName)
      : getPaymentGateway(countryCode);

    const { getCountry } = await import('@/lib/countries');
    const currencyCode = getCountry(countryCode)?.currency_code ?? 'NGN';

    // ── Idempotent reuse: check for an existing pending payment for this entity.
    // Fail closed: if the lookup itself fails, do NOT proceed to the provider —
    // creating a duplicate provider transaction is worse than a transient failure. ──
    const entityId = opts.bookingId || opts.orderId || opts.invoiceId || opts.reservationId;
    if (entityId) {
      const entityCol = opts.bookingId ? 'booking_id' : opts.orderId ? 'order_id' : opts.invoiceId ? 'invoice_id' : 'reservation_id';
      try {
        // ── Step 1: Quarantine guard (FIRST — wins over pending reuse) ──
        // If provider already collected money and the payment is under review,
        // block new charges regardless of ordinary payment status.
        const { data: quarantined, error: quarantineError } = await supabase
          .from('payments')
          .select('id, gateway_status')
          .eq(entityCol, entityId)
          .like('gateway_status', 'review_required:%')
          .limit(1)
          .maybeSingle();

        if (quarantineError) {
          logger.withContext({ op: 'payment.quarantine-lookup', ...safeLogErrorContext(quarantineError) })
            .error('[PAYMENT] Quarantine lookup failed — aborting to prevent duplicate provider transaction');
          return null;
        }
        if (quarantined) {
          logger.warn('[PAYMENT] Provider-paid quarantined payment exists for ' + entityCol + '=' + entityId + ' — blocking new charge');
          return null;
        }

        // ── Step 2: Pending payment reuse ──
        const { data: existingPayment, error: lookupError } = await supabase
          .from('payments')
          .select('id, gateway_reference, amount, currency, gateway, metadata')
          .eq(entityCol, entityId)
          .eq('status', 'pending')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (lookupError) {
          logger.withContext({ op: 'payment.reuse-lookup', ...safeLogErrorContext(lookupError) })
            .error('[PAYMENT] Pending payment lookup failed — aborting to prevent duplicate provider transaction');
          return null;
        }

        if (
          existingPayment
          && existingPayment.amount === opts.amount
          && existingPayment.currency === currencyCode
          && existingPayment.gateway === gateway.name
        ) {
          const meta = (existingPayment.metadata || {}) as Record<string, unknown>;
          const checkoutUrl = meta.checkout_url as string | undefined;
          if (checkoutUrl && existingPayment.gateway_reference) {
            logger.info('[PAYMENT] Reusing existing pending payment for ' + entityCol + '=' + entityId);
            // #219: Update channel context on reuse — customer may be retrying from a different channel.
            // For WhatsApp-originated reuse, channel persistence is required — fail closed if write fails.
            if (opts.inboundChannelId || opts.confirmationOrigin) {
              const reuseMeta = { ...meta };
              if (opts.inboundChannelId) reuseMeta._inbound_channel_id = opts.inboundChannelId;
              if (opts.confirmationOrigin) reuseMeta._confirmation_origin = opts.confirmationOrigin;
              const { error: reuseUpdateErr } = await supabase.from('payments').update({ metadata: reuseMeta }).eq('id', existingPayment.id);
              if (reuseUpdateErr && opts.confirmationOrigin === 'whatsapp') {
                logger.withContext({ op: 'payment.reuse-channel-persist', ...safeLogErrorContext(reuseUpdateErr) })
                  .error('[PAYMENT] WhatsApp channel persistence failed on checkout reuse — blocking');
                return null;
              }
            }
            const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
            const shortRef = existingPayment.gateway_reference.slice(-8);
            return { url: `${appUrl}/api/pay?ref=${shortRef}`, reference: existingPayment.gateway_reference };
          }
          // Matching pending payment exists but has no usable checkout URL — provider may have
          // accepted a transaction whose identity persistence failed. Do NOT create another charge.
          if (existingPayment.gateway_reference) {
            logger.warn('[PAYMENT] Matching pending payment without checkout URL for ' + entityCol + '=' + entityId + ' — blocking new charge');
            return null;
          }
        }
      } catch (lookupErr) {
        logger.withContext({ op: 'payment.reuse-lookup-throw', ...safeLogErrorContext(lookupErr) })
          .error('[PAYMENT] Payment guard lookup threw — aborting to prevent duplicate provider transaction');
        return null;
      }
    }

    // ── V1 dispatched recovery: if an existing v1 row is stuck in 'dispatched',
    // do NOT create a new row or blindly re-dispatch. The provider may have
    // accepted the charge. Return null to prevent double-charge.
    // The reconciliation cron handles verify-first recovery for dispatched rows.
    if (entityId && opts.transactionCategory) {
      const entityCol = opts.bookingId ? 'booking_id' : opts.orderId ? 'order_id' : opts.invoiceId ? 'invoice_id' : 'reservation_id';
      const { data: dispatchedRow, error: dispatchLookupErr } = await supabase
        .from('payments')
        .select('id, provider_init_state, gateway_reference')
        .eq(entityCol, entityId)
        .eq('fee_policy_version', 1)
        .eq('provider_init_state', 'dispatched')
        .eq('status', 'pending')
        .maybeSingle();
      if (dispatchLookupErr) {
        logger.error('[PAYMENT] Dispatched-row lookup error — fail closed', { dispatchLookupErr });
        return null;
      }
      if (dispatchedRow) {
        logger.warn('[PAYMENT] V1 dispatched row exists — blocking re-dispatch, needs verify-first recovery', {
          paymentId: dispatchedRow.id, entityCol, entityId,
        });
        return null;
      }
    }

    // Fetch payout account for split payments
    let subaccountCode: string | undefined;
    let stripeAccountId: string | undefined;
    let squareMerchantId: string | undefined;
    let squareAccessToken: string | undefined;
    let platformFeeAmount: number | undefined;

    // BYO credential fields
    let byoSecretKey: string | undefined;
    let byoPlatformSubaccount: string | undefined;
    let isByo = false;
    let byoBusinessId: string | undefined;
    let connectAccountId: string | undefined;
    let providerConnectionId: string | undefined;
    let payoutAccountId: string | undefined;

    if (opts.businessId) {
      // Check for BYO (Bring Your Own) gateway credentials first
      const { data: byoCreds } = await supabase
        .from('business_payment_credentials')
        .select('id, secret_key, platform_subaccount_code, gateway, connect_account_id, connection_type')
        .eq('business_id', opts.businessId)
        .eq('is_active', true)
        .not('verified_at', 'is', null)
        .maybeSingle();

      if (byoCreds?.platform_subaccount_code && !byoCreds?.secret_key) {
        // Subaccount-based connect: platform key + subaccount split
        // (connect_account_id may also be set to satisfy DB constraint, but we use subaccount split)
        subaccountCode = byoCreds.platform_subaccount_code;

        const { data: business, error: bizError } = await supabase
          .from('businesses')
          .select('subscription_tier, trial_ends_at, custom_fee_percentage, custom_fee_flat')
          .eq('id', opts.businessId)
          .single();

        if (bizError) {
          logger.withContext({ op: 'payment.subaccount-split-fetch', ...safeLogErrorContext(bizError) }).error('[PAYMENT] Failed to fetch business for subaccount split');
        }

        if (business) {
          const tier = (business.subscription_tier || 'free') as SubscriptionTier;
          const isInTrial = await resolveTrialStatus(supabase, opts.businessId, tier, business.trial_ends_at);
          const { getPlatformFees } = await import('@/lib/getPlatformFees');
          const feeResult = await getPlatformFees(opts.amount, tier, isInTrial, {
            feePercentage: business.custom_fee_percentage ?? undefined,
            feeFlat: business.custom_fee_flat ?? undefined,
          });
          platformFeeAmount = feeResult.feeTotal;
        }
      } else if (byoCreds?.connect_account_id && !byoCreds?.platform_subaccount_code) {
        // True Connect mode: use platform key + X-Connect-Account header
        connectAccountId = byoCreds.connect_account_id;
        byoBusinessId = opts.businessId;
        providerConnectionId = byoCreds.id;

        const { data: business, error: bizError2 } = await supabase
          .from('businesses')
          .select('subscription_tier, trial_ends_at, custom_fee_percentage, custom_fee_flat')
          .eq('id', opts.businessId)
          .single();

        if (bizError2) {
          logger.withContext({ op: 'payment.connect-split-fetch', ...safeLogErrorContext(bizError2) }).error('[PAYMENT] Failed to fetch business for connect split');
        }

        if (business) {
          const tier = (business.subscription_tier || 'free') as SubscriptionTier;
          const isInTrial = await resolveTrialStatus(supabase, opts.businessId, tier, business.trial_ends_at);
          const { getPlatformFees } = await import('@/lib/getPlatformFees');
          const feeResult = await getPlatformFees(opts.amount, tier, isInTrial, {
            feePercentage: business.custom_fee_percentage ?? undefined,
            feeFlat: business.custom_fee_flat ?? undefined,
          });
          platformFeeAmount = feeResult.feeTotal;
        }
      } else if (byoCreds?.secret_key && byoCreds?.platform_subaccount_code) {
        // BYO mode: use business's own gateway key with reversed split
        isByo = true;
        byoSecretKey = byoCreds.secret_key;
        byoPlatformSubaccount = byoCreds.platform_subaccount_code;
        byoBusinessId = opts.businessId;
        providerConnectionId = byoCreds.id;

        // Calculate platform fee based on business tier
        const { data: business, error: bizError3 } = await supabase
          .from('businesses')
          .select('subscription_tier, trial_ends_at, custom_fee_percentage, custom_fee_flat')
          .eq('id', opts.businessId)
          .single();

        if (bizError3) {
          logger.withContext({ op: 'payment.byo-split-fetch', ...safeLogErrorContext(bizError3) }).error('[PAYMENT] Failed to fetch business for BYO split');
        }

        if (business) {
          const tier = (business.subscription_tier || 'free') as SubscriptionTier;
          const isInTrial = await resolveTrialStatus(supabase, opts.businessId, tier, business.trial_ends_at);
          const { getPlatformFees } = await import('@/lib/getPlatformFees');
          const feeResult = await getPlatformFees(opts.amount, tier, isInTrial, {
            feePercentage: business.custom_fee_percentage ?? undefined,
            feeFlat: business.custom_fee_flat ?? undefined,
          });
          platformFeeAmount = feeResult.feeTotal;
        }
      } else {
        // Normal platform flow: check payout mode
        const { data: biz, error: bizError4 } = await supabase
          .from('businesses')
          .select('payout_mode')
          .eq('id', opts.businessId)
          .single();

        if (bizError4) {
          logger.withContext({ op: 'payment.payout-mode-fetch', ...safeLogErrorContext(bizError4) }).error('[PAYMENT] Failed to fetch business payout mode');
        }

        const { data: payout } = await supabase
          .from('payout_accounts')
          .select('id, subaccount_code, stripe_account_id, square_merchant_id, square_access_token, platform_percentage, gateway')
          .eq('business_id', opts.businessId)
          .eq('is_active', true)
          .maybeSingle();

        // Only add split params if payout account gateway matches payment gateway
        if (biz?.payout_mode === 'direct_split' && payout) {
          const payoutGw = payout.gateway || 'paystack';
          const paymentGw = gateway.name;

          // Only apply split params if gateways match
          if (payoutGw === paymentGw || (payoutGw === 'paystack' && paymentGw === 'paystack') || (payoutGw === 'stripe' && paymentGw === 'stripe')) {
            subaccountCode = payout.subaccount_code || undefined;
            stripeAccountId = payout.stripe_account_id || undefined;
            squareMerchantId = payout.square_merchant_id || undefined;
            squareAccessToken = payout.square_access_token || undefined;
            platformFeeAmount = Math.round(opts.amount * (payout.platform_percentage / 100));
            payoutAccountId = payout.id;
          }
          // If gateways don't match (e.g., Paystack payout but Stripe payment),
          // skip split — platform collects full amount
        }
        // platform_managed: no split params, full amount goes to platform
      }
    }

    // Fetch business payment channel preferences
    let channels: string[] | undefined;
    if (opts.businessId) {
      const { data: channelConfig } = await supabase
        .from('businesses')
        .select('payment_channels')
        .eq('id', opts.businessId)
        .single();
      if (channelConfig?.payment_channels && Array.isArray(channelConfig.payment_channels) && channelConfig.payment_channels.length > 0) {
        channels = channelConfig.payment_channels;
      }
    }

    // ── #264: V1 fee-policy pre-provider authority binding ──
    // When fee_policy_enabled=true, create the local payment row with full v1 binding
    // BEFORE any provider API call. When OFF, the gateway initializer creates the row
    // post-provider as usual (v0 legacy path).
    let v1PaymentId: string | null = null;
    let feePolicyVersion = 0;

    if (opts.businessId && opts.transactionCategory) {
      try {
        // Resolve effective config version at current time
        const { data: configVer, error: configErr } = await supabase
          .from('platform_config_versions')
          .select('id, config_snapshot')
          .lte('effective_from', new Date().toISOString())
          .order('effective_from', { ascending: false })
          .limit(1)
          .single();

        // Fail closed: config lookup error or missing → gate state unknown → no dispatch
        if (configErr || !configVer?.config_snapshot) {
          logger.error('[PAYMENT] Config version lookup failed/missing — fail closed', { configErr });
          return null;
        }

        const snapshot = configVer.config_snapshot as Record<string, unknown>;
        // Strict tri-state: true → v1, false → v0, anything else → fail closed
        const gateValue = snapshot.fee_policy_enabled;
        if (gateValue !== true && gateValue !== false) {
          logger.error('[PAYMENT] fee_policy_enabled is not true/false — fail closed', { gateValue });
          return null;
        }

        if (gateValue === true) {
          // Resolve fee basis — fail closed on any error
          const { data: bizForFee, error: bizErr } = await supabase
            .from('businesses')
            .select('subscription_tier, trial_ends_at, custom_fee_percentage, custom_fee_flat')
            .eq('id', opts.businessId)
            .single();

          if (bizErr || !bizForFee) {
            logger.error('[PAYMENT] Business lookup failed during v1 fee resolution — fail closed', { bizErr });
            return null;
          }

          const { resolveTrialStatus } = await import('@/lib/trial-status');
          const tier = (bizForFee.subscription_tier || 'free') as import('@/lib/constants').SubscriptionTier;
          const isInTrial = await resolveTrialStatus(supabase, opts.businessId, tier, bizForFee.trial_ends_at);

          // Validate v1 snapshot (non-zero tier feeFlat fails closed)
          const { validateV1Snapshot } = await import('@/lib/payments/calculateFee');
          const snapErr = validateV1Snapshot(snapshot as Parameters<typeof validateV1Snapshot>[0], tier);
          if (snapErr) {
            logger.error('[PAYMENT] V1 snapshot validation failed — blocking payment', { error: snapErr });
            return null;
          }

          const paymentRouting: 'platform' | 'byo' | 'connect' = isByo ? 'byo' : (connectAccountId ? 'connect' : 'platform');
          const feeBasis = {
            payment_routing: paymentRouting,
            tier,
            is_in_trial: isInTrial,
            custom_fee_percentage: bizForFee.custom_fee_percentage != null ? Number(bizForFee.custom_fee_percentage) : null,
            custom_fee_flat: bizForFee.custom_fee_flat != null ? Number(bizForFee.custom_fee_flat) : null,
          };

          // Calculate v1 fee for provider split
          const { calculateFee } = await import('@/lib/payments/calculateFee');
          const v1Fee = calculateFee(opts.amount, feeBasis, opts.transactionCategory, snapshot as Parameters<typeof calculateFee>[3]);
          if (paymentRouting === 'byo') {
            platformFeeAmount = 0;
          } else {
            platformFeeAmount = v1Fee.feeTotal;
          }

          feePolicyVersion = 1;

          // Create pre-provider payment row with full v1 binding
          const { data: preRow, error: preErr } = await supabase.from('payments').insert({
            booking_id: opts.bookingId || null,
            invoice_id: opts.invoiceId || null,
            campaign_id: opts.campaignId || null,
            reservation_id: opts.reservationId || null,
            order_id: opts.orderId || null,
            business_id: opts.businessId,
            user_id: opts.userId,
            amount: opts.amount,
            currency: currencyCode,
            gateway: gateway.name,
            gateway_reference: opts.referenceCode,
            status: 'pending',
            payment_authority_version: 1,
            fee_policy_version: 1,
            config_version_id: configVer.id,
            transaction_category: opts.transactionCategory,
            fee_basis: feeBasis,
            provider_init_state: 'pre_dispatch',
            metadata: {
              reference_code: opts.referenceCode,
              channel: 'whatsapp',
              payment_origin: paymentRouting,
              ...(opts.orderId && { order_id: opts.orderId }),
              ...(isByo && { byo: true, byo_business_id: byoBusinessId }),
              ...(connectAccountId && { connect: true, connect_account_id: connectAccountId }),
            },
          }).select('id').single();

          if (preErr || !preRow) {
            logger.error('[PAYMENT] V1 pre-provider row creation failed — NOT calling provider', preErr);
            return null;
          }
          v1PaymentId = preRow.id;

          // CAS: pre_dispatch → dispatched (before provider call)
          const { data: casRows, error: casErr } = await supabase.from('payments')
            .update({ provider_init_state: 'dispatched' })
            .eq('id', v1PaymentId)
            .eq('provider_init_state', 'pre_dispatch')
            .select('id');
          if (casErr || !casRows || casRows.length !== 1) {
            logger.error('[PAYMENT] V1 CAS pre_dispatch→dispatched failed', { casErr, rowCount: casRows?.length });
            return null;
          }
        }
        // gate OFF (fee_policy_enabled === false) → v0 fallback (authoritative decision)
      } catch (feePolicyErr) {
        // Gate resolution failure while category is present = applicable #264 flow.
        // Fail closed: do NOT silently create a v0 payment when the gate state is unknown.
        logger.error('[PAYMENT] Fee policy resolution error — fail closed, no provider dispatch', feePolicyErr);
        return null;
      }
    }

    const result = await observe('payment.init', {
      gateway: gateway.name,
      businessId: opts.businessId,
      amount: opts.amount,
      currency: currencyCode,
      splitRequired: !!subaccountCode || !!stripeAccountId || !!connectAccountId,
      splitResolved: !!(subaccountCode || stripeAccountId || connectAccountId),
    }, () => gateway.initializePayment({
      supabase,
      bookingId: opts.bookingId,
      orderId: opts.orderId,
      invoiceId: opts.invoiceId,
      reservationId: opts.reservationId,
      userId: opts.userId,
      amount: opts.amount,
      currency: currencyCode,
      referenceCode: opts.referenceCode,
      businessName: opts.businessName,
      phone: opts.phone,
      userEmail: opts.userEmail,
      subaccountCode,
      stripeAccountId,
      squareMerchantId,
      squareAccessToken,
      platformFeeAmount,
      byoSecretKey,
      byoPlatformSubaccount,
      isByo,
      byoBusinessId,
      connectAccountId,
      campaignId: opts.campaignId,
      businessId: opts.businessId,
      channels,
      existingPaymentId: v1PaymentId || undefined,
    }));

    // ── V1: CAS provider_confirmed + update gateway_reference ──
    if (v1PaymentId && result?.reference) {
      const providerRef = result.reference;
      // Atomic CAS: dispatched → provider_confirmed + provider ref + checkout URL
      // Includes gateway-specific artifacts for webhook/callback correlation.
      // No URL returned unless this authority write succeeds.
      const gwName = gateway.name;
      const { data: confirmRows, error: confirmErr } = await supabase.from('payments')
        .update({
          gateway_reference: providerRef,
          provider_init_state: 'provider_confirmed',
          metadata: {
            reference_code: opts.referenceCode,
            channel: 'whatsapp',
            checkout_url: result.url,
            payment_origin: isByo ? 'byo' : (connectAccountId ? 'connect' : 'platform'),
            ...(providerConnectionId && { provider_connection_id: providerConnectionId }),
            ...(connectAccountId && { provider_account_id: connectAccountId }),
            ...(subaccountCode && { provider_account_id: subaccountCode }),
            ...(stripeAccountId && { provider_account_id: stripeAccountId }),
            ...(payoutAccountId && !providerConnectionId && { provider_connection_id: payoutAccountId }),
            ...(opts.inboundChannelId && { _inbound_channel_id: opts.inboundChannelId }),
            ...(opts.confirmationOrigin && { _confirmation_origin: opts.confirmationOrigin }),
            // Gateway-specific artifacts for webhook/callback correlation
            ...(gwName === 'stripe' && { stripe_session_id: providerRef }),
            ...(gwName === 'square' && { square_payment_link_id: providerRef }),
            ...(gwName === 'paypal' && { paypal_order_id: providerRef }),
            ...(gwName === 'flutterwave' && { flw_link: result.url }),
            ...(opts.orderId && { order_id: opts.orderId }),
            ...(isByo && { byo: true, byo_business_id: byoBusinessId }),
            ...(connectAccountId && { connect: true, connect_account_id: connectAccountId }),
          },
        })
        .eq('id', v1PaymentId)
        .eq('provider_init_state', 'dispatched')
        .select('id');
      if (confirmErr || !confirmRows || confirmRows.length !== 1) {
        // Authority write failed — payment exists but provider state is ambiguous.
        // Do NOT return checkout URL. Leave as 'dispatched' for verify-first recovery.
        logger.error('[PAYMENT] V1 CAS dispatched→provider_confirmed failed — quarantining', { confirmErr, rowCount: confirmRows?.length });
        return null;
      }
      // Authority write succeeded — safe to return checkout URL
      return { url: result.url, reference: providerRef };
    } else if (v1PaymentId && !result) {
      // Provider returned null — could be explicit rejection OR transport timeout.
      // Do NOT mark terminal 'failed' — leave as 'dispatched' for verify-first recovery.
      // The reconciliation cron will check provider state and either:
      //   - Recover the transaction if the PSP actually created it
      //   - Mark failed if the PSP confirms no transaction exists
      logger.warn('[PAYMENT] V1 provider returned null — leaving dispatched for recovery', { v1PaymentId });
      return null;
    }

    // Create donation record if this is a campaign payment
    if (result?.reference && opts.campaignId) {
      // Fetch the payment_id so the webhook can match the donation record
      const { data: paymentRecord } = await supabase
        .from('payments')
        .select('id')
        .eq('gateway_reference', result.reference)
        .maybeSingle();

      await supabase.from('campaign_donations').insert({
        campaign_id: opts.campaignId,
        business_id: opts.businessId || '',
        payment_id: paymentRecord?.id || null,
        donor_phone: opts.phone.startsWith('+') ? opts.phone : `+${opts.phone}`,
        donor_name: opts.donorName || null,
        amount: opts.amount,
        currency: currencyCode,
        reference_code: opts.referenceCode,
        status: 'pending',
      });
    }

    // Store original gateway URL in payment metadata, then shorten for WhatsApp
    if (result?.url && result.reference) {
      const { data: paymentRecord, error: paymentLookupErr } = await supabase
        .from('payments')
        .select('id, metadata')
        .eq('gateway_reference', result.reference)
        .maybeSingle();

      if (paymentLookupErr || !paymentRecord) {
        // Payment row not found or lookup failed — cannot prove local payment exists
        // Do NOT expose checkout URL when Waaiio cannot verify the payment
        logger.error('[PAYMENT] Payment record not found/lookup failed after provider creation — checkout URL suppressed');
        return null;
      }
      {
        const existingMeta = (paymentRecord.metadata || {}) as Record<string, unknown>;
        existingMeta.checkout_url = result.url;
        // #219: Persist inbound channel + confirmation origin for post-payment delivery
        if (opts.inboundChannelId) existingMeta._inbound_channel_id = opts.inboundChannelId;
        if (opts.confirmationOrigin) existingMeta._confirmation_origin = opts.confirmationOrigin;
        // Persist exact payment origin + connection identity for Payment Authority verification
        existingMeta.payment_origin = isByo ? 'byo' : (connectAccountId || squareAccessToken || stripeAccountId) ? 'connect' : 'platform';
        if (providerConnectionId) existingMeta.provider_connection_id = providerConnectionId;
        if (connectAccountId) existingMeta.provider_account_id = connectAccountId;
        if (subaccountCode) existingMeta.provider_account_id = subaccountCode;
        if (stripeAccountId) existingMeta.provider_account_id = stripeAccountId;
        // Square/Stripe payout: persist exact payout_accounts.id for rotation-safe verification
        if (payoutAccountId && !providerConnectionId) existingMeta.provider_connection_id = payoutAccountId;
        const { error: identityError } = await supabase.from('payments').update({ metadata: existingMeta, payment_authority_version: 1 }).eq('id', paymentRecord.id);
        if (identityError) {
          // Identity persistence failed — do NOT return checkout URL
          // Mark for review so quarantine guard prevents duplicate provider transactions
          const { error: quarantineErr } = await supabase.from('payments').update({ gateway_status: 'review_required:identity_persist_failed' }).eq('id', paymentRecord.id);
          if (quarantineErr) {
            logger.error('[PAYMENT] Quarantine write also failed — checkout URL still suppressed');
          }
          logger.withContext({ op: 'payment.identity-persist', ...safeLogErrorContext(identityError) })
            .error('[PAYMENT] Failed to persist payment authority identity — checkout URL suppressed');
          return null;
        }
      }

      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
      const shortRef = result.reference.slice(-8);
      result.url = `${appUrl}/api/pay?ref=${shortRef}`;
    }

    return result;
  } catch (error) {
    const err = error as Error;
    logger.withContext({ op: 'payment.init-threw', ...safeLogErrorContext(err) }).error('[PAYMENT] initializePayment THREW');
    (globalThis as Record<string, unknown>).__lastPaymentError = { message: err.message, stack: err.stack?.split('\n').slice(0, 6) };
    return null;
  }
}

export async function verifyPayment(
  supabase: SupabaseClient,
  reference: string,
  countryCode: CountryCode = 'NG',
): Promise<boolean> {
  const gateway = getPaymentGateway(countryCode);
  return gateway.verifyPayment(supabase, reference);
}

// Keep backward-compat aliases
export const initializePaystackPayment = initializePayment;
export const verifyPaystackPayment = (supabase: SupabaseClient, reference: string) =>
  verifyPayment(supabase, reference, 'NG');

export async function recordPlatformFee(
  supabase: SupabaseClient,
  opts: {
    businessId: string;
    bookingId?: string;
    orderId?: string;
    invoiceId?: string;
    reservationId?: string;
    transactionAmount: number;
    tier: SubscriptionTier;
    isInTrial: boolean;
  },
): Promise<void> {
  // Skip fee for direct_split businesses — gateway already collected the fee
  const { data: biz } = await supabase
    .from('businesses')
    .select('payout_mode, custom_fee_percentage, custom_fee_flat')
    .eq('id', opts.businessId)
    .single();
  if (biz?.payout_mode === 'direct_split') return;

  // Look up custom fee overrides for this business
  let overrides: { feePercentage?: number | null; feeFlat?: number | null } | undefined;
  if (biz && (biz.custom_fee_percentage != null || biz.custom_fee_flat != null)) {
    overrides = { feePercentage: biz.custom_fee_percentage, feeFlat: biz.custom_fee_flat };
  }
  const fee = await getPlatformFees(opts.transactionAmount, opts.tier, opts.isInTrial, overrides);

  await supabase.from('platform_fees').insert({
    business_id: opts.businessId,
    booking_id: opts.bookingId || null,
    order_id: opts.orderId || null,
    invoice_id: opts.invoiceId || null,
    reservation_id: opts.reservationId || null,
    transaction_amount: opts.transactionAmount,
    fee_percentage: fee.feePercentage,
    fee_flat: fee.feeFlat,
    fee_total: fee.feeTotal,
    tier: opts.tier,
    waived: opts.isInTrial,
  });
}

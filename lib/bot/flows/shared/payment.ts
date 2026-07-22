import type { SupabaseClient } from '@supabase/supabase-js';
import { type CountryCode, type PaymentGatewayName } from '@/lib/constants';
import { getPaymentGateway, getPaymentGatewayByName } from '@/lib/payments/factory';
import { resolvePaymentRoute, type PaymentRoute } from '@/lib/payments/route-resolver';
import { decryptToken } from '@/lib/encryption';
import { getAppUrl } from '@/lib/get-app-url';
import { logger } from '@/lib/logger';

// Re-exported for backwards compatibility with bot flows
export { recordPlatformFee } from '@/lib/payments/process-success';

/**
 * Verify a payment via the gateway recorded on the payment record.
 * Fail-closed: returns false if:
 * - payment record is missing (no stored gateway to verify against)
 * - stored gateway is not a recognized provider
 * - BYO payment has no valid, non-revoked credential
 * - database lookup returns an error
 */
export async function verifyPayment(
  supabase: SupabaseClient,
  gatewayReference: string,
  _countryCode: CountryCode = 'NG',
): Promise<boolean> {
  // Look up the stored payment to determine which gateway processed it
  const { data: payment, error: lookupErr } = await supabase
    .from('payments')
    .select('gateway, collection_mode, payout_account_id, metadata')
    .eq('gateway_reference', gatewayReference)
    .maybeSingle();

  // Fail closed on DB error
  if (lookupErr) {
    logger.error('[VERIFY] Payment lookup error:', lookupErr.message);
    return false;
  }

  // Fail closed if no payment record found
  if (!payment || !payment.gateway) {
    logger.warn('[VERIFY] No payment record found for reference:', gatewayReference);
    return false;
  }

  // Validate the stored gateway is a recognized provider
  const validGateways = ['paystack', 'stripe', 'flutterwave', 'square', 'paypal'];
  if (!validGateways.includes(payment.gateway)) {
    logger.warn('[VERIFY] Unsupported gateway on payment record:', payment.gateway);
    return false;
  }

  try {
    let byoSecretKey: string | undefined;

    // For BYO payments, retrieve the merchant's credentials — fail closed if missing
    if (payment.collection_mode === 'byo' && payment.payout_account_id) {
      const { data: secret, error: secretErr } = await supabase
        .from('business_connection_secrets')
        .select('encrypted_secret_key')
        .eq('payout_account_id', payment.payout_account_id)
        .is('revoked_at', null)
        .maybeSingle();

      if (secretErr) {
        logger.error('[VERIFY] BYO credential lookup error:', secretErr.message);
        return false;
      }

      if (!secret?.encrypted_secret_key) {
        logger.warn('[VERIFY] BYO payment has no valid credential for connection:', payment.payout_account_id);
        return false;
      }

      byoSecretKey = decryptToken(secret.encrypted_secret_key);
    }

    // For Square Connect payments, resolve the seller token — fail closed if missing
    if (payment.collection_mode === 'connect' && payment.gateway === 'square' && payment.payout_account_id) {
      const { resolveSquareToken } = await import('@/lib/payments/square-token');
      const resolved = await resolveSquareToken(supabase, payment.payout_account_id);
      if (!resolved) {
        logger.warn('[VERIFY] Square Connect seller token unresolvable');
        return false;
      }
      byoSecretKey = resolved.accessToken;
    }

    const gateway = getPaymentGatewayByName(payment.gateway as PaymentGatewayName);
    return await gateway.verifyPayment(supabase, gatewayReference, byoSecretKey);
  } catch (err) {
    logger.error('[VERIFY] Gateway verification error:', (err as Error).message);
    return false;
  }
}

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
    /** Business ID for payment routing */
    businessId?: string;
    /** Campaign ID for donation tracking */
    campaignId?: string;
    /** Donor name for campaign donations */
    donorName?: string;
  },
): Promise<{ url: string; reference: string } | null> {
  try {
    const countryCode = opts.countryCode || 'NG';

    // ── Resolve payment route using the deterministic resolver ──
    // The resolver is the SOLE authority for gateway selection.
    // It checks default connection health, verification, country support, and
    // falls back to platform collection when no valid connection exists.
    let route: PaymentRoute | null = null;
    if (opts.businessId) {
      route = await resolvePaymentRoute(supabase, opts.businessId, opts.amount, countryCode);
    }

    // Select gateway: resolver route → country default (no override)
    const gateway = route
      ? getPaymentGatewayByName(route.provider as PaymentGatewayName)
      : getPaymentGateway(countryCode);

    const { getCountry } = await import('@/lib/countries');
    const currencyCode = getCountry(countryCode)?.currency_code ?? 'NGN';

    // ── Build split params from resolver route ──
    let subaccountCode: string | undefined;
    let stripeAccountId: string | undefined;
    let platformFeeAmount: number | undefined;
    let byoSecretKey: string | undefined;
    let byoPlatformSubaccount: string | undefined;
    let isByo = false;
    let byoBusinessId: string | undefined;
    let squareMerchantId: string | undefined;
    let squareAccessToken: string | undefined;
    let squareLocationId: string | undefined;

    if (route) {
      platformFeeAmount = route.platformFeeAmount;

      switch (route.mode) {
        case 'managed_split':
          subaccountCode = route.subaccountCode;
          stripeAccountId = route.stripeAccountId;
          break;

        case 'connect':
          if (route.provider === 'stripe') {
            stripeAccountId = route.stripeAccountId;
          } else if (route.provider === 'square' && route.connectionId) {
            // Fail closed: if Square token cannot be resolved, do NOT fall back
            // to platform credentials. Return null to prevent payment initialization.
            const { resolveSquareToken } = await import('@/lib/payments/square-token');
            const resolved = await resolveSquareToken(supabase, route.connectionId);
            if (!resolved) {
              logger.error('[PAYMENT] Square token unresolvable — failing closed');
              return null;
            }
            squareMerchantId = route.squareMerchantId;
            squareLocationId = route.squareLocationId;
            squareAccessToken = resolved.accessToken;
          }
          break;

        case 'byo':
          if (route.byoSecretId) {
            // Fetch and decrypt the merchant's key (service-role only)
            const { data: secret, error: secretErr } = await supabase
              .from('business_connection_secrets')
              .select('encrypted_secret_key')
              .eq('id', route.byoSecretId)
              .is('revoked_at', null)
              .single();
            if (secretErr) {
              logger.error('[PAYMENT] BYO credential lookup error:', secretErr.message);
              return null; // fail closed
            }
            if (secret?.encrypted_secret_key) {
              byoSecretKey = decryptToken(secret.encrypted_secret_key);
              byoPlatformSubaccount = route.byoPlatformSubaccount;
              isByo = true;
              byoBusinessId = opts.businessId;
            }
          }
          break;

        case 'flutterwave_mid':
          // Flutterwave MID split uses subaccount with is_f4b_account
          subaccountCode = route.flutterwaveMid;
          break;

        case 'platform':
          // No split — full amount to platform
          break;
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

    logger.info('[PAYMENT] Calling gateway.initializePayment', {
      provider: route?.provider || 'default',
      mode: route?.mode || 'platform',
      hasSquareToken: !!squareAccessToken,
      hasSquareMerchant: !!squareMerchantId,
      hasSquareLocation: !!squareLocationId,
      connectionId: route?.connectionId ? `...${route.connectionId.slice(-6)}` : 'none',
    });
    const result = await gateway.initializePayment({
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
      platformFeeAmount,
      byoSecretKey,
      byoPlatformSubaccount,
      isByo,
      byoBusinessId,
      squareMerchantId,
      squareAccessToken,
      squareLocationId,
      campaignId: opts.campaignId,
      channels,
      callbackUrl: `${getAppUrl()}/payment-success`,
      businessId: opts.businessId,
      // Fee mode tracking — persisted on payment record
      collectionMode: route?.mode || 'platform',
      feeBearerMode: route?.feeBearerMode || 'platform',
      payoutAccountId: route?.connectionId || undefined,
      waaiioFee: route?.platformFeeAmount ?? 0,
    });

    if (!result) return null;

    // Shorten the checkout URL for WhatsApp messages
    let shortUrl = result.url;
    if (result.url.length > 100 && result.shortRef) {
      shortUrl = `${getAppUrl()}/api/pay?ref=${result.shortRef}`;
    }

    return { url: shortUrl, reference: result.reference };
  } catch (error) {
    logger.error('[PAYMENT] initializePayment error:', {
      message: (error as Error).message,
      stack: (error as Error).stack?.split('\n').slice(0, 3).join(' | '),
    });
    return null;
  }
}

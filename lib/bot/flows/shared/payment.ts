import type { SupabaseClient } from '@supabase/supabase-js';
import { type CountryCode, type PaymentGatewayName } from '@/lib/constants';
import { getPaymentGateway, getPaymentGatewayByName } from '@/lib/payments/factory';
import { resolvePaymentRoute, type PaymentRoute } from '@/lib/payments/route-resolver';
import { decryptToken } from '@/lib/encryption';
import { logger } from '@/lib/logger';

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
    let route: PaymentRoute | null = null;
    if (opts.businessId) {
      route = await resolvePaymentRoute(supabase, opts.businessId, opts.amount, countryCode);
    }

    // Select gateway: resolver route → business override → country default
    const gateway = opts.gatewayOverride
      ? getPaymentGatewayByName(opts.gatewayOverride as PaymentGatewayName)
      : route
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

    if (route) {
      platformFeeAmount = route.platformFeeAmount;

      switch (route.mode) {
        case 'managed_split':
          subaccountCode = route.subaccountCode;
          stripeAccountId = route.stripeAccountId;
          break;

        case 'connect':
          stripeAccountId = route.stripeAccountId;
          break;

        case 'byo':
          if (route.byoSecretId) {
            // Fetch and decrypt the merchant's key (service-role only)
            const { data: secret } = await supabase
              .from('business_connection_secrets')
              .select('encrypted_secret_key')
              .eq('id', route.byoSecretId)
              .is('revoked_at', null)
              .single();
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
      campaignId: opts.campaignId,
      channels,
      callbackUrl: `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'}/payment-success`,
      businessId: opts.businessId,
      // Fee mode tracking
      collectionMode: route?.mode || 'platform',
    });

    if (!result) return null;

    // Shorten the checkout URL for WhatsApp messages
    const shortUrl = result.url.length > 100
      ? `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'}/pay?ref=${result.reference.slice(-8)}`
      : result.url;

    return { url: shortUrl, reference: result.reference };
  } catch (error) {
    logger.error('[PAYMENT] initializePayment error:', (error as Error).message);
    return null;
  }
}

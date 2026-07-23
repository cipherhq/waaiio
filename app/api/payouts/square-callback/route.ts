import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';
import { safeProviderError } from '@/lib/redact';

const squareAppId = process.env.SQUARE_OAUTH_APP_ID || process.env.SQUARE_APPLICATION_ID || '';
const squareAppSecret = process.env.SQUARE_OAUTH_APP_SECRET || process.env.SQUARE_APPLICATION_SECRET || '';
const squareEnvironment = process.env.SQUARE_ENVIRONMENT || 'sandbox';

function getSquareBaseUrl(): string {
  return squareEnvironment === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';

  if (error) {
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=square_denied`);
  }

  if (!code || !state) {
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=missing_params`);
  }

  // Extract business_id from state (format: "business_id:random")
  const businessId = state.split(':')[0];
  if (!businessId) {
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=invalid_state`);
  }

  const supabase = await createClient();

  try {
    // Exchange authorization code for access token
    const tokenRes = await fetch(`${getSquareBaseUrl()}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: squareAppId,
        client_secret: squareAppSecret,
        code,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();

    if (tokenData.error || !tokenData.access_token) {
      logger.error('[SQUARE-CALLBACK] Token exchange failed:', safeProviderError(tokenData));
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=token_exchange_failed`);
    }

    const accessToken = tokenData.access_token as string;
    const merchantId = tokenData.merchant_id as string;

    // Verify the merchant account
    const merchantRes = await fetch(`${getSquareBaseUrl().replace('connect.', 'connect.')}/v2/merchants/${merchantId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const merchantData = await merchantRes.json();
    const merchant = merchantData.merchant;

    if (!merchant) {
      logger.withContext({
        op: 'square-callback.merchant-verify',
        businessId,
        ...( safeProviderError(merchantData) !== 'Provider error' ? { providerInfo: safeProviderError(merchantData) } : {}),
      }).error('[SQUARE-CALLBACK] Merchant verification failed');
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=not_verified`);
    }

    // Deactivate existing payout accounts
    await supabase
      .from('payout_accounts')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('business_id', businessId)
      .eq('is_active', true);

    // Save the connected Square account
    await supabase.from('payout_accounts').insert({
      business_id: businessId,
      gateway: 'square',
      square_merchant_id: merchantId,
      square_access_token: accessToken,
      platform_percentage: 2.5,
      is_active: true,
      verified_at: new Date().toISOString(),
    });

    // Update business payout mode to direct_split
    await supabase
      .from('businesses')
      .update({ payout_mode: 'direct_split' })
      .eq('id', businessId);

    logger.debug('[SQUARE-CALLBACK] Connected merchant:', merchantId, 'for business:', businessId);
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?connected=true`);
  } catch (err) {
    logger.withContext({
      op: 'square-callback',
      businessId,
      ...safeLogErrorContext(err),
    }).error('[SQUARE-CALLBACK] Callback failed');
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=callback_failed`);
  }
}

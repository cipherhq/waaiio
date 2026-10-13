import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';
import { safeProviderError } from '@/lib/redact';
import { consumeState } from '@/lib/oauth-connect-state';
import { encryptToken } from '@/lib/encryption';
import { sendEmail } from '@/lib/email/client';

const squareAppId = process.env.SQUARE_OAUTH_APP_ID || process.env.SQUARE_APPLICATION_ID || '';
const squareAppSecret = process.env.SQUARE_OAUTH_APP_SECRET || process.env.SQUARE_APPLICATION_SECRET || '';
const squareEnvironment = process.env.SQUARE_ENVIRONMENT || 'sandbox';

function getSquareBaseUrl(): string {
  return squareEnvironment === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
}

export async function GET(request: NextRequest) {
  if (process.env.ENABLE_SQUARE_CONNECT !== 'true') {
    return NextResponse.json({ error: 'Square Connect is currently disabled' }, { status: 503 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const stateRaw = searchParams.get('state');
  const error = searchParams.get('error');

  if (error) {
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=square_denied`);
  }

  if (!code || !stateRaw) {
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=missing_params`);
  }

  // Require authenticated user
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=not_authenticated`);
  }

  const serviceClient = createServiceClient();

  // Consume state atomically
  const stateResult = await consumeState(serviceClient, {
    stateRaw,
    userId: user.id,
    provider: 'square',
  });
  if (!stateResult.ok || !stateResult.businessId) {
    logger.warn('[SQUARE-CALLBACK] State validation failed:', stateResult.error);
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=invalid_state`);
  }

  const businessId = stateResult.businessId;

  // Re-check ownership
  const { data: biz } = await supabase
    .from('businesses')
    .select('id, name, owner_id')
    .eq('id', businessId)
    .eq('owner_id', user.id)
    .single();

  if (!biz) {
    logger.warn('[SQUARE-CALLBACK] Ownership re-check failed for business', businessId);
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=not_authorized`);
  }

  try {
    // Exchange authorization code for access token (server-side)
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
    const merchantRes = await fetch(`${getSquareBaseUrl()}/v2/merchants/${merchantId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const merchantData = await merchantRes.json();

    if (!merchantData.merchant) {
      logger.withContext({
        op: 'square-callback.merchant-verify',
        businessId,
        ...( safeProviderError(merchantData) !== 'Provider error' ? { providerInfo: safeProviderError(merchantData) } : {}),
      }).error('[SQUARE-CALLBACK] Merchant verification failed');
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=not_verified`);
    }

    // Encrypt the access token before storage
    const encryptedToken = encryptToken(accessToken);

    // Save via atomic RPC (service_role)
    const { data: newAccountId, error: rpcError } = await serviceClient.rpc('swap_payout_account', {
      p_business_id: businessId,
      p_gateway: 'square',
      p_square_merchant_id: merchantId,
      p_square_access_token: encryptedToken,
      p_verified_at: new Date().toISOString(),
    });

    if (rpcError) {
      logger.withContext({ op: 'square-callback.rpc', ...safeLogErrorContext(rpcError) }).error('[SQUARE-CALLBACK] RPC error');
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=save_failed`);
    }

    // Update business payout mode
    await serviceClient
      .from('businesses')
      .update({ payout_mode: 'direct_split' })
      .eq('id', businessId);

    // Owner notification email (non-blocking)
    try {
      const { data: ownerProfile } = await serviceClient.from('profiles').select('email').eq('id', biz.owner_id).single();
      if (ownerProfile?.email) {
        await sendEmail({
          to: ownerProfile.email,
          subject: `Square payout account connected — ${biz.name}`,
          html: `<p>A Square payout account has been connected to <strong>${biz.name}</strong>.</p><p>If you did not do this, please contact support immediately.</p>`,
        });
      }
    } catch (emailErr) {
      logger.warn('[SQUARE-CALLBACK] Owner notification email failed (non-blocking):', emailErr);
    }

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

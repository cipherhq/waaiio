import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyOAuthState, consumeOAuthState } from '@/lib/payments/oauth-state';
import { encryptToken } from '@/lib/encryption';
import { getAppUrl } from '@/lib/get-app-url';
import { SQUARE_OAUTH_SCOPE_STRING, getSquareRedirectUri } from '@/lib/payments/square-scopes';
import { logger } from '@/lib/logger';

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
  const appUrl = getAppUrl();

  if (error) {
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=square_denied`);
  }
  if (!code || !state) {
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=missing_params`);
  }

  // Verify cryptographic OAuth state
  const verified = verifyOAuthState(state);
  if (!verified) {
    logger.warn('[SQUARE-CALLBACK] Invalid/expired/tampered state');
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=invalid_state`);
  }

  // Consume nonce atomically
  const service = createServiceClient();
  let consumed;
  try {
    consumed = await consumeOAuthState(service, verified.nonce);
  } catch (err) {
    logger.error('[SQUARE-CALLBACK] State consumption error:', (err as Error).message);
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=state_error`);
  }
  if (!consumed) {
    logger.warn('[SQUARE-CALLBACK] State already consumed (replay)');
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=state_replayed`);
  }

  const { userId, businessId } = consumed;
  if (consumed.provider !== 'square') {
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=provider_mismatch`);
  }

  // Verify authenticated user matches state
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.id !== userId) {
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=user_mismatch`);
  }

  // Verify business ownership via RLS
  const { data: bizCheck } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', businessId)
    .single();
  if (!bizCheck) {
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=not_owner`);
  }

  try {
    if (!squareAppSecret) {
      if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
        return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=not_configured`);
      }
      // Mock mode (dev only) — use RPC with mock values
      const { data: mockResult, error: mockErr } = await service.rpc('replace_square_connection_full', {
        p_business_id: businessId,
        p_merchant_id: 'mock_merchant',
        p_location_id: 'mock_location',
        p_encrypted_access: 'mock_encrypted_access',
        p_encrypted_refresh: 'mock_encrypted_refresh',
        p_token_expires_at: null,
        p_token_scopes: SQUARE_OAUTH_SCOPE_STRING,
        p_key_identifier: 'sq_****mock',
      });
      if (mockErr || !mockResult?.success) {
        return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=replace_failed`);
      }
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?connected=true`);
    }

    // Exchange authorization code for tokens
    const tokenEndpoint = `${getSquareBaseUrl()}/oauth2/token`;
    const tokenRes = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: squareAppId,
        client_secret: squareAppSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: getSquareRedirectUri(appUrl),
      }),
    });
    const tokenData = await tokenRes.json();

    if (tokenData.error || tokenData.errors || !tokenData.access_token) {
      // Log sanitized diagnostics — never log code, secret, or tokens
      const sqErrors = tokenData.errors as Array<{ category?: string; code?: string; detail?: string }> | undefined;
      logger.error('[SQUARE-CALLBACK] Token exchange failed', {
        httpStatus: tokenRes.status,
        endpoint: tokenEndpoint,
        clientIdFingerprint: squareAppId ? `...${squareAppId.slice(-6)}` : 'EMPTY',
        secretPresent: !!squareAppSecret,
        squareError: tokenData.error || sqErrors?.[0]?.detail || 'no access_token',
        squareErrorCode: sqErrors?.[0]?.code,
        squareCategory: sqErrors?.[0]?.category,
        squareRequestId: tokenRes.headers.get('square-request-id') || undefined,
      });
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=token_exchange_failed`);
    }

    const accessToken = tokenData.access_token as string;
    const refreshToken = (tokenData.refresh_token as string) || '';
    const merchantId = tokenData.merchant_id as string;
    const expiresAt = tokenData.expires_at as string | undefined;

    // Square ObtainToken does NOT return `scope` in the response.
    // We persist the canonical requested scopes instead.

    // Fetch merchant's locations using the new access token
    const locationsRes = await fetch(`${getSquareBaseUrl()}/v2/locations`, {
      headers: { 'Square-Version': '2024-12-18', Authorization: `Bearer ${accessToken}` },
    });
    const locationsData = await locationsRes.json();
    const locations = (locationsData.locations || []) as Array<{
      id: string; name: string; country: string; currency: string; status: string;
    }>;

    if (!locations.length) {
      logger.error('[SQUARE-CALLBACK] Zero locations for merchant');
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=no_location`);
    }

    // Select ONLY active US/USD locations — no silent fallback to non-US
    const usLocations = locations.filter(
      l => l.status === 'ACTIVE' && l.country === 'US' && l.currency === 'USD',
    );
    if (!usLocations.length) {
      logger.error('[SQUARE-CALLBACK] No active US/USD location');
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=no_us_location`);
    }

    // Deterministic: alphabetical by name
    usLocations.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const selectedLocation = usLocations[0];

    // Encrypt credentials BEFORE the RPC call
    const encryptedAccess = encryptToken(accessToken);
    const encryptedRefresh = refreshToken ? encryptToken(refreshToken) : '';
    const keyIdentifier = `sq_****${merchantId.slice(-4)}`;

    // Atomic replacement: payout account + secret + payout_mode in one transaction.
    // Any failure rolls back everything — no partial state.
    const { data: result, error: rpcErr } = await service.rpc('replace_square_connection_full', {
      p_business_id: businessId,
      p_merchant_id: merchantId,
      p_location_id: selectedLocation.id,
      p_encrypted_access: encryptedAccess,
      p_encrypted_refresh: encryptedRefresh,
      p_token_expires_at: expiresAt || null,
      p_token_scopes: SQUARE_OAUTH_SCOPE_STRING,
      p_key_identifier: keyIdentifier,
    });

    if (rpcErr) {
      logger.error('[SQUARE-CALLBACK] RPC error:', rpcErr.message);
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=replace_failed`);
    }
    if (!result?.success) {
      logger.error('[SQUARE-CALLBACK] RPC rejected:', result?.reason);
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=${result?.reason || 'replace_failed'}`);
    }

    return NextResponse.redirect(`${appUrl}/dashboard/payouts?connected=true`);
  } catch (err) {
    logger.error('[SQUARE-CALLBACK] Error:', (err as Error).message);
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=callback_failed`);
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { generateOAuthState, persistOAuthState } from '@/lib/payments/oauth-state';
import { getAppUrl } from '@/lib/get-app-url';
import { SQUARE_OAUTH_SCOPE_STRING, getSquareRedirectUri } from '@/lib/payments/square-scopes';
import { logger } from '@/lib/logger';

const squareAppId = process.env.SQUARE_OAUTH_APP_ID || process.env.SQUARE_APPLICATION_ID || '';
const squareEnvironment = process.env.SQUARE_ENVIRONMENT || 'sandbox';

function getSquareOAuthUrl(): string {
  return squareEnvironment === 'production'
    ? 'https://connect.squareup.com/oauth2/authorize'
    : 'https://connect.squareupsandbox.com/oauth2/authorize';
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { business_id } = await request.json();
  if (!business_id) {
    return NextResponse.json({ error: 'Missing business_id' }, { status: 400 });
  }

  const { data: biz } = await supabase
    .from('businesses')
    .select('id, name')
    .eq('id', business_id)
    .eq('owner_id', user.id)
    .single();

  if (!biz) {
    return NextResponse.json({ error: 'Business not found' }, { status: 404 });
  }

  try {
    if (!squareAppId) {
      if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
        return NextResponse.json({ error: 'Square not configured' }, { status: 500 });
      }
      return NextResponse.json({ url: `/dashboard/payouts?connected=true&mock=true` });
    }

    const appUrl = getAppUrl();
    const { token: oauthState, payload } = generateOAuthState(user.id, business_id, 'square', 'pending');
    const service = createServiceClient();
    await persistOAuthState(service, payload);

    const redirectUri = getSquareRedirectUri(appUrl);
    const params = new URLSearchParams({
      client_id: squareAppId,
      scope: SQUARE_OAUTH_SCOPE_STRING,
      session: 'false',
      state: oauthState,
      redirect_uri: redirectUri,
    });

    return NextResponse.json({ url: `${getSquareOAuthUrl()}?${params.toString()}` });
  } catch (error) {
    logger.error('Square Connect error:', (error as Error).message);
    return NextResponse.json({ error: 'Failed to start Square onboarding' }, { status: 500 });
  }
}

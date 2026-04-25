import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import { randomUUID } from 'crypto';

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
      return NextResponse.json({ url: `/dashboard/payouts?connected=true&mock=true` });
    }

    const state = `${business_id}:${randomUUID().slice(0, 8)}`;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';
    const redirectUri = `${appUrl}/api/payouts/square-callback`;

    const params = new URLSearchParams({
      client_id: squareAppId,
      scope: 'PAYMENTS_WRITE PAYMENTS_READ ORDERS_WRITE ORDERS_READ MERCHANT_PROFILE_READ',
      session: 'false',
      state,
      redirect_uri: redirectUri,
    });

    const oauthUrl = `${getSquareOAuthUrl()}?${params.toString()}`;

    return NextResponse.json({ url: oauthUrl });
  } catch (error) {
    logger.error('Square Connect error:', (error as Error).message);
    return NextResponse.json({ error: 'Failed to start Square onboarding' }, { status: 500 });
  }
}

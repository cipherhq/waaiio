import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createHmac } from 'crypto';
import { logger } from '@/lib/logger';

/** Generate HMAC state token binding callback to user+business */
function generateOAuthState(userId: string, businessId: string, accountId: string): string {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.TOKEN_ENCRYPTION_KEY || 'dev-only';
  const expires = Date.now() + 30 * 60 * 1000; // 30 minutes
  const payload = `${userId}:${businessId}:${accountId}:${expires}`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex').slice(0, 16);
  return `${payload}:${sig}`;
}

/** Verify HMAC state token */
export function verifyOAuthState(state: string): { userId: string; businessId: string; accountId: string } | null {
  const parts = state.split(':');
  if (parts.length !== 5) return null;
  const [userId, businessId, accountId, expiresStr, sig] = parts;
  const expires = parseInt(expiresStr, 10);
  if (isNaN(expires) || Date.now() > expires) return null;
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.TOKEN_ENCRYPTION_KEY || 'dev-only';
  const payload = `${userId}:${businessId}:${accountId}:${expiresStr}`;
  const expectedSig = createHmac('sha256', secret).update(payload).digest('hex').slice(0, 16);
  if (sig !== expectedSig) return null;
  return { userId, businessId, accountId };
}

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';

async function stripeRequest(path: string, body: Record<string, string>) {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  });
  return response.json();
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

  // Verify the user owns this business
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
    if (!stripeSecretKey) {
      return NextResponse.json({ url: `/dashboard/payouts?connected=true&mock=true` });
    }

    // Create Stripe Express account
    const account = await stripeRequest('/accounts', {
      type: 'express',
      'business_profile[name]': biz.name,
      'metadata[business_id]': business_id,
    });

    if (account.error) {
      console.error('[STRIPE-CONNECT] Account creation error:', account.error.message);
      return NextResponse.json({ error: 'Failed to create payout account. Please try again.' }, { status: 400 });
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';

    // Create onboarding link with cryptographic state binding
    const oauthState = generateOAuthState(user.id, business_id, account.id);
    const link = await stripeRequest('/account_links', {
      account: account.id,
      refresh_url: `${appUrl}/dashboard/payouts?refresh=true`,
      return_url: `${appUrl}/api/payouts/stripe-callback?state=${encodeURIComponent(oauthState)}`,
      type: 'account_onboarding',
    });

    if (link.error) {
      console.error('[STRIPE-CONNECT] Onboarding link error:', link.error.message);
      return NextResponse.json({ error: 'Failed to generate onboarding link. Please try again.' }, { status: 400 });
    }

    return NextResponse.json({ url: link.url });
  } catch (error) {
    logger.error('Stripe Connect error:', (error as Error).message);
    return NextResponse.json({ error: 'Failed to create Stripe account' }, { status: 500 });
  }
}

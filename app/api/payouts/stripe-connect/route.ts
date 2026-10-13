import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';
import { generateState, storeState } from '@/lib/oauth-connect-state';

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
  if (process.env.ENABLE_STRIPE_CONNECT !== 'true') {
    return NextResponse.json({ error: 'Stripe Connect is currently disabled' }, { status: 503 });
  }

  if (!stripeSecretKey) {
    return NextResponse.json({ error: 'Stripe not configured' }, { status: 503 });
  }

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
    const account = await stripeRequest('/accounts', {
      type: 'express',
      'business_profile[name]': biz.name,
      'metadata[business_id]': business_id,
    });

    if (account.error) {
      logger.withContext({ op: 'stripe-connect.create-account', ...safeLogErrorContext(account.error) }).error('[STRIPE-CONNECT] Account creation error');
      return NextResponse.json({ error: 'Failed to create payout account. Please try again.' }, { status: 400 });
    }

    // Generate and store CSRF state bound to user + business + provider
    const { raw: stateRaw, hash: stateHash } = generateState();
    const serviceClient = createServiceClient();
    const storeResult = await storeState(serviceClient, {
      stateHash,
      userId: user.id,
      businessId: business_id,
      provider: 'stripe',
    });
    if (!storeResult.ok) {
      logger.error('[STRIPE-CONNECT] Failed to store OAuth state:', storeResult.error);
      return NextResponse.json({ error: 'Failed to start onboarding' }, { status: 500 });
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';

    // State carries the CSRF token; business_id is NOT in the URL
    const link = await stripeRequest('/account_links', {
      account: account.id,
      refresh_url: `${appUrl}/dashboard/payouts?refresh=true`,
      return_url: `${appUrl}/api/payouts/stripe-callback?state=${stateRaw}&stripe_account=${account.id}`,
      type: 'account_onboarding',
    });

    if (link.error) {
      logger.withContext({ op: 'stripe-connect.onboarding-link', ...safeLogErrorContext(link.error) }).error('[STRIPE-CONNECT] Onboarding link error');
      return NextResponse.json({ error: 'Failed to generate onboarding link. Please try again.' }, { status: 400 });
    }

    return NextResponse.json({ url: link.url });
  } catch (error) {
    logger.withContext({ op: 'stripe-connect', ...safeLogErrorContext(error) })
      .error('[STRIPE-CONNECT] Failed to create account');
    return NextResponse.json({ error: 'Failed to create Stripe account' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

const RESELLER_TIERS = {
  starter: { price: 29900, label: 'Starter', maxAccounts: 10 },
  professional: { price: 79900, label: 'Professional', maxAccounts: 50 },
  enterprise: { price: 150000, label: 'Enterprise', maxAccounts: 999 },
} as const;

type ResellerTier = keyof typeof RESELLER_TIERS;

const TIER_PRICE_ENV: Record<ResellerTier, string> = {
  starter: 'RESELLER_STRIPE_PRICE_STARTER',
  professional: 'RESELLER_STRIPE_PRICE_PRO',
  enterprise: 'RESELLER_STRIPE_PRICE_ENTERPRISE',
};

function getStripeKey(): string {
  return process.env.STRIPE_SECRET_KEY || '';
}

async function stripeRequest(path: string, method: 'GET' | 'POST' | 'DELETE', body?: Record<string, string>) {
  const key = getStripeKey();
  const options: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    signal: AbortSignal.timeout(15000),
  };
  if (body && (method === 'POST' || method === 'DELETE')) {
    options.body = new URLSearchParams(body).toString();
  }
  const response = await fetch(`https://api.stripe.com/v1${path}`, options);
  return response.json() as Promise<Record<string, unknown>>;
}

async function getReseller(supabase: ReturnType<typeof createServiceClient>) {
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return null;

  const { data: reseller } = await supabase
    .from('resellers')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  return reseller;
}

export async function GET() {
  try {
    const supabase = createServiceClient();
    const reseller = await getReseller(supabase);
    if (!reseller) {
      return NextResponse.json({ error: 'Reseller profile not found' }, { status: 404 });
    }

    const tier = (reseller.tier || 'starter') as ResellerTier;
    const tierInfo = RESELLER_TIERS[tier] || RESELLER_TIERS.starter;

    const result: Record<string, unknown> = {
      tier,
      label: tierInfo.label,
      price: tierInfo.price,
      maxAccounts: tierInfo.maxAccounts,
      stripe_subscription_id: reseller.stripe_subscription_id || null,
      subscription_status: null,
      current_period_end: null,
    };

    // Fetch live subscription status from Stripe if we have a subscription ID
    if (reseller.stripe_subscription_id && getStripeKey()) {
      try {
        const sub = await stripeRequest(
          `/subscriptions/${encodeURIComponent(reseller.stripe_subscription_id)}`,
          'GET'
        );
        if (sub.id) {
          result.subscription_status = sub.status;
          result.current_period_end = sub.current_period_end;
        }
      } catch (err) {
        logger.error('Failed to fetch Stripe subscription', { error: err });
        // Return what we have without Stripe data
      }
    }

    return NextResponse.json(result);
  } catch (err) {
    logger.error('GET /api/reseller/subscription error', { error: err });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createServiceClient();
    const reseller = await getReseller(supabase);
    if (!reseller) {
      return NextResponse.json({ error: 'Reseller profile not found' }, { status: 404 });
    }

    const body = await request.json();
    const tier = body.tier as ResellerTier;

    if (!tier || !RESELLER_TIERS[tier]) {
      return NextResponse.json(
        { error: 'Invalid tier. Must be starter, professional, or enterprise' },
        { status: 400 }
      );
    }

    const tierInfo = RESELLER_TIERS[tier];
    const priceId = process.env[TIER_PRICE_ENV[tier]];
    const stripeKey = getStripeKey();

    // Manual billing mode: no Stripe env vars configured
    if (!stripeKey || !priceId) {
      const { error: updateError } = await supabase
        .from('resellers')
        .update({
          tier,
          max_sub_accounts: tierInfo.maxAccounts,
        })
        .eq('id', reseller.id);

      if (updateError) {
        logger.error('Failed to update reseller tier', { error: updateError });
        return NextResponse.json({ error: 'Failed to update subscription' }, { status: 500 });
      }

      return NextResponse.json({
        tier,
        label: tierInfo.label,
        price: tierInfo.price,
        maxAccounts: tierInfo.maxAccounts,
        mode: 'manual',
        message: 'Tier updated. Billing will be handled manually.',
      });
    }

    // Create Stripe customer if needed
    let customerId = reseller.stripe_customer_id;
    if (!customerId) {
      // Fetch user email for Stripe customer
      const authClient = await createClient();
      const { data: { user } } = await authClient.auth.getUser();

      const customer = await stripeRequest('/customers', 'POST', {
        email: user?.email || '',
        name: reseller.company_name || reseller.name || '',
        'metadata[reseller_id]': reseller.id,
      });

      if (!customer.id) {
        logger.error('Failed to create Stripe customer', { customer });
        return NextResponse.json({ error: 'Failed to create payment profile' }, { status: 500 });
      }

      customerId = customer.id as string;

      await supabase
        .from('resellers')
        .update({ stripe_customer_id: customerId })
        .eq('id', reseller.id);
    }

    // Cancel existing subscription if upgrading/downgrading
    if (reseller.stripe_subscription_id) {
      try {
        await stripeRequest(
          `/subscriptions/${encodeURIComponent(reseller.stripe_subscription_id)}`,
          'DELETE',
          { prorate: 'true' }
        );
      } catch (err) {
        logger.error('Failed to cancel old subscription', { error: err });
        // Continue — old sub may already be cancelled
      }
    }

    // Create new subscription
    const subscription = await stripeRequest('/subscriptions', 'POST', {
      customer: customerId,
      'items[0][price]': priceId,
      'payment_behavior': 'default_incomplete',
      'metadata[reseller_id]': reseller.id,
      'metadata[tier]': tier,
    });

    if (!subscription.id) {
      logger.error('Failed to create Stripe subscription', { subscription });
      return NextResponse.json({ error: 'Failed to create subscription' }, { status: 500 });
    }

    // Update reseller record
    const { error: updateError } = await supabase
      .from('resellers')
      .update({
        tier,
        max_sub_accounts: tierInfo.maxAccounts,
        stripe_subscription_id: subscription.id as string,
      })
      .eq('id', reseller.id);

    if (updateError) {
      logger.error('Failed to update reseller after subscription', { error: updateError });
    }

    return NextResponse.json({
      tier,
      label: tierInfo.label,
      price: tierInfo.price,
      maxAccounts: tierInfo.maxAccounts,
      stripe_subscription_id: subscription.id,
      subscription_status: subscription.status,
      current_period_end: subscription.current_period_end,
      mode: 'stripe',
    });
  } catch (err) {
    logger.error('POST /api/reseller/subscription error', { error: err });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const supabase = createServiceClient();
    const reseller = await getReseller(supabase);
    if (!reseller) {
      return NextResponse.json({ error: 'Reseller profile not found' }, { status: 404 });
    }

    if (!reseller.stripe_subscription_id) {
      return NextResponse.json({ error: 'No active subscription to cancel' }, { status: 400 });
    }

    const stripeKey = getStripeKey();

    if (stripeKey) {
      try {
        await stripeRequest(
          `/subscriptions/${encodeURIComponent(reseller.stripe_subscription_id)}`,
          'POST',
          { cancel_at_period_end: 'true' }
        );
      } catch (err) {
        logger.error('Failed to cancel Stripe subscription', { error: err });
        return NextResponse.json({ error: 'Failed to cancel subscription with payment provider' }, { status: 500 });
      }
    }

    // Clear subscription ID — it will expire at period end via Stripe
    const { error: updateError } = await supabase
      .from('resellers')
      .update({ stripe_subscription_id: null })
      .eq('id', reseller.id);

    if (updateError) {
      logger.error('Failed to clear subscription ID', { error: updateError });
    }

    return NextResponse.json({
      message: 'Subscription cancelled. Access continues until the end of the current billing period.',
    });
  } catch (err) {
    logger.error('DELETE /api/reseller/subscription error', { error: err });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

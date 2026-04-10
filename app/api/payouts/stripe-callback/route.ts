import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const accountId = searchParams.get('account_id');
  const businessId = searchParams.get('business_id');
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';

  if (!accountId || !businessId) {
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=missing_params`);
  }

  const supabase = await createClient();

  try {
    if (!stripeSecretKey) {
      // Mock mode — just save it
      await supabase
        .from('payout_accounts')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('business_id', businessId)
        .eq('is_active', true);

      await supabase.from('payout_accounts').insert({
        business_id: businessId,
        gateway: 'stripe',
        stripe_account_id: accountId,
        platform_percentage: 2.5,
        is_active: true,
        verified_at: new Date().toISOString(),
      });

      return NextResponse.redirect(`${appUrl}/dashboard/payouts?connected=true`);
    }

    // Verify the account status
    const res = await fetch(`https://api.stripe.com/v1/accounts/${encodeURIComponent(accountId)}`, {
      headers: { Authorization: `Bearer ${stripeSecretKey}` },
    });
    const account = await res.json();

    if (!account.charges_enabled) {
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=not_verified`);
    }

    // Deactivate existing
    await supabase
      .from('payout_accounts')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('business_id', businessId)
      .eq('is_active', true);

    // Save the connected account
    await supabase.from('payout_accounts').insert({
      business_id: businessId,
      gateway: 'stripe',
      stripe_account_id: accountId,
      platform_percentage: 2.5,
      is_active: true,
      verified_at: new Date().toISOString(),
    });

    return NextResponse.redirect(`${appUrl}/dashboard/payouts?connected=true`);
  } catch (error) {
    logger.error('Stripe callback error:', (error as Error).message);
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=callback_failed`);
  }
}

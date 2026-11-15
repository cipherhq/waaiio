import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { loadPublicCampaign, parseDonationInput } from '@/lib/campaigns/public-donation';
import { initializePayment } from '@/lib/bot/flows/shared/payment';
import { checkTierLimit } from '@/lib/tier-limits';
import type { CountryCode } from '@/lib/constants';

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const limited = await rateLimitResponseAsync(getRateLimitKey(request, 'campaign-donate'), 20, 60_000);
  if (limited) return limited;
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const parsed = parseDonationInput(body);
  if (!parsed.value) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const input = parsed.value;
  try {
    const supabase = createServiceClient();
    const { id } = await context.params;
    const campaign = await loadPublicCampaign(supabase, id);
    if (!campaign) return NextResponse.json({ error: 'This campaign is not accepting donations.' }, { status: 404 });
    const minimum = campaign.min_donation || 1;
    const maximum = Math.min(campaign.max_donation || 10_000_000, 10_000_000);
    if (input.amount < minimum || input.amount > maximum) {
      return NextResponse.json({ error: 'Enter a valid donation amount.' }, { status: 400 });
    }
    const tier = await checkTierLimit(supabase, campaign.business_id, 'giving', campaign.business.subscription_tier);
    if (!tier.allowed) return NextResponse.json({ error: 'This account has reached its monthly limit. Please contact the business owner.' }, { status: 409 });
    const payment = await initializePayment(supabase, {
      userId: null, businessId: campaign.business_id, campaignId: campaign.id,
      campaignAttemptKey: input.attemptId, referenceCode: `DON-${input.attemptId}`, amount: input.amount,
      phone: input.phone, donorName: input.name, userEmail: input.email || undefined,
      businessName: campaign.business.name, countryCode: campaign.business.country_code as CountryCode,
      confirmationOrigin: 'web', transactionCategory: 'giving',
    });
    if (!payment) return NextResponse.json({ error: 'Unable to start payment. Please try again.' }, { status: 409 });
    return NextResponse.json(payment, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Unable to start payment. Please try again.' }, { status: 503 });
  }
}

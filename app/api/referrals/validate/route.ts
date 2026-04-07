import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

export async function POST(request: NextRequest) {
  try {
    const { businessId, referralCode, refereePhone } = await request.json();
    if (!businessId || !referralCode) {
      return NextResponse.json({ error: 'businessId and referralCode required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Look up referral
    const { data: referral } = await supabase
      .from('referrals')
      .select('id, referrer_phone, referrer_name, status, reward_type, reward_amount')
      .eq('business_id', businessId)
      .eq('referral_code', referralCode.toUpperCase())
      .single();

    if (!referral) {
      return NextResponse.json({ error: 'Invalid referral code' }, { status: 404 });
    }

    if (referral.status !== 'pending') {
      return NextResponse.json({ error: 'Referral code already used or expired' }, { status: 400 });
    }

    // Mark as converted
    await supabase
      .from('referrals')
      .update({
        status: 'converted',
        referee_phone: refereePhone || null,
      })
      .eq('id', referral.id);

    // If loyalty is enabled, award bonus points to referrer
    const { data: loyaltyCap } = await supabase
      .from('business_capabilities')
      .select('id')
      .eq('business_id', businessId)
      .eq('capability', 'loyalty')
      .eq('is_enabled', true)
      .maybeSingle();

    if (loyaltyCap && referral.reward_type === 'points' && referral.reward_amount) {
      const points = Math.round(referral.reward_amount);

      // Upsert referrer's loyalty points
      const { data: existing } = await supabase
        .from('loyalty_points')
        .select('id, points_balance, total_earned')
        .eq('business_id', businessId)
        .eq('customer_phone', referral.referrer_phone)
        .maybeSingle();

      if (existing) {
        await supabase
          .from('loyalty_points')
          .update({
            points_balance: existing.points_balance + points,
            total_earned: existing.total_earned + points,
          })
          .eq('id', existing.id);
      } else {
        await supabase.from('loyalty_points').insert({
          business_id: businessId,
          customer_phone: referral.referrer_phone,
          customer_name: referral.referrer_name,
          points_balance: points,
          total_earned: points,
          visit_count: 0,
        });
      }

      // Record loyalty transaction
      await supabase.from('loyalty_transactions').insert({
        business_id: businessId,
        customer_phone: referral.referrer_phone,
        points_change: points,
        reason: 'referral',
        reference_id: referral.id,
        reference_type: 'referral',
      });

      // Mark referral as rewarded
      await supabase
        .from('referrals')
        .update({ status: 'rewarded' })
        .eq('id', referral.id);
    }

    return NextResponse.json({
      success: true,
      referrer_name: referral.referrer_name,
      reward_type: referral.reward_type,
      reward_amount: referral.reward_amount,
    });
  } catch (error) {
    console.error('[REFERRALS] Validate error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

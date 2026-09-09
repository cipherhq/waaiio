import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { finalizeOnboarding } from '@/lib/onboarding/finalize';
import { PRICING_TIERS, type SubscriptionTier } from '@/lib/constants';
import type { CapabilityId } from '@/lib/capabilities/types';

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { reference, business_id: bodyBusinessId, plan: bodyPlan, billing_interval: bodyBillingInterval } = body;

    let businessId: string | undefined;
    let plan: string | undefined;
    let billingInterval: 'month' | 'year' = 'month';
    let amountSmallest = 0; // amount in smallest currency unit (kobo/cents)
    let gateway: string = 'none';
    let currency: string = 'NGN';
    let stripeSubscriptionId: string | undefined;
    let stripeCustomerId: string | undefined;
    let stripePeriodStart: string | undefined;
    let stripePeriodEnd: string | undefined;
    let providerPeriodStart: string | undefined;
    let providerPeriodEnd: string | undefined;
    let providerPaymentTimestamp: string | undefined;

    // ── Stripe verification (checkout session IDs start with cs_) ──
    if (reference && reference.startsWith('cs_')) {
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      if (!stripeKey) {
        return NextResponse.json(
          { message: 'Payment gateway not configured' },
          { status: 500 },
        );
      }

      const response = await fetch(
        `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(reference)}`,
        {
          headers: { Authorization: `Bearer ${stripeKey}` },
          signal: AbortSignal.timeout(15000),
        },
      );

      const session = await response.json();

      if (session.error) {
        return NextResponse.json(
          { message: 'Invalid payment reference' },
          { status: 400 },
        );
      }

      if (session.payment_status !== 'paid') {
        return NextResponse.json(
          { message: 'Payment not yet confirmed', stripe_status: session.payment_status },
          { status: 402 },
        );
      }

      const metadata = session.metadata as Record<string, string> | undefined;
      businessId = metadata?.business_id;
      plan = metadata?.plan;
      if (!businessId || !plan) {
        return NextResponse.json(
          { message: 'Payment metadata missing business_id or plan. Contact support.' },
          { status: 400 },
        );
      }
      if (plan !== 'growth' && plan !== 'business') {
        return NextResponse.json(
          { message: `Invalid paid plan "${plan}" in payment metadata` },
          { status: 400 },
        );
      }
      // Only monthly billing supported for #263 — require exactly 'month'
      const stripeInterval = metadata?.billing_interval;
      if (stripeInterval !== 'month') {
        return NextResponse.json(
          { message: stripeInterval === 'year' ? 'Annual billing is not yet supported' : `Invalid or missing billing interval "${stripeInterval}"` },
          { status: 400 },
        );
      }
      billingInterval = 'month';
      amountSmallest = session.amount_total;
      if (!amountSmallest || amountSmallest <= 0) {
        return NextResponse.json(
          { message: 'Invalid payment amount' },
          { status: 400 },
        );
      }
      gateway = 'stripe';
      if (!session.currency) {
        return NextResponse.json(
          { message: 'Payment currency not provided by payment gateway' },
          { status: 500 },
        );
      }
      currency = (session.currency as string).toUpperCase();

      // Capture provider payment timestamp (Stripe session.created is Unix seconds)
      if (session.created) {
        providerPaymentTimestamp = new Date(session.created * 1000).toISOString();
      }

      // Extract Stripe subscription and customer IDs (subscription mode)
      stripeSubscriptionId = session.subscription as string | undefined;
      stripeCustomerId = session.customer as string | undefined;

      // Fetch subscription period from Stripe
      if (stripeSubscriptionId) {
        try {
          const subResponse = await fetch(
            `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(stripeSubscriptionId)}`,
            {
              headers: { Authorization: `Bearer ${stripeKey}` },
              signal: AbortSignal.timeout(15000),
            },
          );
          const subData = await subResponse.json();
          if (subData.current_period_start) {
            stripePeriodStart = new Date(subData.current_period_start * 1000).toISOString();
          }
          if (subData.current_period_end) {
            stripePeriodEnd = new Date(subData.current_period_end * 1000).toISOString();
          }
        } catch {
          // Non-fatal: derive from provider payment timestamp below
        }
      }

      // If Stripe subscription period not available, derive from checkout session.created
      if (!stripePeriodStart && session.created) {
        stripePeriodStart = new Date(session.created * 1000).toISOString();
        const endDate = new Date(session.created * 1000);
        endDate.setDate(endDate.getDate() + 30);
        stripePeriodEnd = endDate.toISOString();
      }
    }
    // ── Paystack verification ──
    else if (reference) {
      const paystackKey = process.env.PAYSTACK_SECRET_KEY;
      if (!paystackKey) {
        return NextResponse.json(
          { message: 'Payment gateway not configured' },
          { status: 500 },
        );
      }

      const response = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
        { headers: { Authorization: `Bearer ${paystackKey}` } },
      );

      const data = await response.json();

      if (data?.data?.status !== 'success') {
        return NextResponse.json(
          { message: 'Payment not yet confirmed', paystack_status: data?.data?.status },
          { status: 402 },
        );
      }

      const metadata = data.data.metadata as Record<string, string> | undefined;
      businessId = metadata?.business_id;
      plan = metadata?.plan;
      if (!businessId || !plan) {
        return NextResponse.json(
          { message: 'Payment metadata missing business_id or plan. Contact support.' },
          { status: 400 },
        );
      }
      if (plan !== 'growth' && plan !== 'business') {
        return NextResponse.json(
          { message: `Invalid paid plan "${plan}" in payment metadata` },
          { status: 400 },
        );
      }
      // Only monthly billing supported for #263 — require exactly 'month'
      const paystackInterval = metadata?.billing_interval;
      if (paystackInterval !== 'month') {
        return NextResponse.json(
          { message: paystackInterval === 'year' ? 'Annual billing is not yet supported' : `Invalid or missing billing interval "${paystackInterval}"` },
          { status: 400 },
        );
      }
      billingInterval = 'month';
      amountSmallest = data.data.amount;
      if (!amountSmallest || amountSmallest <= 0) {
        return NextResponse.json(
          { message: 'Invalid payment amount' },
          { status: 400 },
        );
      }
      gateway = 'paystack';
      if (!data.data.currency) {
        return NextResponse.json(
          { message: 'Payment currency not provided by payment gateway' },
          { status: 500 },
        );
      }
      currency = (data.data.currency as string).toUpperCase();

      // Capture provider payment timestamp and derive period — fail closed if missing
      const paidAt = data.data.paid_at as string | undefined;
      const createdAt = data.data.created_at as string | undefined;
      const paystackTs = paidAt || createdAt;
      if (!paystackTs) {
        return NextResponse.json(
          { message: 'Payment timestamp not available from provider' },
          { status: 500 },
        );
      }
      providerPaymentTimestamp = new Date(paystackTs).toISOString();
      providerPeriodStart = new Date(paystackTs).toISOString();
      const endDate = new Date(paystackTs);
      endDate.setDate(endDate.getDate() + 30);
      providerPeriodEnd = endDate.toISOString();
    }
    // ── Free tier (no payment required) ──
    else if (bodyBusinessId && bodyPlan) {
      if (bodyPlan !== 'free') {
        return NextResponse.json(
          { message: 'Payment reference required for paid plans' },
          { status: 402 },
        );
      }
      businessId = bodyBusinessId;
      plan = bodyPlan;
    }

    if (!businessId || !plan) {
      return NextResponse.json(
        { message: 'Missing business_id, plan, or payment reference' },
        { status: 400 },
      );
    }

    const { data: ownerCheck } = await supabase
      .from('businesses')
      .select('owner_id, subscription_tier')
      .eq('id', businessId)
      .single();

    if (!ownerCheck || ownerCheck.owner_id !== user.id) {
      return NextResponse.json(
        { message: 'Business not found or not owned by you' },
        { status: 403 },
      );
    }

    const service = createServiceClient();

    // ── Setup-complete gate: BEFORE any subscription/activation mutation ──
    // 1. Load configured capability rows from DB (trusted, not request-supplied)
    const { data: capRows, error: capCheckError } = await service
      .from('business_capabilities')
      .select('capability, is_enabled')
      .eq('business_id', businessId);

    if (capCheckError) {
      return NextResponse.json(
        { status: 'error', message: 'Setup verification failed. Please try again.', recoverable: true },
        { status: 500 },
      );
    }

    if (!capRows || capRows.length === 0) {
      return NextResponse.json(
        { status: 'error', message: 'Business setup incomplete. Please complete capability configuration first.', recoverable: true, businessId },
        { status: 400 },
      );
    }

    // 2. Derive trusted capability IDs from DB rows (never from request)
    const trustedCapabilities = capRows
      .filter(r => r.is_enabled)
      .map(r => r.capability as CapabilityId);

    // 3. Run required finalization (idempotent — safe to retry)
    try {
      await finalizeOnboarding(service, {
        businessId,
        userId: user.id,
        capabilities: trustedCapabilities,
      });
    } catch (err) {
      return NextResponse.json(
        { status: 'error', message: 'Setup finalization failed. Please try again.', recoverable: true, businessId },
        { status: 500 },
      );
    }

    // ── Setup verified. Proceed with subscription/activation. ──

    // For paid plans, plan was already validated as 'growth' | 'business' above
    // For free plans, plan is 'free' — validated by the free-tier branch
    const tier = PRICING_TIERS[plan as SubscriptionTier];
    if (!tier) {
      return NextResponse.json(
        { message: `Unknown plan "${plan}"` },
        { status: 400 },
      );
    }
    // Annual billing rejected above; monthly is the only valid interval for #263
    const periodEnd = new Date();
    periodEnd.setDate(periodEnd.getDate() + 30);

    // Determine action: upgrade vs renewal
    const previousTier = ownerCheck.subscription_tier || 'free';
    const action = previousTier === plan ? 'renewal' : 'upgrade';

    // ── Subscription: one per business ──
    // For paid plans: check if subscription already exists.
    //   If active: ZERO pre-authority mutation. Require incoming plan matches
    //   existing plan (replay only, no upgrade/downgrade in #263). Reuse the
    //   existing subscription ID. Provider identity updates happen only after
    //   successful activation.
    //   If not active / no subscription: upsert as 'pending'.
    // For free plans: upsert as 'active'.

    let subscription: { id: string } | null = null;
    let existingSubIsActive = false;

    if (plan !== 'free') {
      // Fail closed: subscription lookup errors must not be ignored
      const { data: existingSub, error: existingSubError } = await service
        .from('subscriptions')
        .select('id, status, plan')
        .eq('business_id', businessId)
        .single();

      if (existingSubError && existingSubError.code !== 'PGRST116') {
        // PGRST116 = "no rows" (expected for first onboarding). Any other error is a real failure.
        console.warn('[ONBOARDING-VERIFY] Subscription lookup error:', existingSubError);
        return NextResponse.json(
          { message: 'Subscription verification failed. Please try again.', recoverable: true },
          { status: 500 },
        );
      }

      if (existingSub && existingSub.status === 'active') {
        // Active subscription exists — ZERO pre-authority mutation.
        // Require plan match (replay/renewal only, no upgrade/downgrade in #263).
        if (existingSub.plan !== plan) {
          return NextResponse.json(
            { message: `Plan change from ${existingSub.plan} to ${plan} is not supported during re-verification. Contact support.`, recoverable: false },
            { status: 400 },
          );
        }
        // Reuse existing subscription ID. No row mutation before evidence/RPC.
        subscription = { id: existingSub.id };
        existingSubIsActive = true;
      } else {
        // No subscription or not active — upsert as pending
        const upsertData: Record<string, unknown> = {
          business_id: businessId,
          plan,
          status: 'pending',
          amount: amountSmallest ? Math.round(amountSmallest / 100) : (tier.price ?? 0),
          gateway: gateway !== 'none' ? gateway : null,
          currency,
          current_period_start: stripePeriodStart || providerPeriodStart || providerPaymentTimestamp || undefined,
          current_period_end: stripePeriodEnd || providerPeriodEnd || undefined,
        };
        if (gateway === 'stripe') {
          upsertData.paystack_subscription_code = null;
          upsertData.paystack_customer_code = null;
          upsertData.stripe_subscription_id = stripeSubscriptionId || null;
          upsertData.stripe_customer_id = stripeCustomerId || null;
          upsertData.billing_interval = billingInterval;
        } else if (gateway === 'paystack') {
          upsertData.stripe_subscription_id = null;
          upsertData.stripe_customer_id = null;
          upsertData.billing_interval = billingInterval;
        }
        const { data: upsertResult, error: subscriptionUpsertError } = await service.from('subscriptions').upsert(
          upsertData,
          { onConflict: 'business_id' },
        ).select('id').single();

        if (subscriptionUpsertError) {
          console.warn('[ONBOARDING-VERIFY] Subscription upsert error:', subscriptionUpsertError);
          return NextResponse.json(
            { message: 'Subscription creation failed. Please try again.', recoverable: true },
            { status: 500 },
          );
        }
        subscription = upsertResult;
      }
    } else {
      // Free tier: upsert as active, clear gateway codes
      const upsertData: Record<string, unknown> = {
        business_id: businessId,
        plan,
        status: 'active',
        amount: tier.price ?? 0,
        gateway: null,
        currency,
        current_period_start: new Date().toISOString(),
        current_period_end: periodEnd.toISOString(),
        paystack_subscription_code: null,
        paystack_customer_code: null,
        stripe_subscription_id: null,
        stripe_customer_id: null,
      };

      const { data: upsertResult, error: subscriptionUpsertError } = await service.from('subscriptions').upsert(
        upsertData,
        { onConflict: 'business_id' },
      ).select('id').single();

      if (subscriptionUpsertError) {
        console.warn('[ONBOARDING-VERIFY] Subscription upsert error:', subscriptionUpsertError);
        return NextResponse.json(
          { message: 'Subscription creation failed. Please try again.', recoverable: true },
          { status: 500 },
        );
      }
      subscription = upsertResult;
    }

    // Record subscription payment (only for paid plans)
    let paymentEvidenceId: string | null = null;
    if (plan !== 'free' && gateway !== 'none') {
      // Fail closed: provider payment timestamp is mandatory
      if (!providerPaymentTimestamp) {
        console.warn('[ONBOARDING-VERIFY] No provider payment timestamp available');
        return NextResponse.json(
          { message: 'Payment timestamp verification failed. Please contact support.', recoverable: true },
          { status: 500 },
        );
      }

      // Resolve effective config version at provider payment time (not wall-clock)
      const { data: configVersion } = await service
        .from('platform_config_versions')
        .select('id')
        .lte('effective_from', providerPaymentTimestamp)
        .order('effective_from', { ascending: false })
        .limit(1)
        .single();

      if (!configVersion) {
        console.warn('[ONBOARDING-VERIFY] No config version found at provider payment time:', providerPaymentTimestamp);
        return NextResponse.json(
          { message: 'Platform configuration not available. Please contact support.', recoverable: true },
          { status: 500 },
        );
      }

      // Derive period from provider evidence — never from wall-clock
      const computedPeriodStart = stripePeriodStart || providerPeriodStart;
      const computedPeriodEnd = stripePeriodEnd || providerPeriodEnd;
      if (!computedPeriodStart || !computedPeriodEnd) {
        console.warn('[ONBOARDING-VERIFY] Cannot derive period from provider evidence');
        return NextResponse.json(
          { message: 'Payment period verification failed. Please contact support.', recoverable: true },
          { status: 500 },
        );
      }

      const { data: paymentEvidence, error: paymentInsertError } = await service.from('subscription_payments').insert({
        business_id: businessId,
        subscription_id: subscription?.id || null,
        amount: amountSmallest,
        currency,
        gateway,
        gateway_reference: reference,
        plan,
        action,
        status: 'success',
        config_version_id: configVersion.id,
        provider_reference: reference,
        period_start: computedPeriodStart,
        period_end: computedPeriodEnd,
        billing_interval: billingInterval,
      }).select('id').single();

      if (paymentInsertError) {
        // Same-payment replay: if insert fails due to unique constraint
        // (uq_subscription_payment_period_success), look up the existing evidence
        // and use it for idempotent activation via the RPC's idempotency path.
        const isDuplicate = paymentInsertError.code === '23505'
          || paymentInsertError.message?.includes('duplicate')
          || paymentInsertError.message?.includes('unique');

        if (isDuplicate && subscription?.id) {
          const { data: existingEvidence } = await service
            .from('subscription_payments')
            .select('id')
            .eq('subscription_id', subscription.id)
            .eq('provider_reference', reference)
            .eq('status', 'success')
            .single();

          if (existingEvidence) {
            paymentEvidenceId = existingEvidence.id;
          } else {
            console.warn('[ONBOARDING-VERIFY] Duplicate evidence but lookup failed:', paymentInsertError);
            return NextResponse.json(
              { message: 'Payment recording failed. Please contact support.', recoverable: true },
              { status: 500 },
            );
          }
        } else {
          console.warn('[ONBOARDING-VERIFY] Payment evidence insert error:', paymentInsertError);
          return NextResponse.json(
            { message: 'Payment recording failed. Please contact support.', recoverable: true },
            { status: 500 },
          );
        }
      } else {
        paymentEvidenceId = paymentEvidence?.id || null;
      }
    }

    if (plan !== 'free' && subscription?.id && paymentEvidenceId) {
      // Paid path: atomic activation via RPC — sets subscription active + business tier + allowance
      const { data: activationResult, error: activationError } = await service.rpc(
        'activate_paid_subscription',
        { p_payment_id: paymentEvidenceId },
      );

      if (activationError) {
        console.warn('[ONBOARDING-VERIFY] Paid activation RPC error:', activationError);
        return NextResponse.json(
          { message: 'Subscription activation failed. Please contact support.', recoverable: true },
          { status: 500 },
        );
      }

      if (!activationResult || activationResult.activated !== true) {
        console.warn('[ONBOARDING-VERIFY] Paid activation not confirmed:', activationResult);
        return NextResponse.json(
          { message: `Subscription activation rejected: ${activationResult?.reason || 'null_result'}`, recoverable: true },
          { status: 400 },
        );
      }

      // Post-authority provider identity update (only after successful activation)
      // For active-subscription replay, this is the only point where provider IDs change.
      if (existingSubIsActive && subscription?.id) {
        const postAuthUpdate: Record<string, unknown> = {};
        if (gateway === 'stripe') {
          if (stripeSubscriptionId) postAuthUpdate.stripe_subscription_id = stripeSubscriptionId;
          if (stripeCustomerId) postAuthUpdate.stripe_customer_id = stripeCustomerId;
        }
        if (Object.keys(postAuthUpdate).length > 0) {
          const { error: postAuthErr } = await service.from('subscriptions').update(postAuthUpdate).eq('id', subscription.id);
          if (postAuthErr) {
            console.warn('[ONBOARDING-VERIFY] Post-activation provider update error (non-fatal):', postAuthErr);
          }
        }
      }
    } else if (plan === 'free') {
      // Free path: set status + tier directly, then attempt trial activation
      const { error: bizUpdateError } = await service
        .from('businesses')
        .update({
          status: 'active',
          subscription_tier: plan,
        })
        .eq('id', businessId);

      if (!bizUpdateError) {
        try {
          await service.rpc('activate_trial_if_eligible', { p_business_id: businessId });
        } catch (trialErr) {
          console.warn('[ONBOARDING-VERIFY] Trial activation failed (non-fatal):', trialErr);
        }
      }
    }

    const { data: business } = await service
      .from('businesses')
      .select('bot_code, slug')
      .eq('id', businessId)
      .single();

    return NextResponse.json({
      status: 'success',
      business_id: businessId,
      plan,
      bot_code: business?.bot_code,
      slug: business?.slug,
    });
  } catch (error) {
    return NextResponse.json(
      { message: 'Something went wrong' },
      { status: 500 },
    );
  }
}

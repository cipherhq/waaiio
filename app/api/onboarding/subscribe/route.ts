import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { formatCurrency, type SubscriptionTier, type CountryCode } from '@/lib/constants';

const VALID_PLANS: SubscriptionTier[] = ['growth', 'business'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }

    let { business_id, plan, callback, billing_interval = 'month' } = await request.json();
    if (callback !== undefined && (!callback.startsWith('/') || callback.startsWith('//'))) callback = '/dashboard';

    if (!business_id || !plan) {
      return NextResponse.json(
        { message: 'Missing business_id or plan' },
        { status: 400 },
      );
    }

    if (!VALID_PLANS.includes(plan)) {
      return NextResponse.json(
        { message: 'Invalid plan. Must be growth or business.' },
        { status: 400 },
      );
    }

    // #270: Annual billing is not supported — reject before any provider interaction
    if (billing_interval !== 'month') {
      return NextResponse.json(
        { message: 'Only monthly billing is currently supported.' },
        { status: 400 },
      );
    }

    const { data: business } = await supabase
      .from('businesses')
      .select('id, owner_id, country_code')
      .eq('id', business_id)
      .single();

    if (!business || business.owner_id !== user.id) {
      return NextResponse.json(
        { message: 'Business not found or not owned by you' },
        { status: 403 },
      );
    }

    if (!business.country_code) {
      return NextResponse.json({ message: 'Business country code is required' }, { status: 400 });
    }
    const countryCode = business.country_code as CountryCode;

    // Read regional tier price directly from DB — fail closed, no hardcoded fallback
    const service = createServiceClient();
    const { data: countryRow, error: countryError } = await service
      .from('countries')
      .select('pricing, currency_code, payment_gateway')
      .eq('code', countryCode)
      .eq('is_active', true)
      .single();

    if (countryError || !countryRow?.pricing || !isRecord(countryRow.pricing)) {
      return NextResponse.json(
        { message: 'Regional pricing is unavailable. Please try again later.' },
        { status: 503 },
      );
    }

    const tierPricing = countryRow.pricing[plan as string];

    if (!isRecord(tierPricing) || typeof tierPricing.price !== 'number' || tierPricing.price <= 0) {
      return NextResponse.json(
        { message: 'Plan pricing is unavailable for this region.' },
        { status: 503 },
      );
    }

    const monthlyPrice = tierPricing.price;
    const currency = countryRow.currency_code as string;
    const gateway = countryRow.payment_gateway as string;

    if (!currency) {
      return NextResponse.json({ message: 'Currency not configured for this region.' }, { status: 503 });
    }
    if (!gateway) {
      return NextResponse.json({ message: 'Payment gateway not configured for this region.' }, { status: 503 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('email, phone')
      .eq('id', user.id)
      .single();

    const email = profile?.email || `${(profile?.phone || user.id).replace('+', '')}@whatsapp.waaiio.com`;
    const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com').trim();
    const callbackUrl = callback
      ? `${appUrl}${callback}`
      : `${appUrl}/get-started?step=success&business_id=${business_id}`;

    // Provider-neutral plan ref resolution
    const providerRefs = (tierPricing as Record<string, unknown>).provider_plan_refs as Record<string, string> | undefined;

    // Paystack path
    if (gateway === 'paystack') {
      const paystackKey = process.env.PAYSTACK_SECRET_KEY;
      // Resolve from provider_plan_refs with legacy fallback
      const rawPlanCode = providerRefs?.paystack || (tierPricing as Record<string, unknown>).paystack_plan_code as string | undefined;

      if (!paystackKey) {
        return NextResponse.json({ message: 'Payment gateway not configured' }, { status: 500 });
      }
      if (typeof rawPlanCode !== 'string' || rawPlanCode.trim().length === 0) {
        return NextResponse.json(
          { message: 'Subscription plan is not configured for this region.' },
          { status: 503 },
        );
      }
      const pageSlug = rawPlanCode.trim();

      const amount = monthlyPrice * 100; // kobo/pesewa

      const payload: Record<string, unknown> = {
        email,
        amount,
        currency,
        plan: pageSlug,
        callback_url: callbackUrl,
        metadata: {
          business_id,
          plan,
          billing_interval: 'month',
          type: 'whatsapp_subscription',
          user_id: user.id,
        },
      };

      const response = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${paystackKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (!data.status) {
        return NextResponse.json(
          { message: 'Failed to initialize payment', error: data.message },
          { status: 500 },
        );
      }

      return NextResponse.json({
        authorization_url: data.data.authorization_url,
        reference: data.data.reference,
      });
    }

    // Flutterwave path — durable intent + idempotent provider initialization
    if (gateway === 'flutterwave') {
      const flutterwaveKey = process.env.FLUTTERWAVE_SECRET_KEY;
      const planRef = providerRefs?.flutterwave;

      if (!flutterwaveKey) {
        return NextResponse.json({ message: 'Payment gateway not configured' }, { status: 500 });
      }
      if (typeof planRef !== 'string' || planRef.trim().length === 0) {
        return NextResponse.json(
          { message: 'Subscription plan is not configured for this region.' },
          { status: 503 },
        );
      }

      // Get current config version for CAS — service-role-accessible helper (M378)
      const { data: configVersionId, error: configErr } = await service.rpc('get_effective_config_version_id');
      if (configErr || !configVersionId) {
        return NextResponse.json({ message: 'Configuration unavailable' }, { status: 503 });
      }

      // Atomic DB claim
      const { data: claim, error: claimErr } = await service.rpc('claim_checkout_initialization', {
        p_business_id: business_id,
        p_plan: plan,
        p_gateway: 'flutterwave',
        p_currency: currency,
        p_amount: monthlyPrice,
        p_provider_plan_ref: planRef.trim(),
        p_config_version_id: configVersionId,
        p_subscriber_email: email,
        p_session_duration: 30,
        p_actor_id: user.id,
      });

      if (claimErr) {
        return NextResponse.json({ message: 'Checkout initialization failed' }, { status: 500 });
      }

      const claimRow = (claim as Record<string, unknown>[])?.[0];
      if (!claimRow) {
        return NextResponse.json({ message: 'Checkout initialization failed' }, { status: 500 });
      }

      // Reuse existing checkout if available
      if (!claimRow.is_claimed && claimRow.provider_checkout_url) {
        return NextResponse.json({
          authorization_url: claimRow.provider_checkout_url as string,
          reference: claimRow.idempotency_key as string,
        });
      }

      // Timeout boundary elapsed — verify original provider state via bounded discovery + exact-ID verify
      if (claimRow.needs_provider_verification) {
        const { discoverAndVerifyTransaction } = await import('@/lib/payments/flutterwave-verify');
        const intentCreatedAt = claimRow.intent_id ? undefined : undefined; // intent created_at not in claim result
        const verifyResult = await discoverAndVerifyTransaction(
          claimRow.idempotency_key as string,
          flutterwaveKey,
          { fromDate: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() },
        );

        if (!verifyResult.ok) {
          // Not found / ambiguous / unavailable — fail closed, retain original intent/key
          return NextResponse.json(
            { message: 'Payment status unavailable. Please try again later.' },
            { status: 503 },
          );
        }

        const { tx: verifiedTx } = verifyResult;

        if (verifiedTx.status === 'successful') {
          // Customer paid — finalize the ORIGINAL intent idempotently via authoritative finalizer
          // Resolve Flutterwave subscription
          let providerSubId = '';
          let providerPlanId = 0;
          try {
            const subLookup = await fetch(
              `https://api.flutterwave.com/v3/subscriptions?transaction_id=${verifiedTx.id}`,
              { headers: { 'Authorization': `Bearer ${flutterwaveKey}` }, signal: AbortSignal.timeout(10000) },
            );
            const subData = await subLookup.json() as { data?: { id: number; plan: number }[] };
            if (subData.data?.length) {
              providerSubId = String(subData.data[0].id);
              providerPlanId = subData.data[0].plan;
            }
          } catch { /* non-fatal */ }

          if (!providerSubId) {
            // Cannot resolve subscription — fail closed for now
            return NextResponse.json(
              { message: 'Payment completed but subscription setup pending. Please check your status.' },
              { status: 202 },
            );
          }

          const verifiedAmountMinor = Math.round(verifiedTx.amount * 100);
          await service.rpc('finalize_flutterwave_subscription_checkout', {
            p_intent_id: claimRow.intent_id,
            p_provider_tx_id: String(verifiedTx.id),
            p_provider_subscription_id: providerSubId,
            p_provider_plan_id: providerPlanId,
            p_verified_amount_minor: verifiedAmountMinor,
            p_verified_currency: verifiedTx.currency,
            p_provider_paid_at: verifiedTx.created_at,
          });

          return NextResponse.json({
            message: 'Subscription activated.',
            reference: claimRow.idempotency_key as string,
          });
        }

        if (verifiedTx.status === 'failed' || verifiedTx.status === 'cancelled') {
          // Provider confirmed terminal — replace intent with exactly one new intent
          const { data: replacement } = await service.rpc('replace_terminal_checkout_intent', {
            p_old_intent_id: claimRow.intent_id,
            p_business_id: business_id, p_plan: plan, p_gateway: 'flutterwave',
            p_currency: currency, p_amount: monthlyPrice,
            p_provider_plan_ref: planRef.trim(),
            p_config_version_id: configVersionId as string,
            p_subscriber_email: email, p_session_duration: 30, p_actor_id: user.id,
          });
          const newClaim = (replacement as Record<string, unknown>[])?.[0];
          if (!newClaim) {
            return NextResponse.json({ message: 'Checkout replacement failed' }, { status: 500 });
          }
          return NextResponse.json(
            { message: 'Previous checkout expired. Please retry.' },
            { status: 409 },
          );
        }

        // pending/unknown — checkout may still be live, retain original intent
        return NextResponse.json({
          authorization_url: claimRow.provider_checkout_url as string,
          reference: claimRow.idempotency_key as string,
        });
      }

      // If not claimed (another caller initializing), return polling response
      if (!claimRow.is_claimed) {
        return NextResponse.json(
          { message: 'Checkout is being prepared. Please retry in a moment.' },
          { status: 202 },
        );
      }

      // This caller is the exclusive initializer — call Flutterwave
      const flwResponse = await fetch('https://api.flutterwave.com/v3/payments', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${flutterwaveKey}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': claimRow.idempotency_key as string,
        },
        body: JSON.stringify({
          tx_ref: claimRow.idempotency_key as string,
          amount: monthlyPrice, // major units for Flutterwave
          currency,
          payment_plan: planRef.trim(),
          redirect_url: callbackUrl,
          customer: { email },
          meta: {
            business_id,
            plan,
            intent_id: claimRow.intent_id,
            type: 'whatsapp_subscription',
          },
          configurations: {
            session_duration: 30, // minutes — provider-side expiry
          },
        }),
      });

      let flwData: Record<string, unknown>;
      try {
        const rawResponse = await flwResponse.json();
        flwData = rawResponse as Record<string, unknown>;
      } catch {
        // Malformed response — ambiguous, retain intent with same key (Blocker C)
        return NextResponse.json(
          { message: 'Payment initialization failed. Please retry.' },
          { status: 503 },
        );
      }

      if (!flwResponse.ok || flwData.status !== 'success') {
        if (flwResponse.status >= 500) {
          // 5xx — ambiguous, retain intent + same idempotency key for retry
          return NextResponse.json(
            { message: 'Payment service temporarily unavailable. Please retry.' },
            { status: 503 },
          );
        }
        if (flwResponse.status >= 400 && flwResponse.status < 500) {
          // Definitive 4xx rejection — mark failed, free slot
          await service.from('subscription_checkout_intents')
            .update({ status: 'failed' })
            .eq('id', claimRow.intent_id as string);
          return NextResponse.json(
            { message: 'Failed to initialize payment', error: flwData.message },
            { status: 400 },
          );
        }
        // Other non-ok status — ambiguous, retain intent
        return NextResponse.json(
          { message: 'Payment service temporarily unavailable. Please retry.' },
          { status: 503 },
        );
      }

      const flwDataInner = flwData.data as Record<string, string>;

      // Persist provider response with DB-authoritative timeout (Blocker D)
      const { error: persistErr } = await service.rpc('persist_checkout_provider_response', {
        p_intent_id: claimRow.intent_id,
        p_provider_checkout_url: flwDataInner.link,
        p_idempotency_key: claimRow.idempotency_key,
      });

      if (persistErr) {
        // Persistence failed — do NOT expose checkout URL (Blocker D)
        // Intent retains same key; next retry will re-call provider with same idempotency key
        return NextResponse.json(
          { message: 'Checkout initialization failed. Please retry.' },
          { status: 500 },
        );
      }

      return NextResponse.json({
        authorization_url: flwDataInner.link,
        reference: claimRow.idempotency_key as string,
      });
    }

    // Explicit gateway dispatch — fail closed for unsupported gateways
    if (gateway !== 'stripe') {
      return NextResponse.json(
        { message: `Payment gateway "${gateway}" is not supported for subscription checkout.` },
        { status: 400 },
      );
    }

    // Stripe path
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      return NextResponse.json({ message: 'Payment gateway not configured' }, { status: 500 });
    }

    const amountInCents = Math.round(monthlyPrice * 100);
    const tierName = plan === 'growth' ? 'Pro' : 'Premium';

    const stripeBody = new URLSearchParams({
      'payment_method_types[0]': 'card',
      'line_items[0][quantity]': '1',
      mode: 'subscription',
      success_url: callbackUrl,
      cancel_url: `${(process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com').trim()}/get-started`,
      customer_email: email,
      'metadata[business_id]': business_id,
      'metadata[plan]': plan,
      'metadata[billing_interval]': 'month',
      'metadata[type]': 'whatsapp_subscription',
      'metadata[user_id]': user.id,
    });

    stripeBody.set('line_items[0][price_data][currency]', currency.toLowerCase());
    stripeBody.set('line_items[0][price_data][product_data][name]', `Waaiio ${tierName} Plan (Monthly)`);
    stripeBody.set('line_items[0][price_data][unit_amount]', String(amountInCents));
    stripeBody.set('line_items[0][price_data][recurring][interval]', 'month');

    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: stripeBody.toString(),
    });

    const data = await response.json();

    if (!data.url) {
      return NextResponse.json(
        { message: 'Failed to initialize payment', error: data.error?.message },
        { status: 500 },
      );
    }

    return NextResponse.json({
      authorization_url: data.url,
      reference: data.id,
    });
  } catch (error) {
    return NextResponse.json(
      { message: 'Something went wrong' },
      { status: 500 },
    );
  }
}

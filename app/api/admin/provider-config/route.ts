import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * Admin provider-config API — server-side provider preflight + guarded DB mutation.
 * Ordinary browser clients cannot bypass preflight because the underlying RPCs
 * are service_role only.
 *
 * Actions:
 *   save_refs — save provider plan refs for a country (with provider preflight)
 *   switch_provider — switch active gateway for a country (with readiness check)
 */
export async function POST(request: NextRequest) {
  try {
    // Authenticate admin
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Verify admin role
    const service = createServiceClient();
    const { data: adminCheck } = await service
      .from('auth_users_view')
      .select('raw_app_meta_data')
      .eq('id', user.id)
      .maybeSingle();

    const role = (adminCheck?.raw_app_meta_data as Record<string, string>)?.role;
    if (role !== 'admin') {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const body = await request.json();
    const { action } = body;

    if (action === 'save_refs') {
      const { country_code, plan_refs, expected_version_id } = body;

      if (!country_code || !plan_refs || !expected_version_id) {
        return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
      }

      // Server-side provider preflight
      for (const tier of ['growth', 'business']) {
        const tierRefs = plan_refs[tier];
        if (!tierRefs) continue;

        for (const [provider, ref] of Object.entries(tierRefs)) {
          if (!ref || typeof ref !== 'string') continue;

          if (provider === 'paystack') {
            const paystackKey = process.env.PAYSTACK_SECRET_KEY;
            if (!paystackKey) {
              return NextResponse.json({ error: 'Paystack credentials not configured' }, { status: 500 });
            }
            try {
              const planRes = await fetch(`https://api.paystack.co/plan/${encodeURIComponent(ref as string)}`, {
                headers: { 'Authorization': `Bearer ${paystackKey}` },
                signal: AbortSignal.timeout(10000),
              });
              const planData = await planRes.json() as { status?: boolean; data?: { is_archived?: boolean; interval?: string; currency?: string; amount?: number } };
              if (!planData.status || !planData.data) {
                return NextResponse.json({ error: `Paystack plan ${ref} not found` }, { status: 400 });
              }
              if (planData.data.is_archived) {
                return NextResponse.json({ error: `Paystack plan ${ref} is archived` }, { status: 400 });
              }
              if (planData.data.interval !== 'monthly') {
                return NextResponse.json({ error: `Paystack plan ${ref} is ${planData.data.interval}, not monthly` }, { status: 400 });
              }
            } catch {
              return NextResponse.json({ error: 'Paystack API unavailable for plan verification' }, { status: 503 });
            }
          }

          if (provider === 'flutterwave') {
            const flwKey = process.env.FLUTTERWAVE_SECRET_KEY;
            if (!flwKey) {
              return NextResponse.json({ error: 'Flutterwave credentials not configured' }, { status: 500 });
            }
            try {
              const planRes = await fetch(`https://api.flutterwave.com/v3/payment-plans/${encodeURIComponent(ref as string)}`, {
                headers: { 'Authorization': `Bearer ${flwKey}` },
                signal: AbortSignal.timeout(10000),
              });
              const planData = await planRes.json() as { status?: string; data?: { status?: string; interval?: string } };
              if (planData.status !== 'success' || !planData.data) {
                return NextResponse.json({ error: `Flutterwave plan ${ref} not found` }, { status: 400 });
              }
              if (planData.data.status !== 'active') {
                return NextResponse.json({ error: `Flutterwave plan ${ref} is ${planData.data.status}, not active` }, { status: 400 });
              }
              if (planData.data.interval !== 'monthly') {
                return NextResponse.json({ error: `Flutterwave plan ${ref} is ${planData.data.interval}, not monthly` }, { status: 400 });
              }
            } catch {
              return NextResponse.json({ error: 'Flutterwave API unavailable for plan verification' }, { status: 503 });
            }
          }

          if (provider === 'stripe') {
            const stripeKey = process.env.STRIPE_SECRET_KEY;
            if (!stripeKey) {
              return NextResponse.json({ error: 'Stripe credentials not configured' }, { status: 500 });
            }
          }
        }
      }

      // Preflight passed — call privileged RPC via service_role
      const { data, error } = await service.rpc('save_provider_plan_refs', {
        p_country_code: country_code,
        p_plan_refs: plan_refs,
        p_expected_version_id: expected_version_id,
        p_actor_id: user.id,
      });

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }

      return NextResponse.json({ version_id: data });
    }

    if (action === 'switch_provider') {
      const { country_code, new_gateway, expected_version_id } = body;

      if (!country_code || !new_gateway || !expected_version_id) {
        return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
      }

      // Provider credential readiness check
      if (new_gateway === 'paystack' && !process.env.PAYSTACK_SECRET_KEY) {
        return NextResponse.json({ error: 'Paystack credentials not configured' }, { status: 500 });
      }
      if (new_gateway === 'flutterwave' && !process.env.FLUTTERWAVE_SECRET_KEY) {
        return NextResponse.json({ error: 'Flutterwave credentials not configured' }, { status: 500 });
      }
      if (new_gateway === 'stripe' && !process.env.STRIPE_SECRET_KEY) {
        return NextResponse.json({ error: 'Stripe credentials not configured' }, { status: 500 });
      }

      const { data, error } = await service.rpc('switch_country_provider', {
        p_country_code: country_code,
        p_new_gateway: new_gateway,
        p_expected_version_id: expected_version_id,
        p_actor_id: user.id,
      });

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }

      return NextResponse.json({ version_id: data });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal error' }, { status: 500 });
  }
}

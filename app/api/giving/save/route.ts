import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getConfiguredCapabilities } from '@/lib/capabilities/service';
import { getEffectiveCapabilities } from '@/lib/capabilities/policy';
import { buildGivingServicePayload, type GivingServiceInput } from '@/lib/services/payload-builders';

const SUPPORTED_INTERVALS = new Set(['weekly', 'monthly']);

/**
 * POST /api/giving/save
 *
 * Server-authoritative Giving category create/update with recurring
 * eligibility enforcement (#224). Rejects recurring configuration when
 * business lacks recurring_enabled or effective recurring capability.
 *
 * Body: {
 *   businessId: string,
 *   serviceId?: string,         // null/undefined = create, string = update
 *   name: string,
 *   description: string,
 *   fixedAmount: boolean,
 *   price: number,
 *   isRecurring: boolean,
 *   interval: 'weekly' | 'monthly',
 * }
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ success: false, reason: 'unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch {
    return NextResponse.json({ success: false, reason: 'invalid_body' }, { status: 400 });
  }

  const businessId = body.businessId as string;
  const serviceId = body.serviceId as string | undefined;
  const name = body.name as string;
  const description = (body.description as string) || '';
  const fixedAmount = body.fixedAmount === true;
  const price = Number(body.price) || 0;
  const isRecurring = body.isRecurring === true;
  const interval = (body.interval as string) || 'monthly';

  if (!businessId || !name?.trim()) {
    return NextResponse.json({ success: false, reason: 'missing_required_fields' }, { status: 400 });
  }

  // Verify business ownership
  const { data: business } = await supabase
    .from('businesses')
    .select('id, owner_id, recurring_enabled, subscription_tier, trial_ends_at, capability_overrides')
    .eq('id', businessId)
    .single();

  if (!business || business.owner_id !== user.id) {
    return NextResponse.json({ success: false, reason: 'unauthorized' }, { status: 403 });
  }

  // If recurring is requested, enforce the effective recurring eligibility
  if (isRecurring) {
    // Gate 1: business recurring_enabled kill switch
    if (!business.recurring_enabled) {
      return NextResponse.json({
        success: false,
        reason: 'recurring_not_enabled',
        message: 'Enable Recurring Payments in Settings > Payments first.',
      }, { status: 400 });
    }

    // Gate 2: effective recurring capability (policy-aware: tier + trial + overrides)
    const configResult = await getConfiguredCapabilities(supabase, businessId);
    if (!configResult.ok) {
      return NextResponse.json({ success: false, reason: 'capability_check_failed' }, { status: 500 });
    }

    const effectiveCaps = getEffectiveCapabilities({
      configuredCapabilities: configResult.rows,
      tier: business.subscription_tier || 'free',
      trialEndsAt: business.trial_ends_at || null,
      overrides: (business.capability_overrides as string[]) || [],
    });

    if (!effectiveCaps.effective.includes('recurring')) {
      const isBlocked = effectiveCaps.blocked.some(b => b.capability === 'recurring');
      return NextResponse.json({
        success: false,
        reason: 'recurring_capability_not_effective',
        message: isBlocked
          ? 'Recurring is paused due to your current plan. Upgrade to activate.'
          : 'Enable the Recurring capability in Settings > Capabilities first.',
      }, { status: 400 });
    }

    // Gate 3: supported interval
    if (!SUPPORTED_INTERVALS.has(interval)) {
      return NextResponse.json({
        success: false,
        reason: 'unsupported_interval',
        message: `Interval "${interval}" is not supported. Use weekly or monthly.`,
      }, { status: 400 });
    }
  }

  // Build the payload
  const payload = buildGivingServicePayload({
    businessId,
    name,
    description,
    fixedAmount,
    price,
    isRecurring,
    interval: interval as GivingServiceInput['interval'],
  });

  // Create or update
  if (serviceId) {
    // Update — verify the service belongs to this business
    const { error } = await supabase
      .from('services')
      .update(payload)
      .eq('id', serviceId)
      .eq('business_id', businessId);

    if (error) {
      return NextResponse.json({ success: false, reason: 'update_failed', message: error.message }, { status: 500 });
    }
  } else {
    // Create — find max sort_order
    const { data: existing } = await supabase
      .from('services')
      .select('sort_order')
      .eq('business_id', businessId)
      .eq('service_type', 'giving')
      .is('deleted_at', null)
      .order('sort_order', { ascending: false })
      .limit(1);

    const maxOrder = existing && existing.length > 0 ? existing[0].sort_order + 1 : 0;

    const { error } = await supabase
      .from('services')
      .insert({ ...payload, sort_order: maxOrder });

    if (error) {
      return NextResponse.json({ success: false, reason: 'insert_failed', message: error.message }, { status: 500 });
    }
  }

  return NextResponse.json({ success: true });
}

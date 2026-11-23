import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';
import { getLimitTier } from '@/lib/capabilities/policy';
import { weekEnd, weekStart } from '@/lib/products/availability';
import {
  MENU_BUSINESS_COLUMNS,
  menuDay,
  menuPhotoDailyLimit,
  validateWeeklyMenuItems,
  type MenuBusiness,
} from '@/lib/products/weekly-menu';

/**
 * "Upload this week's menu" (Owner decisions 2026-11-23, M556).
 *
 * GET  ?business_id=  → today's menu photo reads (limit, used, left) and this week's dates.
 * POST { business_id, items } → saves the owner-confirmed dishes for this week
 *      (Mon–Sun in the business's timezone) and hides the previous weekly-menu
 *      dishes, in one transaction (public.save_weekly_menu). Ace reads photos
 *      through /api/ai-setup/parse-image (mode weekly_menu); nothing is saved
 *      until this POST.
 */

async function ownedBusiness(businessId: unknown) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (typeof businessId !== 'string' || !businessId) {
    return { response: NextResponse.json({ error: 'Missing business_id' }, { status: 400 }) };
  }
  const { data: biz } = await supabase
    .from('businesses')
    .select(MENU_BUSINESS_COLUMNS)
    .eq('id', businessId)
    .eq('owner_id', user.id)
    .maybeSingle();
  if (!biz) return { response: NextResponse.json({ error: 'Business not found' }, { status: 404 }) };
  return { biz: biz as MenuBusiness & { id: string } };
}

function thisWeek(biz: MenuBusiness) {
  const today = menuDay(biz);
  return { today, week_start: weekStart(today.date), week_end: weekEnd(today.date) };
}

export async function GET(request: NextRequest) {
  const { biz, response } = await ownedBusiness(request.nextUrl.searchParams.get('business_id'));
  if (!biz) return response;

  const { today, week_start, week_end } = thisWeek(biz);
  const limit = menuPhotoDailyLimit(biz);
  // menu_photo_reads is service-role only (M556).
  const { data, error } = await createServiceClient()
    .from('menu_photo_reads')
    .select('read_count')
    .eq('business_id', biz.id)
    .eq('read_date', today.date)
    .maybeSingle();
  if (error) {
    logger.error('[WEEKLY-MENU] Read count lookup error:', error.message);
    return NextResponse.json({ error: 'Could not load your menu reads. Please try again.' }, { status: 503 });
  }
  const used = Math.min(limit, Number((data as { read_count?: number } | null)?.read_count ?? 0));
  return NextResponse.json({
    limit,
    used,
    left: limit - used,
    // Free plan outside the feature trial: the upload screen shows an upgrade hint.
    on_free_plan: getLimitTier(biz.subscription_tier, biz.feature_trial_ends_at) === 'free',
    week_start,
    week_end,
  });
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const { biz, response } = await ownedBusiness(body?.business_id);
  if (!biz) return response;

  const checked = validateWeeklyMenuItems(body.items);
  if ('error' in checked) return NextResponse.json({ error: checked.error }, { status: 400 });

  const { week_start, week_end } = thisWeek(biz);
  const { data, error } = await createServiceClient().rpc('save_weekly_menu', {
    p_business_id: biz.id,
    p_week_start: week_start,
    p_items: checked.items,
  });
  if (error) {
    logger.error('[WEEKLY-MENU] Save error:', error.message);
    return NextResponse.json({ error: 'Could not save your menu. Nothing was changed. Please try again.' }, { status: 500 });
  }
  return NextResponse.json({ success: true, week_start, week_end, ...(data as Record<string, unknown>) });
}

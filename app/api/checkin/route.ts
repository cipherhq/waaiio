import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { createClient } from '@/lib/supabase/server';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

/**
 * POST /api/checkin
 * Public endpoint — guest checks in at a business location.
 * Records attendance in attendance_log table.
 */
export async function POST(request: NextRequest) {
  const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'attendance-checkin'), 10, 60_000);
  if (rateLimit) return rateLimit;

  try {
    const { business_id, customer_name, customer_phone, customer_email, notes } = await request.json();

    // Input validation (ATT-05)
    const trimmedName = customer_name?.trim() || '';
    if (!business_id || !trimmedName) {
      return NextResponse.json({ error: 'business_id and customer_name are required' }, { status: 400 });
    }
    if (trimmedName.length > 200) {
      return NextResponse.json({ error: 'Name must be 200 characters or less' }, { status: 400 });
    }
    const cleanPhone = customer_phone ? String(customer_phone).replace(/\D/g, '') : '';
    if (cleanPhone && (cleanPhone.length < 7 || cleanPhone.length > 20)) {
      return NextResponse.json({ error: 'Invalid phone number' }, { status: 400 });
    }
    const trimmedEmail = customer_email?.trim() || '';
    if (trimmedEmail && (trimmedEmail.length > 320 || !trimmedEmail.includes('@'))) {
      return NextResponse.json({ error: 'Invalid email address' }, { status: 400 });
    }
    const trimmedNotes = notes?.trim() || '';
    if (trimmedNotes.length > 2000) {
      return NextResponse.json({ error: 'Notes must be 2000 characters or less' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Verify business exists and is active
    const { data: business } = await supabase
      .from('businesses')
      .select('id, name, phone, assigned_channel_id, whatsapp_channel_id, wa_method, bot_code')
      .eq('id', business_id)
      .eq('is_active', true)
      .maybeSingle();

    if (!business) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }

    // Duplicate check: same business + phone + today
    if (cleanPhone) {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);

      const { data: existing } = await supabase
        .from('attendance_log')
        .select('id, checked_in_at')
        .eq('business_id', business_id)
        .eq('customer_phone', cleanPhone)
        .gte('checked_in_at', todayStart.toISOString())
        .lte('checked_in_at', todayEnd.toISOString())
        .limit(1)
        .maybeSingle();

      if (existing) {
        const waLink = await resolveWaLink(supabase, business);
        return NextResponse.json({
          success: true,
          already_checked_in: true,
          checked_in_at: existing.checked_in_at,
          wa_link: waLink,
        });
      }
    }

    // Insert attendance record
    const { error: insertError } = await supabase
      .from('attendance_log')
      .insert({
        business_id,
        customer_name: trimmedName,
        customer_phone: cleanPhone || null,
        customer_email: trimmedEmail || null,
        notes: trimmedNotes || null,
        source: 'web',
      });

    if (insertError) {
      logger.error('[CHECKIN] Insert error:', insertError.message);
      return NextResponse.json({ error: 'Failed to record check-in' }, { status: 500 });
    }

    const waLink = await resolveWaLink(supabase, business);

    return NextResponse.json({ success: true, wa_link: waLink });
  } catch (err) {
    logger.error('[CHECKIN] POST error:', err);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}

/**
 * GET /api/checkin?business_id=...&date=YYYY-MM-DD&page=0&limit=50
 * Authenticated — returns attendance entries for business owner.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const businessId = searchParams.get('business_id');
    if (!businessId) {
      return NextResponse.json({ error: 'business_id is required' }, { status: 400 });
    }

    // Verify ownership
    const { data: biz } = await supabase
      .from('businesses')
      .select('id')
      .eq('id', businessId)
      .eq('owner_id', user.id)
      .maybeSingle();

    if (!biz) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }

    const date = searchParams.get('date') || new Date().toISOString().split('T')[0];
    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) {
      return NextResponse.json({ error: 'Invalid date format. Use YYYY-MM-DD.' }, { status: 400 });
    }
    const page = parseInt(searchParams.get('page') || '0');
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100);
    if (isNaN(page) || page < 0) {
      return NextResponse.json({ error: 'Invalid page parameter' }, { status: 400 });
    }
    if (isNaN(limit) || limit < 1) {
      return NextResponse.json({ error: 'Invalid limit parameter' }, { status: 400 });
    }

    const dayStart = `${date}T00:00:00.000Z`;
    const dayEnd = `${date}T23:59:59.999Z`;

    const { data: entries, count, error: queryError } = await supabase
      .from('attendance_log')
      .select('*', { count: 'exact' })
      .eq('business_id', businessId)
      .gte('checked_in_at', dayStart)
      .lte('checked_in_at', dayEnd)
      .order('checked_in_at', { ascending: false })
      .range(page * limit, (page + 1) * limit - 1);

    if (queryError) {
      logger.error('[CHECKIN] GET query error:', queryError.message);
      return NextResponse.json({ error: 'Failed to load attendance data' }, { status: 500 });
    }

    return NextResponse.json({ entries: entries || [], total: count || 0 });
  } catch (err) {
    logger.error('[CHECKIN] GET error:', err);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}

/** Resolve the WhatsApp link for the business */
async function resolveWaLink(
  supabase: ReturnType<typeof createServiceClient>,
  business: { id: string; phone: string | null; assigned_channel_id: string | null; whatsapp_channel_id: string | null; wa_method: string | null; bot_code: string | null },
): Promise<string> {
  try {
    const channelId = business.assigned_channel_id || business.whatsapp_channel_id;

    const [assignedResult, dedicatedResult, sharedResult] = await Promise.all([
      channelId
        ? supabase.from('whatsapp_channels').select('phone_number').eq('id', channelId).eq('is_active', true).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase.from('whatsapp_channels').select('phone_number')
        .eq('business_id', business.id).eq('channel_type', 'dedicated').eq('is_active', true).maybeSingle(),
      supabase.from('whatsapp_channels').select('phone_number')
        .eq('channel_type', 'shared').eq('is_active', true).limit(1).maybeSingle(),
    ]);

    const phone = (
      assignedResult.data?.phone_number ||
      dedicatedResult.data?.phone_number ||
      sharedResult.data?.phone_number ||
      business.phone ||
      ''
    ).replace(/[^0-9]/g, '');

    const isShared = !business.wa_method || business.wa_method === 'shared';
    const prefill = isShared && business.bot_code ? business.bot_code : 'Hi';

    return `https://wa.me/${phone}?text=${encodeURIComponent(prefill)}`;
  } catch {
    return '';
  }
}

import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync } from '@/lib/rate-limit';
import { type SubscriptionTier } from '@/lib/constants';
import { loadPlatformSettings } from '@/lib/platformSettings';
import { logger } from '@/lib/logger';

/** POST — schedule a broadcast for future delivery */
export async function POST(request: NextRequest) {
  try {
    const limit = await rateLimitResponseAsync('broadcast-schedule:' + (request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'), 10, 3600_000);
    if (limit) return limit;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { business_id, message, phones, template_name, scheduled_at, audience_filter } = body as {
      business_id: string;
      message: string;
      phones: string[];
      template_name?: string;
      scheduled_at: string;
      audience_filter?: Record<string, unknown>;
    };

    if (!business_id || !message || !phones?.length || !scheduled_at) {
      return NextResponse.json({ message: 'Missing required fields' }, { status: 400 });
    }

    if (phones.length > 500) {
      return NextResponse.json({ message: 'Maximum 500 recipients per broadcast' }, { status: 400 });
    }

    const scheduleDate = new Date(scheduled_at);
    if (isNaN(scheduleDate.getTime()) || scheduleDate.getTime() < Date.now() + 60_000) {
      return NextResponse.json({ message: 'Scheduled time must be at least 1 minute in the future' }, { status: 400 });
    }

    const service = createServiceClient();
    const { data: business } = await service
      .from('businesses')
      .select('id, owner_id, subscription_tier')
      .eq('id', business_id)
      .eq('owner_id', user.id)
      .single();

    if (!business) return NextResponse.json({ message: 'Business not found' }, { status: 404 });

    const tier = (business.subscription_tier || 'free') as SubscriptionTier;
    if (tier === 'free') {
      return NextResponse.json({ message: 'Broadcasts require a Pro+ plan' }, { status: 403 });
    }

    // Check monthly limits
    const settings = await loadPlatformSettings({ useServiceClient: true });
    const limits = settings.broadcast_limits[tier];
    const monthKey = new Date().toISOString().slice(0, 7);
    const { data: usage } = await service
      .from('broadcast_usage')
      .select('broadcast_count, recipient_count')
      .eq('business_id', business_id)
      .eq('month_key', monthKey)
      .maybeSingle();

    const currentBroadcasts = usage?.broadcast_count ?? 0;
    const currentRecipients = usage?.recipient_count ?? 0;

    if (limits.maxBroadcasts !== Infinity && currentBroadcasts >= limits.maxBroadcasts) {
      return NextResponse.json({ message: 'Monthly broadcast limit reached' }, { status: 429 });
    }
    if (limits.maxRecipients !== Infinity && currentRecipients + phones.length > limits.maxRecipients) {
      return NextResponse.json({ message: 'Monthly recipient limit would be exceeded' }, { status: 429 });
    }

    // Save scheduled broadcast
    const { data: broadcast, error } = await service
      .from('business_broadcasts')
      .insert({
        business_id,
        created_by: user.id,
        message: message.trim(),
        template_name: template_name || null,
        audience_filter: audience_filter || {},
        phones,
        recipient_count: phones.length,
        status: 'scheduled',
        scheduled_at: scheduleDate.toISOString(),
      })
      .select('id, scheduled_at')
      .single();

    if (error) {
      logger.error('[BROADCAST SCHEDULE] Insert error:', error);
      return NextResponse.json({ message: 'Failed to schedule broadcast' }, { status: 500 });
    }

    return NextResponse.json({ id: broadcast.id, scheduled_at: broadcast.scheduled_at, recipient_count: phones.length });
  } catch (error) {
    logger.error('[BROADCAST SCHEDULE] Error:', error);
    return NextResponse.json({ message: 'Something went wrong' }, { status: 500 });
  }
}

/** GET — list scheduled broadcasts for a business */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });

  const businessId = new URL(request.url).searchParams.get('business_id');
  if (!businessId) return NextResponse.json({ message: 'Missing business_id' }, { status: 400 });

  const service = createServiceClient();
  const { data: business } = await service
    .from('businesses')
    .select('id')
    .eq('id', businessId)
    .eq('owner_id', user.id)
    .single();

  if (!business) return NextResponse.json({ message: 'Business not found' }, { status: 404 });

  const { data: broadcasts } = await service
    .from('business_broadcasts')
    .select('id, message, template_name, recipient_count, status, scheduled_at, sent_at, sent_count, failed_count, created_at')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(50);

  return NextResponse.json({ broadcasts: broadcasts || [] });
}

/** DELETE — cancel a scheduled broadcast */
export async function DELETE(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });

  const { id, business_id } = await request.json();
  if (!id || !business_id) return NextResponse.json({ message: 'Missing id or business_id' }, { status: 400 });

  const service = createServiceClient();
  const { data: business } = await service
    .from('businesses')
    .select('id')
    .eq('id', business_id)
    .eq('owner_id', user.id)
    .single();

  if (!business) return NextResponse.json({ message: 'Business not found' }, { status: 404 });

  const { error } = await service
    .from('business_broadcasts')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .eq('business_id', business_id)
    .eq('status', 'scheduled');

  if (error) {
    return NextResponse.json({ message: 'Failed to cancel' }, { status: 500 });
  }

  return NextResponse.json({ cancelled: true });
}

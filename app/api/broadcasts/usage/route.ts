import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { type SubscriptionTier } from '@/lib/constants';
import { loadPlatformSettings } from '@/lib/platformSettings';

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }

    const businessId = request.nextUrl.searchParams.get('business_id');
    if (!businessId) {
      return NextResponse.json({ message: 'Missing business_id' }, { status: 400 });
    }

    const service = createServiceClient();

    // Verify ownership + get tier
    const { data: business } = await service
      .from('businesses')
      .select('id, subscription_tier')
      .eq('id', businessId)
      .eq('owner_id', user.id)
      .single();

    if (!business) {
      return NextResponse.json({ message: 'Business not found' }, { status: 404 });
    }

    const tier = (business.subscription_tier || 'free') as SubscriptionTier;
    const settings = await loadPlatformSettings({ useServiceClient: true });
    const limits = settings.broadcast_limits[tier];
    const monthKey = new Date().toISOString().slice(0, 7);

    const { data: usage } = await service
      .from('broadcast_usage')
      .select('broadcast_count, recipient_count')
      .eq('business_id', businessId)
      .eq('month_key', monthKey)
      .maybeSingle();

    return NextResponse.json({
      broadcast_count: usage?.broadcast_count ?? 0,
      recipient_count: usage?.recipient_count ?? 0,
      limits: {
        maxBroadcasts: limits.maxBroadcasts,
        maxRecipients: limits.maxRecipients,
      },
      tier,
    });
  } catch (error) {
    return NextResponse.json(
      { message: 'Something went wrong' },
      { status: 500 },
    );
  }
}

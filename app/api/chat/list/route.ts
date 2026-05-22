import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get('businessId');
  if (!businessId) {
    return NextResponse.json({ error: 'businessId required' }, { status: 400 });
  }

  const assignedFilter = request.nextUrl.searchParams.get('assigned');

  // Auth: allow owner OR active team member
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const service = createServiceClient();

  const { data: biz } = await service
    .from('businesses')
    .select('owner_id')
    .eq('id', businessId)
    .single();

  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

  const isOwner = biz.owner_id === user.id;
  let currentMemberId: string | null = null;

  if (!isOwner) {
    const { data: membership } = await service
      .from('business_members')
      .select('id')
      .eq('business_id', businessId)
      .eq('user_id', user.id)
      .eq('status', 'active')
      .maybeSingle();

    if (!membership) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }
    currentMemberId = membership.id;
  } else {
    // Owner might also have a business_members record
    const { data: ownerMembership } = await service
      .from('business_members')
      .select('id')
      .eq('business_id', businessId)
      .eq('user_id', user.id)
      .eq('status', 'active')
      .maybeSingle();
    currentMemberId = ownerMembership?.id || null;
  }

  // Build conversations query
  let convQuery = service
    .from('chat_conversations')
    .select('*, assigned_to')
    .eq('business_id', businessId)
    .order('last_message_at', { ascending: false })
    .limit(50);

  // Filter by assignment if requested
  if (assignedFilter === 'me' && currentMemberId) {
    convQuery = convQuery.eq('assigned_to', currentMemberId);
  } else if (assignedFilter === 'unassigned') {
    convQuery = convQuery.is('assigned_to', null);
  }

  const [convRes, msgRes] = await Promise.all([
    convQuery,
    service
      .from('chat_messages')
      .select('*')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false })
      .limit(500),
  ]);

  return NextResponse.json({
    conversations: convRes.data || [],
    messages: msgRes.data || [],
    currentMemberId,
  });
}

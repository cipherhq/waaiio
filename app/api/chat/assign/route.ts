import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { conversationId, assignedTo } = await request.json();
    if (!conversationId) {
      return NextResponse.json({ error: 'conversationId required' }, { status: 400 });
    }

    const service = createServiceClient();

    // Get conversation to find business_id
    const { data: conv } = await service
      .from('chat_conversations')
      .select('id, business_id')
      .eq('id', conversationId)
      .single();

    if (!conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    // Check if user is owner, admin, or manager for this business
    const { data: biz } = await service
      .from('businesses')
      .select('owner_id')
      .eq('id', conv.business_id)
      .single();

    if (!biz) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }

    const isOwner = biz.owner_id === user.id;
    if (!isOwner) {
      const { data: membership } = await service
        .from('business_members')
        .select('role')
        .eq('business_id', conv.business_id)
        .eq('user_id', user.id)
        .eq('status', 'active')
        .maybeSingle();

      if (!membership || !['admin', 'manager'].includes(membership.role as string)) {
        return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
      }
    }

    // Update assignment
    const { error } = await service
      .from('chat_conversations')
      .update({
        assigned_to: assignedTo || null,
        assigned_at: assignedTo ? new Date().toISOString() : null,
      })
      .eq('id', conversationId);

    if (error) {
      logger.error('[CHAT] Assign error:', error.message);
      return NextResponse.json({ error: 'Failed to assign conversation' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[CHAT] Assign error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

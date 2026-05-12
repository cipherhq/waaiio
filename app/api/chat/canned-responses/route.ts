import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { authenticateRequest } from '@/lib/api-auth';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export async function GET(request: NextRequest) {
  try {
    const rateLimit = rateLimitResponse(getRateLimitKey(request, 'canned-get'), 30, 60_000);
    if (rateLimit) return rateLimit;

    const auth = await authenticateRequest(request, { requireBusinessOwnership: true });
    if (auth instanceof NextResponse) return auth;

    const businessId = request.nextUrl.searchParams.get('businessId');
    if (!businessId) {
      return NextResponse.json({ error: 'businessId required' }, { status: 400 });
    }

    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from('canned_responses')
      .select('id, title, message_text, shortcut, sort_order')
      .eq('business_id', businessId)
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (error) {
      logger.error('[CANNED] GET db error:', error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    return NextResponse.json({ responses: data || [] });
  } catch (error) {
    logger.error('[CANNED] GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const rateLimit = rateLimitResponse(getRateLimitKey(request, 'canned-post'), 30, 60_000);
    if (rateLimit) return rateLimit;

    const body = await request.json();
    const auth = await authenticateRequest(request, { requireBusinessOwnership: true, body });
    if (auth instanceof NextResponse) return auth;

    const { businessId, title, messageText, shortcut } = body;
    if (!businessId || !title || !messageText) {
      return NextResponse.json({ error: 'businessId, title, and messageText required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Get next sort_order
    const { data: existing } = await supabase
      .from('canned_responses')
      .select('sort_order')
      .eq('business_id', businessId)
      .order('sort_order', { ascending: false })
      .limit(1);

    const nextOrder = existing && existing.length > 0 ? existing[0].sort_order + 1 : 0;

    const { data, error } = await supabase
      .from('canned_responses')
      .insert({
        business_id: businessId,
        title,
        message_text: messageText,
        shortcut: shortcut || null,
        sort_order: nextOrder,
      })
      .select()
      .single();

    if (error) {
      logger.error('[CANNED] POST db error:', error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    return NextResponse.json({ response: data });
  } catch (error) {
    logger.error('[CANNED] POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const rateLimit = rateLimitResponse(getRateLimitKey(request, 'canned-put'), 30, 60_000);
    if (rateLimit) return rateLimit;

    const body = await request.json();
    const auth = await authenticateRequest(request, { requireBusinessOwnership: true, body });
    if (auth instanceof NextResponse) return auth;

    const { id, businessId, title, messageText, shortcut, isActive } = body;
    if (!id || !businessId) {
      return NextResponse.json({ error: 'id and businessId required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    const updates: Record<string, unknown> = {};
    if (title !== undefined) updates.title = title;
    if (messageText !== undefined) updates.message_text = messageText;
    if (shortcut !== undefined) updates.shortcut = shortcut;
    if (isActive !== undefined) updates.is_active = isActive;

    const { error } = await supabase
      .from('canned_responses')
      .update(updates)
      .eq('id', id)
      .eq('business_id', businessId);

    if (error) {
      logger.error('[CANNED] PUT db error:', error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[CANNED] PUT error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const rateLimit = rateLimitResponse(getRateLimitKey(request, 'canned-delete'), 30, 60_000);
    if (rateLimit) return rateLimit;

    const body = await request.json();
    const auth = await authenticateRequest(request, { requireBusinessOwnership: true, body });
    if (auth instanceof NextResponse) return auth;

    const { id, businessId } = body;
    if (!id || !businessId) {
      return NextResponse.json({ error: 'id and businessId required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    const { error } = await supabase
      .from('canned_responses')
      .delete()
      .eq('id', id)
      .eq('business_id', businessId);

    if (error) {
      logger.error('[CANNED] DELETE db error:', error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[CANNED] DELETE error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

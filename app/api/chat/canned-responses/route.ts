import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

export async function GET(request: NextRequest) {
  try {
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
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ responses: data || [] });
  } catch (error) {
    console.error('[CANNED] GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { businessId, title, messageText, shortcut } = await request.json();
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
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ response: data });
  } catch (error) {
    console.error('[CANNED] POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { id, businessId, title, messageText, shortcut, isActive } = await request.json();
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
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[CANNED] PUT error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { id, businessId } = await request.json();
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
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[CANNED] DELETE error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

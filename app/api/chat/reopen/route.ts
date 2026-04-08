import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

export async function POST(request: NextRequest) {
  try {
    const { businessId, customerPhone } = await request.json();
    if (!businessId || !customerPhone) {
      return NextResponse.json({ error: 'businessId and customerPhone required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    await supabase.from('chat_conversations').update({
      status: 'open',
      resolved_at: null,
      resolved_by: null,
    })
      .eq('business_id', businessId)
      .eq('customer_phone', customerPhone);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[CHAT] Reopen error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

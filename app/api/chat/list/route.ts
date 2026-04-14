import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest } from '@/lib/api-auth';

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get('businessId');
  if (!businessId) {
    return NextResponse.json({ error: 'businessId required' }, { status: 400 });
  }

  const auth = await authenticateRequest(request, {
    requireBusinessOwnership: true,
    body: { businessId },
  });
  if (auth instanceof NextResponse) return auth;

  const { service } = auth;

  const [convRes, msgRes] = await Promise.all([
    service
      .from('chat_conversations')
      .select('*')
      .eq('business_id', businessId)
      .order('last_message_at', { ascending: false }),
    service
      .from('chat_messages')
      .select('*')
      .eq('business_id', businessId)
      .order('created_at', { ascending: true }),
  ]);

  return NextResponse.json({
    conversations: convRes.data || [],
    messages: msgRes.data || [],
  });
}

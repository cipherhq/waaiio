/**
 * GET /api/admin/chat-history — live-chat conversations for the admin Chat
 * History page (#1108 X3).
 *
 *   GET                         → { conversations } (latest 500, with business names)
 *   GET ?conversationId=<uuid>  → { messages } (first 200 of that conversation)
 *
 * chat_conversations and chat_messages have owner-only RLS, so the browser
 * client saw no rows and the page showed an empty list.
 */
import type { NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { adminPreflight, adminResponder, businessNames, UUID_RE } from '@/lib/admin-route';

const METHODS = 'GET, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return adminPreflight(request, METHODS);
}

export async function GET(request: NextRequest) {
  const reply = adminResponder(request, METHODS);
  // Same roles that can open the Chat History page (admin/src/lib/permissions.ts).
  const admin = await requirePlatformAdmin(request, { requiredRole: ['admin', 'support', 'operations'] });
  if (!admin) return reply({ error: 'Unauthorized' }, 403);
  const service = createServiceClient();

  const conversationId = request.nextUrl.searchParams.get('conversationId');
  if (conversationId !== null) {
    if (!UUID_RE.test(conversationId)) return reply({ error: 'Invalid conversation ID' }, 400);
    const { data, error } = await service.from('chat_messages')
      .select('id, conversation_id, direction, message_text, media_type, created_at')
      .eq('conversation_id', conversationId).order('created_at', { ascending: true }).limit(200);
    if (error) return reply({ error: 'Could not load messages' }, 500);
    return reply({ messages: data || [] });
  }

  const { data, error } = await service.from('chat_conversations')
    .select('id, business_id, customer_phone, customer_name, status, last_message_at, created_at')
    .order('last_message_at', { ascending: false }).limit(500);
  if (error) return reply({ error: 'Could not load conversations' }, 500);
  const rows = (data || []) as Array<{ business_id: string }>;
  const names = await businessNames(service, rows.map(r => r.business_id));
  return reply({ conversations: rows.map(r => ({ ...r, business_name: names.get(r.business_id) || 'Unknown' })) });
}

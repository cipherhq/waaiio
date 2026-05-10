/**
 * Supabase Edge Function: session-cleanup
 *
 * Runs every 6 hours to clean up expired bot sessions.
 * - Deactivates sessions past their expires_at
 * - Deletes old inactive sessions (> 7 days)
 * - Resolves orphaned chat conversations
 *
 * CRON schedule: every 6 hours
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async () => {
  const supabase = createClient(supabaseUrl, supabaseKey);
  const now = new Date().toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  let deactivated = 0;
  let deleted = 0;
  let chatsResolved = 0;

  try {
    // 1. Deactivate expired sessions (still marked active but past expires_at)
    const { data: expired } = await supabase
      .from('bot_sessions')
      .update({ is_active: false })
      .eq('is_active', true)
      .lt('expires_at', now)
      .select('id');

    deactivated = expired?.length || 0;

    // 2. Delete old inactive sessions (> 7 days old, not active)
    const { data: old } = await supabase
      .from('bot_sessions')
      .delete()
      .eq('is_active', false)
      .lt('created_at', sevenDaysAgo)
      .select('id');

    deleted = old?.length || 0;

    // 3. Resolve orphaned chat conversations (open but no session)
    const { data: openChats } = await supabase
      .from('chat_conversations')
      .select('id, customer_phone, business_id')
      .eq('status', 'open')
      .lt('last_message_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    for (const chat of openChats || []) {
      // Check if there's an active session for this customer+business
      const { data: session } = await supabase
        .from('bot_sessions')
        .select('id')
        .eq('whatsapp_number', chat.customer_phone)
        .eq('business_id', chat.business_id)
        .eq('is_active', true)
        .maybeSingle();

      if (!session) {
        // No active session — resolve the orphaned chat
        await supabase
          .from('chat_conversations')
          .update({
            status: 'resolved',
            resolved_at: now,
          })
          .eq('id', chat.id);
        chatsResolved++;
      }
    }

    console.log(`[SESSION-CLEANUP] Deactivated: ${deactivated}, Deleted: ${deleted}, Chats resolved: ${chatsResolved}`);

    return new Response(
      JSON.stringify({ deactivated, deleted, chatsResolved }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('[SESSION-CLEANUP] Error:', err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
});

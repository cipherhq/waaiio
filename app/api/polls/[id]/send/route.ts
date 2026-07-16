import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { rateLimitResponseAsync } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const { id: pollId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { phones } = await request.json() as { phones: string[] };
  if (!phones?.length) return NextResponse.json({ error: 'Missing phones' }, { status: 400 });

  const { data: poll } = await supabase.from('polls').select('*').eq('id', pollId).single();
  if (!poll) return NextResponse.json({ error: 'Poll not found' }, { status: 404 });

  const { data: biz } = await supabase
    .from('businesses').select('id, owner_id, name')
    .eq('id', poll.business_id).eq('owner_id', user.id).single();
  if (!biz) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  const rateLimited = await rateLimitResponseAsync(`poll-send:${poll.business_id}`, 3, 60_000);
  if (rateLimited) return rateLimited;

  // Check conversation limit
  const { checkConversationLimit } = await import('@/lib/bot/conversation-guard');
  const service = createServiceClient();
  const convLimit = await checkConversationLimit(service, poll.business_id);
  if (!convLimit.allowed) {
    return NextResponse.json({ error: `Monthly conversation limit reached (${convLimit.used}/${convLimit.limit}).` }, { status: 403 });
  }

  if (poll.status !== 'active') {
    return NextResponse.json({ error: 'Poll must be active before sending' }, { status: 400 });
  }

  const resolver = new ChannelResolver(service);
  const resolved = await resolver.resolveByBusinessId(poll.business_id);
  if (!resolved) return NextResponse.json({ error: 'No WhatsApp channel configured' }, { status: 400 });

  const options = (poll.options as string[]) || [];
  let sent = 0;
  let failed = 0;

  for (const phone of phones) {
    try {
      // Create bot session for poll
      const { data: existingSession } = await service
        .from('bot_sessions')
        .select('id')
        .eq('whatsapp_number', phone)
        .eq('business_id', poll.business_id)
        .eq('is_active', true)
        .maybeSingle();

      const sessionData = {
        poll_id: pollId,
        poll_question: poll.question,
        poll_options: options,
        poll_allow_change: poll.allow_change_vote,
        poll_show_results: poll.show_results,
        active_capability: 'poll',
      };

      if (existingSession) {
        await service.from('bot_sessions')
          .update({ current_step: 'poll_question', session_data: sessionData })
          .eq('id', existingSession.id);
      } else {
        await service.from('bot_sessions').insert({
          whatsapp_number: phone,
          business_id: poll.business_id,
          current_step: 'poll_question',
          session_data: sessionData,
          is_active: true,
        });
      }

      // Send poll — use template to open 24h window, then interactive message
      const { sendWithTemplate } = await import('@/lib/channels/send-with-template');
      const pollBody = `📊 *${poll.question}*\n\nTap your choice:`;

      await sendWithTemplate({
        sender: resolved.sender,
        to: phone,
        templateName: 'feedback_request',
        templateParams: [biz.name, poll.question],
        followUpFn: async (s, p) => {
          if (options.length <= 3) {
            await s.sendButtons({
              to: p,
              body: pollBody,
              buttons: options.map((opt: string, i: number) => ({
                id: `poll_vote_${i}`,
                title: opt.slice(0, 20),
              })),
            });
          } else {
            await s.sendList({
              to: p,
              title: 'Poll',
              body: pollBody,
              buttonLabel: 'Vote',
              items: options.map((opt: string, i: number) => ({
                title: opt.slice(0, 24),
                postbackText: `poll_vote_${i}`,
              })),
            });
          }
        },
      });
      sent++;
    } catch (err) {
      logger.error(`[POLL-SEND] Failed for ${phone}:`, (err as Error).message);
      failed++;
    }
  }

  // Activate poll if draft
  if (poll.status === 'draft') {
    await supabase.from('polls').update({ status: 'active' }).eq('id', pollId);
  }

  return NextResponse.json({ sent, failed, total: phones.length });
}

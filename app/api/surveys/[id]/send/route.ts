import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { rateLimitResponse } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

type Params = { params: Promise<{ id: string }> };

// POST /api/surveys/[id]/send — distribute survey to contacts via WhatsApp
export async function POST(request: NextRequest, { params }: Params) {
  const { id: surveyId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { phones } = body as { phones: string[] };

  if (!phones?.length) {
    return NextResponse.json({ error: 'Missing phones array' }, { status: 400 });
  }

  // Load survey
  const { data: survey } = await supabase.from('surveys').select('*').eq('id', surveyId).single();
  if (!survey) return NextResponse.json({ error: 'Survey not found' }, { status: 404 });

  // Verify ownership
  const { data: biz } = await supabase
    .from('businesses')
    .select('id, owner_id, name, country_code')
    .eq('id', survey.business_id)
    .eq('owner_id', user.id)
    .single();
  if (!biz) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  // Rate limit
  const rateLimited = rateLimitResponse(`survey-send:${survey.business_id}`, 3, 60_000);
  if (rateLimited) return rateLimited;

  // Check conversation limit
  const { checkConversationLimit } = await import('@/lib/bot/conversation-guard');
  const service0 = createServiceClient();
  const convLimit = await checkConversationLimit(service0, survey.business_id);
  if (!convLimit.allowed) {
    return NextResponse.json({ error: `Monthly conversation limit reached (${convLimit.used}/${convLimit.limit}). Upgrade for more.` }, { status: 403 });
  }

  // Survey must be active
  if (survey.status !== 'active') {
    return NextResponse.json({ error: 'Survey must be active before sending' }, { status: 400 });
  }

  const service = createServiceClient();
  const resolver = new ChannelResolver(service);
  const resolved = await resolver.resolveByBusinessId(survey.business_id);

  if (!resolved) {
    return NextResponse.json({ error: 'No WhatsApp channel configured' }, { status: 400 });
  }

  let sent = 0;
  let failed = 0;

  for (const phone of phones) {
    try {
      // Create/update bot session for this customer with survey data
      const { data: existingSession } = await service
        .from('bot_sessions')
        .select('id')
        .eq('whatsapp_number', phone)
        .eq('business_id', survey.business_id)
        .eq('is_active', true)
        .maybeSingle();

      const sessionData = {
        survey_id: surveyId,
        survey_title: survey.title,
        survey_description: survey.description || '',
        survey_questions: survey.questions,
        active_capability: 'survey',
      };

      if (existingSession) {
        await service
          .from('bot_sessions')
          .update({ current_step: 'survey_intro', session_data: sessionData })
          .eq('id', existingSession.id);
      } else {
        await service.from('bot_sessions').insert({
          whatsapp_number: phone,
          business_id: survey.business_id,
          current_step: 'survey_intro',
          session_data: sessionData,
          is_active: true,
        });
      }

      // Send survey invitation message
      const questions = survey.questions as Array<{ id: string }>;
      const inviteText = `Hi! ${biz.name} would like your feedback.\n\n*${survey.title}*${survey.description ? '\n' + survey.description : ''}\n\n${questions.length} quick question${questions.length === 1 ? '' : 's'}. Ready?`;

      await resolved.sender.sendButtons({
        to: phone,
        body: inviteText,
        buttons: [
          { id: 'survey_start', title: 'Start' },
          { id: 'survey_skip', title: 'Not now' },
        ],
      });

      sent++;
    } catch (err) {
      logger.error(`[SURVEY-SEND] Failed to send to ${phone}:`, (err as Error).message);
      failed++;
    }
  }

  // Activate survey if it was draft (auto-activate on first send)
  if (survey.status === 'draft') {
    await supabase.from('surveys').update({ status: 'active' }).eq('id', surveyId);
  }

  return NextResponse.json({ sent, failed, total: phones.length });
}

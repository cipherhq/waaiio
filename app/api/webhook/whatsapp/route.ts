import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'crypto';
import * as Sentry from '@sentry/nextjs';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import type { MessageSender } from '@/lib/channels/message-sender';
import { BotService } from '@/lib/bot/bot.service';
import { BotIntelligenceService } from '@/lib/bot/bot-intelligence';
import { StandaloneService } from '@/lib/bot/standalone.service';
import { logger, generateRequestId } from '@/lib/logger';
import { transcribeAudio } from '@/lib/bot/transcription';

// Allow up to 60s for bot processing on Vercel Pro
export const maxDuration = 60;

// Singleton instances (persisted across warm invocations)
let intelligence: BotIntelligenceService;
let channelResolver: ChannelResolver;

function getIntelligence() {
  if (!intelligence) intelligence = new BotIntelligenceService();
  return intelligence;
}

function getChannelResolver() {
  if (!channelResolver) channelResolver = new ChannelResolver(createServiceClient());
  return channelResolver;
}

export async function POST(request: NextRequest) {
  const requestId = request.headers.get('x-request-id') || generateRequestId();
  const log = logger.withContext({ requestId });

  try {
    // Webhook secret verification (required in production)
    const webhookSecret = request.headers.get('x-webhook-secret');
    const expectedSecret = process.env.GUPSHUP_WEBHOOK_SECRET;
    if (expectedSecret) {
      if (!webhookSecret || webhookSecret.length !== expectedSecret.length
          || !timingSafeEqual(Buffer.from(webhookSecret), Buffer.from(expectedSecret))) {
        console.warn('[WEBHOOK] Invalid webhook secret');
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    } else if (process.env.NODE_ENV === 'production') {
      console.error('[WEBHOOK] GUPSHUP_WEBHOOK_SECRET not configured — rejecting request');
      return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
    }

    const rawBody = await request.text();
    log.debug('[WEBHOOK] Raw body:', rawBody.slice(0, 2000));

    let body: Record<string, unknown>;
    // Gupshup may send URL-encoded form data instead of JSON
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const params = new URLSearchParams(rawBody);
      const responseField = params.get('response');
      if (responseField) {
        body = JSON.parse(responseField);
      } else {
        // Convert form fields to object
        body = Object.fromEntries(params.entries());
      }
    } else {
      body = JSON.parse(rawBody);
    }

    log.debug('[WEBHOOK] Parsed type:', body.type, 'payload keys:', body.payload ? Object.keys(body.payload as object) : 'none');

    // Only process message events
    const eventType = (body.type || body.eventType || '') as string;
    if (eventType && eventType !== 'message' && eventType !== 'message-event') {
      log.debug('[WEBHOOK] Skipping event type:', eventType);
      return NextResponse.json({ status: 'ok', message: 'Non-message event' });
    }

    // Parse Gupshup payload — handle both nested and flat formats
    const payload = (body.payload || body) as Record<string, unknown>;
    const innerPayload = (payload.payload || {}) as Record<string, unknown>;

    const source = (payload.source || (payload.sender as Record<string, unknown>)?.phone || body.source || '') as string;
    const destination = (payload.destination || body.destination || '') as string;

    // Text extraction: Gupshup nests text inside payload.payload for all message types
    // - Text messages: payload.payload.text
    // - Button replies: payload.payload.postbackText or payload.payload.title
    // - List replies: payload.payload.id or payload.payload.postbackText or payload.payload.title
    //   (Gupshup list replies use "id" for the postback value, not "postbackText")
    let text = '';
    if (typeof innerPayload === 'object' && innerPayload) {
      text = (innerPayload.text || innerPayload.postbackText || innerPayload.id || innerPayload.title || '') as string;
    }
    if (!text) {
      text = (payload.text || '') as string;
    }

    // Audio extraction: Gupshup nests type on payload (not innerPayload), URL inside innerPayload
    // payload = { source, type: "audio", payload: { url, contentType } }
    // The Gupshup URL expires, so download and re-upload to Supabase Storage
    let mediaUrl: string | undefined;
    const payloadType = (payload.type as string) || '';
    if (payloadType === 'audio' && typeof innerPayload === 'object' && innerPayload && innerPayload.url) {
      try {
        const gupshupAudioUrl = innerPayload.url as string;
        const audioRes = await fetch(gupshupAudioUrl);
        if (audioRes.ok) {
          const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
          const contentType = (innerPayload.contentType as string) || 'audio/ogg';
          const ext = contentType.includes('ogg') ? 'ogg' : 'webm';
          const storagePath = `chat-audio/${destination || 'shared'}/${Date.now()}.${ext}`;

          const storageClient = createServiceClient();
          await storageClient.storage
            .from('business-documents')
            .upload(storagePath, audioBuffer, { contentType, upsert: false });

          const { data: urlData } = storageClient.storage
            .from('business-documents')
            .getPublicUrl(storagePath);
          mediaUrl = urlData.publicUrl;

          // Transcribe audio with Whisper
          try {
            const transcript = await transcribeAudio(audioBuffer, contentType, `gupshup-${source}-${Date.now()}`);
            if (transcript) {
              text = transcript;
              log.debug('[GUPSHUP-WEBHOOK] Voice transcribed:', transcript.slice(0, 80));
            }
          } catch (transcribeErr) {
            log.error('[GUPSHUP-WEBHOOK] Transcription error:', transcribeErr);
          }
        }
      } catch (err) {
        log.error('[WEBHOOK] Gupshup audio download/upload error:', err);
        // Fallback: use the expiring Gupshup URL directly
        mediaUrl = innerPayload.url as string;
      }
      if (!text) text = '[Voice message]';
    }

    const msgType = (innerPayload?.type || payload.type || 'text') as string;

    // Enrich logger with sender phone once known
    const logMsg = source ? log.withContext({ from: source }) : log;
    logMsg.debug('[WEBHOOK] source:', source, 'dest:', destination, 'text:', text, 'msgType:', msgType);

    if (!source) {
      log.debug('[WEBHOOK] No source phone, skipping');
      return NextResponse.json({ status: 'ok', message: 'No source phone' });
    }

    // Replay protection: check for duplicate message
    // Use crypto hash as fallback ID when Gupshup doesn't provide messageId (survives retries)
    const rawMsgId = (body.messageId || (body.response as Record<string, unknown>)?.id) as string | undefined;
    const messageId = rawMsgId || `${source}-${text?.slice(0, 50)}-${body.timestamp || ''}`;
    const supabaseForDedup = createServiceClient();

    // Use INSERT ON CONFLICT for atomic dedup (no race condition)
    const { data: inserted } = await supabaseForDedup
      .from('processed_webhook_events')
      .upsert(
        { event_id: `gupshup-${messageId}`, gateway: 'gupshup', event_type: 'whatsapp_message', processed_at: new Date().toISOString() },
        { onConflict: 'event_id', ignoreDuplicates: true },
      )
      .select('id');

    if (!inserted || inserted.length === 0) {
      logMsg.debug('[WEBHOOK] Duplicate message, skipping:', messageId);
      return NextResponse.json({ success: true, duplicate: true });
    }

    // Create service instances
    const supabase = createServiceClient();
    const intelligenceSvc = getIntelligence();
    const resolver = getChannelResolver();

    // Resolve channel from destination phone — returns the correct MessageSender (Gupshup or MetaCloud)
    const resolved = destination ? await resolver.resolveByPhone(destination) : null;
    if (!resolved?.sender) {
      log.warn('[WEBHOOK] No messaging channel found for destination phone:', destination);
      return NextResponse.json({ status: 'ok', message: 'No channel configured' });
    }
    const sender = resolved.sender;
    const preResolvedBusinessId = resolved?.channel.channel_type === 'dedicated'
      ? resolved.channel.business_id || undefined
      : undefined;

    const standalone = new StandaloneService(supabase);
    const bot = new BotService(supabase, sender as MessageSender, standalone, intelligenceSvc);

    // Process message
    await bot.handleMessage(source, text, msgType, destination || undefined, preResolvedBusinessId, mediaUrl);

    logMsg.debug('[WEBHOOK] Message processed successfully');
    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    log.error('[WEBHOOK] Error:', error);
    Sentry.captureException(error);
    return NextResponse.json({ status: 'ok' }, { status: 200 });
  }
}

// Gupshup sends GET for webhook verification
export async function GET() {
  return NextResponse.json({ status: 'ok' });
}

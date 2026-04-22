import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createServiceClient } from '@/lib/supabase/service';
import { GupshupService } from '@/lib/channels/gupshup';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import type { MessageSender } from '@/lib/channels/message-sender';
import { BotService } from '@/lib/bot/bot.service';
import { BotIntelligenceService } from '@/lib/bot/bot-intelligence';
import { StandaloneService } from '@/lib/bot/standalone.service';
import { logger } from '@/lib/logger';

// Singleton instances (persisted across warm invocations)
let defaultGupshup: GupshupService;
let intelligence: BotIntelligenceService;
let channelResolver: ChannelResolver;

function getDefaultGupshup() {
  if (!defaultGupshup) defaultGupshup = new GupshupService();
  return defaultGupshup;
}

function getIntelligence() {
  if (!intelligence) intelligence = new BotIntelligenceService();
  return intelligence;
}

function getChannelResolver() {
  if (!channelResolver) channelResolver = new ChannelResolver(createServiceClient());
  return channelResolver;
}

export async function POST(request: NextRequest) {
  try {
    // Webhook secret verification (verify when configured, warn when not)
    const webhookSecret = request.headers.get('x-webhook-secret');
    const expectedSecret = process.env.GUPSHUP_WEBHOOK_SECRET;
    if (expectedSecret && webhookSecret !== expectedSecret) {
      console.warn('[WEBHOOK] Invalid webhook secret');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rawBody = await request.text();
    logger.debug('[WEBHOOK] Raw body:', rawBody.slice(0, 2000));

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

    logger.debug('[WEBHOOK] Parsed type:', body.type, 'payload keys:', body.payload ? Object.keys(body.payload as object) : 'none');

    // Only process message events
    const eventType = (body.type || body.eventType || '') as string;
    if (eventType && eventType !== 'message' && eventType !== 'message-event') {
      logger.debug('[WEBHOOK] Skipping event type:', eventType);
      return NextResponse.json({ status: 'ok', message: 'Non-message event' });
    }

    // Parse Gupshup payload — handle both nested and flat formats
    const payload = (body.payload || body) as Record<string, unknown>;
    const innerPayload = (payload.payload || {}) as Record<string, unknown>;

    const source = (payload.source || (payload.sender as Record<string, unknown>)?.phone || body.source || '') as string;
    const destination = (payload.destination || body.destination || '') as string;

    // Text extraction: Gupshup nests text inside payload.payload.text for text messages
    // For button replies: payload.payload.postbackText or payload.payload.title
    let text = '';
    if (typeof innerPayload === 'object' && innerPayload) {
      text = (innerPayload.text || innerPayload.postbackText || innerPayload.title || '') as string;
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
      if (!text) text = '[Voice message]';
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
        }
      } catch (err) {
        logger.error('[WEBHOOK] Gupshup audio download/upload error:', err);
        // Fallback: use the expiring Gupshup URL directly
        mediaUrl = innerPayload.url as string;
      }
    }

    const msgType = (innerPayload?.type || payload.type || 'text') as string;

    logger.debug('[WEBHOOK] source:', source, 'dest:', destination, 'text:', text, 'msgType:', msgType);

    if (!source) {
      logger.debug('[WEBHOOK] No source phone, skipping');
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
      logger.debug('[WEBHOOK] Duplicate message, skipping:', messageId);
      return NextResponse.json({ success: true, duplicate: true });
    }

    // Create service instances
    const supabase = createServiceClient();
    const intelligenceSvc = getIntelligence();
    const resolver = getChannelResolver();

    // Resolve channel from destination phone — returns the correct MessageSender (Gupshup or MetaCloud)
    const resolved = destination ? await resolver.resolveByPhone(destination) : null;
    const sender = resolved?.sender || getDefaultGupshup();
    const preResolvedBusinessId = resolved?.channel.channel_type === 'dedicated'
      ? resolved.channel.business_id || undefined
      : undefined;

    const standalone = new StandaloneService(supabase);
    const bot = new BotService(supabase, sender as MessageSender, standalone, intelligenceSvc);

    // Process message
    await bot.handleMessage(source, text, msgType, destination || undefined, preResolvedBusinessId, mediaUrl);

    logger.debug('[WEBHOOK] Message processed successfully');
    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    logger.error('[WEBHOOK] Error:', error);
    Sentry.captureException(error);
    return NextResponse.json({ status: 'ok' }, { status: 200 });
  }
}

// Gupshup sends GET for webhook verification
export async function GET() {
  return NextResponse.json({ status: 'ok' });
}

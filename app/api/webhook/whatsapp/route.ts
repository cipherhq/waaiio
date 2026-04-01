import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { GupshupService } from '@/lib/channels/gupshup';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { BotService } from '@/lib/bot/bot.service';
import { BotIntelligenceService } from '@/lib/bot/bot-intelligence';
import { StandaloneService } from '@/lib/bot/standalone.service';

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
    const rawBody = await request.text();
    console.log('[WEBHOOK] Raw body:', rawBody.slice(0, 2000));

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

    console.log('[WEBHOOK] Parsed type:', body.type, 'payload keys:', body.payload ? Object.keys(body.payload as object) : 'none');

    // Only process message events
    const eventType = (body.type || body.eventType || '') as string;
    if (eventType && eventType !== 'message' && eventType !== 'message-event') {
      console.log('[WEBHOOK] Skipping event type:', eventType);
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

    const msgType = (innerPayload?.type || payload.type || 'text') as string;

    console.log('[WEBHOOK] source:', source, 'dest:', destination, 'text:', text, 'msgType:', msgType);

    if (!source) {
      console.log('[WEBHOOK] No source phone, skipping');
      return NextResponse.json({ status: 'ok', message: 'No source phone' });
    }

    // Create service instances
    const supabase = createServiceClient();
    const intelligenceSvc = getIntelligence();
    const resolver = getChannelResolver();

    // Resolve channel from destination phone
    const resolved = destination ? await resolver.resolveByPhone(destination) : null;
    const gupshupSvc = resolved?.gupshup || getDefaultGupshup();
    const preResolvedBusinessId = resolved?.channel.channel_type === 'dedicated'
      ? resolved.channel.business_id || undefined
      : undefined;

    const standalone = new StandaloneService(supabase);
    const bot = new BotService(supabase, gupshupSvc, standalone, intelligenceSvc);

    // Process message
    await bot.handleMessage(source, text, msgType, destination || undefined, preResolvedBusinessId);

    console.log('[WEBHOOK] Message processed successfully');
    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    console.error('[WEBHOOK] Error:', error);
    return NextResponse.json({ status: 'ok' }, { status: 200 });
  }
}

// Gupshup sends GET for webhook verification
export async function GET() {
  return NextResponse.json({ status: 'ok' });
}

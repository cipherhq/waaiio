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
    const body = await request.json();

    // Parse Gupshup payload
    const payload = body.payload || body;
    const source = payload.source || payload.sender?.phone || '';
    const text = payload.payload?.text || payload.text || payload.payload?.payload?.text || '';
    const msgType = payload.type || payload.payload?.type || 'text';
    const destination = payload.destination || '';

    if (!source) {
      return NextResponse.json({ status: 'ok', message: 'No source phone' });
    }

    // Only process message events
    const eventType = body.type || body.eventType || '';
    if (eventType && eventType !== 'message' && eventType !== 'message-event') {
      return NextResponse.json({ status: 'ok', message: 'Non-message event' });
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

    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    console.error('Webhook error:', error);
    return NextResponse.json({ status: 'ok' }, { status: 200 });
  }
}

// Gupshup sends GET for webhook verification
export async function GET() {
  return NextResponse.json({ status: 'ok' });
}

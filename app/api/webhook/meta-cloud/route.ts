import { NextResponse, type NextRequest } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { BotService } from '@/lib/bot/bot.service';
import { BotIntelligenceService } from '@/lib/bot/bot-intelligence';
import { StandaloneService } from '@/lib/bot/standalone.service';
import { logger } from '@/lib/logger';

/**
 * POST /api/webhook/meta-cloud
 *
 * Receives incoming messages from Meta's WhatsApp Cloud API
 * for businesses using dedicated (transfer/coexist) numbers.
 *
 * Payload format: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
 */

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
  try {
    // Read raw body for signature verification
    const rawBody = await request.text();

    // X-Hub-Signature-256 verification (fail-closed)
    const signature = request.headers.get('x-hub-signature-256');
    const appSecret = process.env.META_APP_SECRET;

    if (!appSecret) {
      console.warn('[META-WEBHOOK] META_APP_SECRET not configured');
      return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 });
    }

    if (!signature) {
      return NextResponse.json({ error: 'Missing signature' }, { status: 401 });
    }

    const expectedSignature = 'sha256=' + createHmac('sha256', appSecret)
      .update(rawBody)
      .digest('hex');

    try {
      if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
        console.warn('[META-WEBHOOK] Invalid signature');
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
      }
    } catch {
      console.warn('[META-WEBHOOK] Signature comparison failed');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    const body = JSON.parse(rawBody);

    // Meta sends a wrapper with "object" and "entry" array
    if (body.object !== 'whatsapp_business_account') {
      return NextResponse.json({ status: 'ok' });
    }

    const entries = body.entry as Array<{
      id: string;
      changes: Array<{
        value: {
          messaging_product: string;
          metadata: { display_phone_number: string; phone_number_id: string };
          contacts?: Array<{ profile: { name: string }; wa_id: string }>;
          messages?: Array<{
            from: string;
            id: string;
            timestamp: string;
            type: string;
            text?: { body: string };
            interactive?: {
              type: string;
              button_reply?: { id: string; title: string };
              list_reply?: { id: string; title: string; description?: string };
            };
            image?: { id: string; caption?: string };
          }>;
          statuses?: Array<{ id: string; status: string; timestamp: string }>;
        };
        field: string;
      }>;
    }>;

    for (const entry of entries) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') continue;

        const value = change.value;
        const phoneNumberId = value.metadata?.phone_number_id;
        const messages = value.messages || [];
        const statuses = value.statuses || [];

        // Process delivery/read status updates for contract tracking
        if (statuses.length > 0) {
          const supabase = createServiceClient();
          const statusOrder: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

          for (const status of statuses) {
            const wamid = status.id;
            const newStatus = status.status; // 'sent' | 'delivered' | 'read' | 'failed'
            if (!wamid || !statusOrder[newStatus]) continue;

            // Check contracts table
            const { data: contract } = await supabase
              .from('contracts')
              .select('id, wa_delivery_status')
              .eq('wa_message_id', wamid)
              .maybeSingle();

            if (contract) {
              // Atomic progressive update: only advance status forward using WHERE clause
              const lowerStatuses = Object.entries(statusOrder)
                .filter(([, order]) => order < statusOrder[newStatus])
                .map(([s]) => s);
              if (lowerStatuses.length > 0) {
                await supabase
                  .from('contracts')
                  .update({ wa_delivery_status: newStatus, wa_status_updated_at: new Date().toISOString() })
                  .eq('id', contract.id)
                  .in('wa_delivery_status', [...lowerStatuses, null as unknown as string]);
              }
            }

            // Check contract_signers table
            const { data: signer } = await supabase
              .from('contract_signers')
              .select('id, wa_delivery_status')
              .eq('wa_message_id', wamid)
              .maybeSingle();

            if (signer) {
              const lowerStatuses = Object.entries(statusOrder)
                .filter(([, order]) => order < statusOrder[newStatus])
                .map(([s]) => s);
              if (lowerStatuses.length > 0) {
                await supabase
                  .from('contract_signers')
                  .update({ wa_delivery_status: newStatus, wa_status_updated_at: new Date().toISOString() })
                  .eq('id', signer.id)
                  .in('wa_delivery_status', [...lowerStatuses, null as unknown as string]);
              }
            }
          }
        }

        if (messages.length === 0) continue;

        const supabase = createServiceClient();
        const intelligenceSvc = getIntelligence();
        const resolver = getChannelResolver();

        // Resolve channel by phone_number_id
        const resolved = await resolver.resolveByPhoneNumberId(phoneNumberId);
        if (!resolved) {
          logger.debug('[META-WEBHOOK] No channel found for phone_number_id:', phoneNumberId);
          continue;
        }

        const preResolvedBusinessId = resolved.channel.business_id || undefined;

        for (const msg of messages) {
          const source = msg.from;

          // Extract text based on message type
          let text = '';
          let msgType = msg.type || 'text';

          if (msg.type === 'text') {
            text = msg.text?.body || '';
          } else if (msg.type === 'interactive') {
            if (msg.interactive?.type === 'button_reply') {
              text = msg.interactive.button_reply?.id || msg.interactive.button_reply?.title || '';
              msgType = 'button';
            } else if (msg.interactive?.type === 'list_reply') {
              text = msg.interactive.list_reply?.id || msg.interactive.list_reply?.title || '';
              msgType = 'list';
            }
          }

          if (!source || !text) continue;

          // Replay protection: atomic dedup via ON CONFLICT
          const metaMsgId = msg.id || `${source}-${msg.timestamp}`;
          const { data: dedupInserted } = await supabase
            .from('processed_webhook_events')
            .upsert(
              { event_id: `meta-${metaMsgId}`, event_type: 'meta_cloud_message', processed_at: new Date().toISOString() },
              { onConflict: 'event_id', ignoreDuplicates: true },
            )
            .select('id');

          if (!dedupInserted || dedupInserted.length === 0) {
            logger.debug('[META-WEBHOOK] Duplicate message, skipping:', metaMsgId);
            continue;
          }

          logger.debug('[META-WEBHOOK] source:', source, 'text:', text, 'type:', msgType, 'pnid:', phoneNumberId);

          const standalone = new StandaloneService(supabase);
          const bot = new BotService(supabase, resolved.sender, standalone, intelligenceSvc);

          await bot.handleMessage(source, text, msgType, phoneNumberId, preResolvedBusinessId);

          // Already marked as processed via upsert above
        }
      }
    }

    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    logger.error('[META-WEBHOOK] Error:', error);
    return NextResponse.json({ status: 'ok' }, { status: 200 });
  }
}

/**
 * GET /api/webhook/meta-cloud
 *
 * Meta sends a GET request to verify the webhook URL.
 * Must return the hub.challenge value if the verify token matches.
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (!verifyToken) {
    logger.error('[META-WEBHOOK] META_WEBHOOK_VERIFY_TOKEN not configured');
    return new NextResponse('Configuration error', { status: 500 });
  }

  if (mode === 'subscribe' && token === verifyToken) {
    logger.debug('[META-WEBHOOK] Verification successful');
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}

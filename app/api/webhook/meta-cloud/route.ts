import { NextResponse, type NextRequest } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { BotService } from '@/lib/bot/bot.service';
import { BotIntelligenceService } from '@/lib/bot/bot-intelligence';
import { StandaloneService } from '@/lib/bot/standalone.service';
import { logger, generateRequestId } from '@/lib/logger';
import { transcribeAudio } from '@/lib/bot/transcription';
import { checkAIFeature, incrementAIUsage, getVoiceNotSupportedMessage } from '@/lib/bot/ai-tier-guard';
import { createWhatsAppUser } from '@/lib/bot/flows/shared/user';
import { getPaymentGateway, getPaymentGatewayByName } from '@/lib/payments/factory';
import { getCurrencyForCountry } from '@/lib/channels/catalog';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ResolvedChannel } from '@/lib/channels/channel-resolver';
import type { CountryCode, PaymentGatewayName } from '@/lib/constants';

/**
 * POST /api/webhook/meta-cloud
 *
 * Receives incoming messages from Meta's WhatsApp Cloud API
 * for businesses using dedicated (transfer/coexist) numbers.
 *
 * Payload format: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
 */

// Allow up to 60s for bot processing on Vercel Pro
export const maxDuration = 60;

/**
 * Handle a WhatsApp Catalog order message.
 * When a customer browses the native WhatsApp product catalog and submits an order,
 * Meta sends a message with type === 'order'. We create an order record, init payment,
 * and send the customer a summary with a payment link.
 */
async function handleCatalogOrder(
  supabase: SupabaseClient,
  resolved: ResolvedChannel,
  msg: { order?: { catalog_id: string; text?: string; product_items: Array<{ product_retailer_id: string; quantity: number; item_price: number; currency: string }> }; id?: string },
  source: string,
  msgLog: ReturnType<typeof logger.withContext>,
) {
  const orderData = msg.order;
  if (!orderData?.product_items?.length) return;

  const catalogId = orderData.catalog_id;
  const customerNote = orderData.text || '';
  const items = orderData.product_items;

  // Find the business by catalog_id
  const { data: biz } = await supabase
    .from('businesses')
    .select('id, name, country_code, payment_gateway, status')
    .eq('whatsapp_catalog_id', catalogId)
    .single();

  if (!biz || biz.status !== 'active') {
    msgLog.error('[META-WEBHOOK] No active business found for catalog:', catalogId);
    try {
      await resolved.sender.sendText({
        to: source,
        text: 'Sorry, this catalog is currently unavailable. Please try again later.',
      });
    } catch { /* ignore */ }
    return;
  }

  // Look up products by retailer_id (which is our product.id)
  const productIds = items.map(i => i.product_retailer_id);
  const { data: products } = await supabase
    .from('products')
    .select('id, name, price, stock_quantity, track_inventory, is_active')
    .in('id', productIds)
    .eq('is_active', true);

  const productMap = new Map((products || []).map(p => [p.id, p]));

  // Calculate total and build order items
  let total = 0;
  const orderItems: Array<{ product_id: string; name: string; quantity: number; unit_price: number }> = [];
  const outOfStock: string[] = [];

  for (const item of items) {
    const product = productMap.get(item.product_retailer_id);
    if (!product) continue;

    // Check stock
    if (product.track_inventory && product.stock_quantity !== null && product.stock_quantity < item.quantity) {
      outOfStock.push(product.name);
      continue;
    }

    // item_price from Meta is in the smallest currency unit (cents/kobo)
    // Our DB stores amounts in smallest unit (integer)
    const unitPrice = item.item_price || (product.price);
    const itemTotal = unitPrice * item.quantity;
    total += itemTotal;
    orderItems.push({
      product_id: product.id,
      name: product.name,
      quantity: item.quantity,
      unit_price: unitPrice,
    });
  }

  if (orderItems.length === 0) {
    const msg = outOfStock.length > 0
      ? `Sorry, the following items are out of stock: ${outOfStock.join(', ')}`
      : 'Sorry, none of the selected products are available right now.';
    try {
      await resolved.sender.sendText({ to: source, text: msg });
    } catch { /* ignore */ }
    return;
  }

  // Create or find user profile for the WhatsApp customer
  const phone = source.startsWith('+') ? source : `+${source}`;
  const userId = await createWhatsAppUser(supabase, source, '', '');
  if (!userId) {
    msgLog.error('[META-WEBHOOK] Failed to create/find user for catalog order');
    try {
      await resolved.sender.sendText({
        to: source,
        text: 'Something went wrong on our end. Please try again.',
      });
    } catch { /* ignore */ }
    return;
  }

  // Create order (reference_code is auto-generated by trigger)
  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .insert({
      business_id: biz.id,
      user_id: userId,
      status: total > 0 ? 'pending' : 'confirmed',
      delivery_phone: phone,
      total_amount: total,
      channel: 'whatsapp',
      notes: customerNote || null,
    })
    .select('id, reference_code')
    .single();

  if (orderErr || !order) {
    msgLog.error('[META-WEBHOOK] Failed to create catalog order:', orderErr?.message);
    try {
      await resolved.sender.sendText({
        to: source,
        text: 'Something went wrong on our end creating your order. Please try again.',
      });
    } catch { /* ignore */ }
    return;
  }

  // Insert order items
  await supabase.from('order_items').insert(
    orderItems.map(oi => ({
      order_id: order.id,
      product_id: oi.product_id,
      quantity: oi.quantity,
      unit_price: oi.unit_price,
    }))
  );

  // Decrement stock for tracked products
  for (const oi of orderItems) {
    const product = productMap.get(oi.product_id);
    if (product?.track_inventory) {
      await supabase.rpc('decrement_stock', {
        p_product_id: oi.product_id,
        qty: oi.quantity,
      });
    }
  }

  const currency = getCurrencyForCountry(biz.country_code || 'NG');

  // Build order summary message
  const itemLines = orderItems.map(oi => `  ${oi.name} x${oi.quantity} - ${currency} ${oi.unit_price * oi.quantity}`).join('\n');

  let paymentLine = '';

  // Initialize payment if total > 0
  if (total > 0) {
    try {
      const gatewayName = (biz.payment_gateway || undefined) as PaymentGatewayName | undefined;
      const gateway = gatewayName
        ? getPaymentGatewayByName(gatewayName)
        : getPaymentGateway((biz.country_code || 'NG') as CountryCode);

      const paymentResult = await gateway.initializePayment({
        supabase,
        orderId: order.id,
        userId,
        amount: total,
        currency,
        referenceCode: order.reference_code,
        businessName: biz.name,
        phone,
        callbackUrl: `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'}/payment-success`,
        businessId: biz.id,
      });

      if (paymentResult?.url) {
        // Create payment record
        await supabase.from('payments').insert({
          business_id: biz.id,
          order_id: order.id,
          user_id: userId,
          amount: total,
          currency,
          gateway: gateway.name,
          gateway_reference: order.reference_code,
          status: 'pending',
        });

        paymentLine = `\nPay here:\n${paymentResult.url}`;
      }
    } catch (payErr) {
      msgLog.error('[META-WEBHOOK] Payment init failed for catalog order:', payErr);
      paymentLine = '\nPlease contact the business to arrange payment.';
    }
  }

  // Send order confirmation via WhatsApp
  const outOfStockNote = outOfStock.length > 0
    ? `\n\n_Note: ${outOfStock.join(', ')} ${outOfStock.length === 1 ? 'was' : 'were'} out of stock and removed from your order._`
    : '';

  const confirmationMsg = [
    `*Order Received!*`,
    '',
    `*${biz.name}*`,
    '',
    itemLines,
    '',
    `*Total: ${currency} ${total}*`,
    `Ref: *${order.reference_code}*`,
    customerNote ? `Note: ${customerNote}` : '',
    paymentLine,
    outOfStockNote,
    '',
    total > 0 ? 'Your confirmation will arrive automatically after payment.' : 'Your order has been confirmed!',
  ].filter(Boolean).join('\n');

  try {
    await resolved.sender.sendText({ to: source, text: confirmationMsg });
  } catch (sendErr) {
    msgLog.error('[META-WEBHOOK] Failed to send catalog order confirmation:', sendErr);
  }

  msgLog.debug('[META-WEBHOOK] Catalog order created:', order.reference_code, 'total:', total);
}

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
    // Read raw body for signature verification
    const rawBody = await request.text();

    // X-Hub-Signature-256 verification (mandatory in production)
    const signature = request.headers.get('x-hub-signature-256');
    const appSecret = process.env.META_APP_SECRET;

    if (!appSecret) {
      log.error('[META-WEBHOOK] META_APP_SECRET not configured — rejecting webhook');
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    if (!signature) {
      log.error('[META-WEBHOOK] Missing x-hub-signature-256 header — rejecting webhook');
      return NextResponse.json({ error: 'Missing signature' }, { status: 401 });
    }

    if (appSecret && signature) {
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
            audio?: { id: string; mime_type?: string };
            image?: { id: string; caption?: string };
            order?: {
              catalog_id: string;
              text?: string;
              product_items: Array<{
                product_retailer_id: string;
                quantity: number;
                item_price: number;
                currency: string;
              }>;
            };
            context?: {
              referred_product?: {
                catalog_id: string;
                product_retailer_id: string;
              };
            };
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
          const statusOrder: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 0 };

          for (const status of statuses) {
            const wamid = status.id;
            const newStatus = status.status; // 'sent' | 'delivered' | 'read' | 'failed'
            if (!wamid || !(newStatus in statusOrder)) continue;

            // Check contracts and contract_signers in parallel
            const [{ data: contract }, { data: signer }] = await Promise.all([
              supabase.from('contracts').select('id, wa_delivery_status').eq('wa_message_id', wamid).maybeSingle(),
              supabase.from('contract_signers').select('id, wa_delivery_status').eq('wa_message_id', wamid).maybeSingle(),
            ]);

            // 'failed' always overwrites any status — it signals a delivery failure regardless of order.
            // For normal progression (sent → delivered → read) only advance forward.
            const isFailed = newStatus === 'failed';
            const lowerStatuses = isFailed
              ? Object.keys(statusOrder).filter(s => s !== 'failed')
              : Object.entries(statusOrder)
                  .filter(([, order]) => order < statusOrder[newStatus])
                  .map(([s]) => s);

            const updates: PromiseLike<unknown>[] = [];
            if (contract && (isFailed || lowerStatuses.length > 0)) {
              updates.push(
                supabase.from('contracts')
                  .update({ wa_delivery_status: newStatus, wa_status_updated_at: new Date().toISOString() })
                  .eq('id', contract.id)
                  .in('wa_delivery_status', isFailed ? [...lowerStatuses, null as unknown as string] : [...lowerStatuses, null as unknown as string])
              );
            }
            if (signer && (isFailed || lowerStatuses.length > 0)) {
              updates.push(
                supabase.from('contract_signers')
                  .update({ wa_delivery_status: newStatus, wa_status_updated_at: new Date().toISOString() })
                  .eq('id', signer.id)
                  .in('wa_delivery_status', isFailed ? [...lowerStatuses, null as unknown as string] : [...lowerStatuses, null as unknown as string])
              );
            }
            if (updates.length > 0) await Promise.all(updates);
          }
        }

        if (messages.length === 0) continue;

        const supabase = createServiceClient(); // single instance for all messages in this change
        const intelligenceSvc = getIntelligence();
        // Fresh resolver each request to avoid stale cached credentials
        const resolver = new ChannelResolver(supabase);

        // Resolve channel by phone_number_id
        const resolved = await resolver.resolveByPhoneNumberId(phoneNumberId);
        log.debug('[META-WEBHOOK] Resolved channel:', resolved ? { channelId: resolved.channel.id, provider: resolved.channel.provider, phoneNumberId: resolved.channel.phone_number_id, hasToken: !!(resolved.channel.meta_access_token || process.env.META_CLOUD_ACCESS_TOKEN) } : 'NULL');
        if (!resolved) {
          log.debug('[META-WEBHOOK] No channel found for phone_number_id:', phoneNumberId);
          continue;
        }

        const preResolvedBusinessId = resolved.channel.business_id || undefined;

        for (const msg of messages) {
          const source = msg.from;
          const msgLog = log.withContext({ from: source });

          // ── Handle WhatsApp Catalog order messages ──
          // When a customer adds items from the native WhatsApp catalog and submits,
          // Meta sends a message with type === 'order'. This is a parallel path to
          // the conversational ordering flow — both work independently.
          if (msg.type === 'order' && msg.order?.product_items?.length) {
            try {
              await handleCatalogOrder(supabase, resolved, msg, source, msgLog);
            } catch (orderErr) {
              msgLog.error('[META-WEBHOOK] Catalog order handling failed:', orderErr);
            }
            continue; // Skip normal bot processing for order messages
          }

          // Extract text based on message type
          let text = '';
          let msgType = msg.type || 'text';

          // Product inquiry: when customer taps "Message Business" on a catalog product,
          // Meta may include context.referred_product — convert to a text inquiry
          if (msg.context?.referred_product) {
            const refProduct = msg.context.referred_product;
            // Look up the product name for a nicer inquiry message
            const { data: inquiryProduct } = await supabase
              .from('products')
              .select('name')
              .eq('id', refProduct.product_retailer_id)
              .maybeSingle();
            text = inquiryProduct?.name
              ? `I'm interested in ${inquiryProduct.name}`
              : `I'm interested in product ${refProduct.product_retailer_id}`;
          }

          if (msg.type === 'text') {
            text = msg.text?.body || text; // Keep referred_product text if no body
          } else if (msg.type === 'interactive') {
            if (msg.interactive?.type === 'button_reply') {
              text = msg.interactive.button_reply?.id || msg.interactive.button_reply?.title || '';
              msgType = 'button';
            } else if (msg.interactive?.type === 'list_reply') {
              text = msg.interactive.list_reply?.id || msg.interactive.list_reply?.title || '';
              msgType = 'list';
            }
          }

          // Handle audio messages: download from Meta, upload to Supabase Storage
          let mediaUrl: string | undefined;
          if (msg.type === 'audio' && msg.audio?.id) {
            try {
              const metaToken = resolved.channel.meta_access_token || process.env.META_CLOUD_ACCESS_TOKEN || '';
              // Get media URL from Meta
              const mediaRes = await fetch(`https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION || 'v22.0'}/${msg.audio.id}`, {
                headers: { Authorization: `Bearer ${metaToken}` },
              });
              const mediaData = await mediaRes.json();
              if (mediaData.url) {
                // Download the audio binary
                const audioRes = await fetch(mediaData.url, {
                  headers: { Authorization: `Bearer ${metaToken}` },
                });
                const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
                const ext = (msg.audio.mime_type || 'audio/ogg').includes('ogg') ? 'ogg' : 'webm';
                const storagePath = `chat-audio/${preResolvedBusinessId || 'unknown'}/${Date.now()}.${ext}`;

                await supabase.storage
                  .from('business-documents')
                  .upload(storagePath, audioBuffer, {
                    contentType: msg.audio.mime_type || 'audio/ogg',
                    upsert: false,
                  });

                const { data: urlData } = supabase.storage
                  .from('business-documents')
                  .getPublicUrl(storagePath);
                mediaUrl = urlData.publicUrl;

                // Transcribe audio with Whisper (tier-gated)
                if (preResolvedBusinessId) {
                  const { data: bizTier } = await supabase.from('businesses').select('subscription_tier').eq('id', preResolvedBusinessId).single();
                  const tier = bizTier?.subscription_tier || 'free';
                  const { allowed } = await checkAIFeature(supabase, preResolvedBusinessId, tier, 'voice_transcription');

                  if (allowed) {
                    try {
                      const transcript = await transcribeAudio(
                        audioBuffer,
                        msg.audio.mime_type || 'audio/ogg',
                        `meta-${msg.id || source}`,
                      );
                      if (transcript) {
                        text = transcript;
                        await incrementAIUsage(supabase, preResolvedBusinessId, 'voice_transcription');
                        msgLog.debug('[META-WEBHOOK] Voice transcribed:', transcript.slice(0, 80));
                      }
                    } catch (transcribeErr) {
                      msgLog.error('[META-WEBHOOK] Transcription error:', transcribeErr);
                    }
                  } else {
                    // Free tier: tell customer to type instead
                    try {
                      await resolved.sender.sendText({ to: source, text: getVoiceNotSupportedMessage() });
                    } catch { /* ignore */ }
                  }
                }
              }
            } catch (err) {
              msgLog.error('[META-WEBHOOK] Audio download/upload error:', err);
            }
            if (!text) text = '[Voice message]';
          }

          // If the message is an unsupported media type (image/video/sticker/document/location)
          // with no text, reply with guidance instead of silently skipping
          const msgAny = msg as Record<string, unknown>;
          if (!text && !mediaUrl && source && (msg.image || msgAny.video || msgAny.sticker || msgAny.document || msgAny.location)) {
            try {
              await resolved.sender.sendText({
                to: source,
                text: "I can't process images or files yet. Please reply with text instead.\n\nType *Hi* to start over, *menu* to see options, or *cancel* to exit.",
              });
            } catch { /* ignore send failure */ }
            continue;
          }

          if (!source || (!text && !mediaUrl)) continue;

          // Replay protection: atomic dedup via ON CONFLICT
          const metaMsgId = msg.id || `${source}-${msg.timestamp}`;
          const { data: dedupInserted } = await supabase
            .from('processed_webhook_events')
            .upsert(
              { event_id: `meta-${metaMsgId}`, gateway: 'meta_cloud', event_type: 'meta_cloud_message', processed_at: new Date().toISOString() },
              { onConflict: 'event_id', ignoreDuplicates: true },
            )
            .select('id');

          if (!dedupInserted || dedupInserted.length === 0) {
            msgLog.debug('[META-WEBHOOK] Duplicate message, skipping:', metaMsgId);
            continue;
          }

          msgLog.debug('[META-WEBHOOK] source:', source, 'text:', text, 'type:', msgType, 'pnid:', phoneNumberId);

          // Mark message as read immediately (blue ticks — shows business is active)
          if (resolved.cloud && msg.id) {
            resolved.cloud.markAsRead(msg.id).catch(() => {});
          }

          const standalone = new StandaloneService(supabase);
          const bot = new BotService(supabase, resolved.sender, standalone, intelligenceSvc);

          try {
            msgLog.debug('[META-WEBHOOK] Calling bot.handleMessage for', source, 'text:', text, 'preResolvedBiz:', preResolvedBusinessId);
            await bot.handleMessage(source, text, msgType, phoneNumberId, preResolvedBusinessId, mediaUrl);
            msgLog.debug('[META-WEBHOOK] bot.handleMessage completed for', source);
          } catch (botErr) {
            msgLog.error('[META-WEBHOOK] Bot handling failed for', source, ':', (botErr as Error)?.message || botErr);
            // Try to send error message to user so they know something went wrong
            try {
              await resolved.sender.sendText({
                to: source,
                text: 'Sorry, we encountered an error processing your message. Please try again.',
              });
            } catch (fallbackErr) {
              msgLog.error('[META-WEBHOOK] Fallback error message also failed:', fallbackErr);
            }
          }

          // Already marked as processed via upsert above
        }
      }
    }

    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    log.error('[META-WEBHOOK] Error:', error);
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

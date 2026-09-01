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

  // Atomic RPC: validates products, uses DB prices, locks inventory, creates order + items
  // Only pass product_id and quantity — never trust webhook prices (ORD-04 fix)
  const { data: result, error: rpcError } = await supabase.rpc('create_catalog_order_atomic', {
    p_business_id: biz.id,
    p_user_id: userId,
    p_delivery_phone: phone,
    p_meta_message_id: msg.id || '',
    p_customer_note: customerNote,
    p_items: items.map(i => ({ product_id: i.product_retailer_id, quantity: i.quantity })),
  });

  if (rpcError) {
    msgLog.error('[META-ORDER] Atomic order failed:', rpcError.message);
    try {
      await resolved.sender.sendText({
        to: source,
        text: 'Something went wrong on our end creating your order. Please try again.',
      });
    } catch { /* ignore */ }
    return;
  }

  if (!result.success) {
    if (result.reason === 'duplicate') {
      msgLog.info('[META-ORDER] Duplicate order skipped:', msg.id);
      return;
    }
    if (result.reason === 'no_valid_items') {
      const outOfStock: string[] = result.out_of_stock || [];
      const noItemsMsg = outOfStock.length > 0
        ? `Sorry, the following items are out of stock: ${outOfStock.join(', ')}`
        : 'Sorry, none of the selected products are available right now.';
      try {
        await resolved.sender.sendText({ to: source, text: noItemsMsg });
      } catch { /* ignore */ }
      return;
    }
    msgLog.error('[META-ORDER] Order rejected:', result.reason);
    return;
  }

  // Order committed atomically — extract results
  const orderId = result.order_id as string;
  const totalAmount = result.total_amount as number;
  const referenceCode = result.reference_code as string;
  const orderItems: Array<{ product_name: string; quantity: number; unit_price: number }> = result.items || [];
  const outOfStock: string[] = result.out_of_stock || [];

  const currency = getCurrencyForCountry(biz.country_code || 'NG');

  // Build order summary message
  const itemLines = orderItems.map(oi => `  ${oi.product_name} x${oi.quantity} - ${currency} ${oi.unit_price * oi.quantity}`).join('\n');

  let paymentLine = '';

  // Initialize payment if total > 0
  if (totalAmount > 0) {
    try {
      const gatewayName = (biz.payment_gateway || undefined) as PaymentGatewayName | undefined;
      const gateway = gatewayName
        ? getPaymentGatewayByName(gatewayName)
        : getPaymentGateway((biz.country_code || 'NG') as CountryCode);

      const paymentResult = await gateway.initializePayment({
        supabase,
        orderId,
        userId,
        amount: totalAmount,
        currency,
        referenceCode,
        businessName: biz.name,
        phone,
        callbackUrl: `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'}/payment-success`,
        businessId: biz.id,
      });

      if (paymentResult?.url) {
        // Create payment record
        await supabase.from('payments').insert({
          business_id: biz.id,
          order_id: orderId,
          user_id: userId,
          amount: totalAmount,
          currency,
          gateway: gateway.name,
          gateway_reference: referenceCode,
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
    `*Total: ${currency} ${totalAmount}*`,
    `Ref: *${referenceCode}*`,
    customerNote ? `Note: ${customerNote}` : '',
    paymentLine,
    outOfStockNote,
    '',
    totalAmount > 0 ? 'Your confirmation will arrive automatically after payment.' : 'Your order has been confirmed!',
  ].filter(Boolean).join('\n');

  try {
    await resolved.sender.sendText({ to: source, text: confirmationMsg });
  } catch (sendErr) {
    msgLog.error('[META-WEBHOOK] Failed to send catalog order confirmation:', sendErr);
  }

  msgLog.debug('[META-ORDER] Catalog order created:', referenceCode, 'total:', totalAmount);
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
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const mark = (label: string) => { timings[label] = Date.now() - t0; };

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
    mark('sig_verified');

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
          statuses?: Array<{
            id: string;
            status: string;
            timestamp: string;
            errors?: Array<{ code: number; title: string; error_data?: { details: string } }>;
          }>;
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

            // OTP delivery status tracking (append-only, idempotent)
            const { data: otpAttempt, error: attemptLookupErr } = await supabase
              .from('otp_delivery_attempts')
              .select('id')
              .eq('wa_message_id', wamid)
              .maybeSingle();

            if (attemptLookupErr) {
              log.withContext({ op: 'delivery-status.lookup', errorCode: attemptLookupErr.code }).warn('[META-WEBHOOK] Delivery attempt lookup failed');
            } else if (otpAttempt) {
              // Parse timestamp safely — Meta sends Unix seconds as string
              const tsNum = Number(status.timestamp);
              const parsedTimestamp = new Date(tsNum * 1000);
              let eventTimestamp: string;
              if (!Number.isFinite(tsNum) || tsNum <= 0 || Number.isNaN(parsedTimestamp.getTime())) {
                eventTimestamp = new Date().toISOString();
                log.withContext({ op: 'delivery-status.timestamp' }).warn('[META-WEBHOOK] Invalid status timestamp, using received time');
              } else {
                eventTimestamp = parsedTimestamp.toISOString();
              }

              const insertData: Record<string, unknown> = {
                attempt_id: otpAttempt.id,
                status: newStatus,
                event_timestamp: eventTimestamp,
              };

              // For failed statuses, record sanitized error info (no PII)
              if (isFailed && status.errors?.[0]) {
                const err = status.errors[0];
                insertData.error_code = String(err.code);
                insertData.error_title = err.title;
                // Map common Meta error codes to categories
                const code = err.code;
                if (code === 131026 || code === 131047) insertData.error_category = 'message_undeliverable';
                else if (code === 131053) insertData.error_category = 'media_error';
                else if (code === 131031 || code === 131056) insertData.error_category = 'business_account_locked';
                else if (code === 131009) insertData.error_category = 'parameter_invalid';
                else insertData.error_category = 'other';
              }

              // Idempotent insert — unique constraint on (attempt_id, status) rejects duplicates
              const { error: statusErr } = await supabase
                .from('otp_delivery_status_events')
                .insert(insertData);
              // Duplicate key error (23505) is expected for repeated callbacks — silently ignore
              if (statusErr && statusErr.code !== '23505') {
                log.withContext({ op: 'delivery-status.insert', errorCode: statusErr.code }).warn('[META-WEBHOOK] Delivery status insert failed');
              }
            }

            // #197: Payment confirmation delivery status tracking
            // Uses advance_delivery_status RPC with advisory lock for WAMID race safety
            if (newStatus in statusOrder) {
              try {
                // Parse provider timestamp — NEVER fabricate with application NOW()
                // Invalid/missing timestamps are passed as null; the RPC handles null gracefully
                const pcdTsNum = Number(status.timestamp);
                const pcdParsed = new Date(pcdTsNum * 1000);
                let pcdTimestamp: string | null;
                if (!Number.isFinite(pcdTsNum) || pcdTsNum <= 0 || Number.isNaN(pcdParsed.getTime())) {
                  pcdTimestamp = null; // Do NOT substitute application time
                  log.withContext({ op: 'delivery-status.payment-timestamp' }).warn('[META-WEBHOOK] Invalid/missing payment delivery timestamp — passing null');
                } else {
                  pcdTimestamp = pcdParsed.toISOString();
                }

                const failedErr = isFailed && status.errors?.[0]
                  ? { code: String(status.errors[0].code), reason: status.errors[0].title || 'unknown' }
                  : { code: null, reason: null };

                const { data: advanceResult } = await supabase.rpc('advance_delivery_status', {
                  p_meta_message_id: wamid,
                  p_new_status: newStatus,
                  p_provider_timestamp: pcdTimestamp,
                  p_error_code: failedErr.code,
                  p_error_reason: failedErr.reason,
                });

                if (advanceResult?.advanced) {
                  log.debug(`[META-WEBHOOK] Payment delivery status advanced: ${advanceResult.previous} -> ${newStatus}`);
                }
                // wamid_not_found_recorded_unmatched is expected during normal race — not an error

                // Opportunistic cleanup of expired unmatched callbacks (cheap, bounded)
                // cleanup_expired_unmatched_statuses is defined in migration 343
                try {
                  await supabase.rpc('cleanup_expired_unmatched_statuses');
                } catch {
                  // Non-fatal — cleanup is best-effort
                }
              } catch (pcdErr) {
                // Non-fatal — delivery tracking should not block webhook processing
                log.withContext({ op: 'delivery-status.payment-advance' }).warn('[META-WEBHOOK] Payment delivery status advance failed (non-fatal)');
              }
            }

            // #203: Promo OTP delivery status correlation
            // Uses advance_promo_pickup_status RPC for monotonic state machine
            try {
              const promoTsNum = Number(status.timestamp);
              const promoParsed = new Date(promoTsNum * 1000);
              const promoTimestamp = (!Number.isFinite(promoTsNum) || promoTsNum <= 0 || Number.isNaN(promoParsed.getTime()))
                ? null
                : promoParsed.toISOString();

              const { data: promoPickup } = await supabase
                .from('promo_pickup_verifications')
                .select('id')
                .eq('provider_message_id', wamid)
                .maybeSingle();

              if (promoPickup) {
                const { data: promoResult } = await supabase.rpc('advance_promo_pickup_status', {
                  p_provider_message_id: wamid,
                  p_status: newStatus,
                  p_timestamp: promoTimestamp,
                });
                if (promoResult?.advanced) {
                  log.debug(`[META-WEBHOOK] Promo pickup delivery advanced -> ${newStatus}`);
                }
              }
            } catch {
              // Non-fatal — promo delivery tracking should not block webhook processing
            }

            // #203: Winner contact delivery status correlation
            try {
              const wcTsNum = Number(status.timestamp);
              const wcParsed = new Date(wcTsNum * 1000);
              const wcTimestamp = (!Number.isFinite(wcTsNum) || wcTsNum <= 0 || Number.isNaN(wcParsed.getTime()))
                ? null
                : wcParsed.toISOString();

              const { data: winnerContact } = await supabase
                .from('promo_winner_contacts')
                .select('id')
                .eq('provider_message_id', wamid)
                .maybeSingle();

              if (winnerContact) {
                const { data: wcResult } = await supabase.rpc('advance_promo_winner_contact_status', {
                  p_provider_message_id: wamid,
                  p_status: newStatus,
                  p_timestamp: wcTimestamp,
                });
                if (wcResult?.advanced) {
                  log.debug(`[META-WEBHOOK] Winner contact delivery advanced -> ${newStatus}`);
                }
              }
            } catch {
              // Non-fatal — winner contact tracking should not block webhook processing
            }

            // ACC-204: Fulfillment notification delivery status correlation
            try {
              const fnTsNum = Number(status.timestamp);
              const fnParsed = new Date(fnTsNum * 1000);
              const fnTimestamp = (!Number.isFinite(fnTsNum) || fnTsNum <= 0 || Number.isNaN(fnParsed.getTime()))
                ? null
                : fnParsed.toISOString();

              const { correlateFulfillmentNotificationStatus } = await import('@/lib/promotions/fulfillment-webhook-correlator');
              await correlateFulfillmentNotificationStatus(supabase, wamid, newStatus, fnTimestamp);
            } catch {
              // Non-fatal — fulfillment notification tracking should not block webhook processing
            }
          }
        }

        if (messages.length === 0) continue;

        const supabase = createServiceClient(); // single instance for all messages in this change
        const intelligenceSvc = getIntelligence();
        // Fresh resolver each request to avoid stale cached credentials
        const resolver = new ChannelResolver(supabase);

        // Resolve channel by phone_number_id
        const resolved = await resolver.resolveByPhoneNumberId(phoneNumberId);
        mark('channel_resolved');
        log.debug('[META-WEBHOOK] Resolved channel:', resolved ? { channelId: resolved.channel.id, provider: resolved.channel.provider, phoneNumberId: resolved.channel.phone_number_id, hasToken: !!(resolved.channel.meta_access_token || process.env.META_CLOUD_ACCESS_TOKEN) } : 'NULL');
        if (!resolved) {
          log.debug('[META-WEBHOOK] No channel found for phone_number_id:', phoneNumberId);
          continue;
        }

        const preResolvedBusinessId = resolved.channel.business_id || undefined;

        for (const msg of messages) {
          const source = msg.from;
          const msgLog = log.withContext({ from: source });

          // Durable inbound event — atomic claim via RPC (#271 Slice B)
          const metaMsgId = msg.id;
          if (metaMsgId) {
            const eventId = `meta-${metaMsgId}`;

            // Atomic claim: INSERT-or-reclaim with FOR UPDATE serialization
            const whMsgType: string = msg['type'] || 'message';
            const { data: claimResult, error: claimError } = await supabase.rpc('claim_webhook_event', {
              p_event_id: eventId,
              p_gateway: 'meta_cloud',
              p_event_type: whMsgType,
            });

            if (claimError || !claimResult?.claimed) {
              msgLog.debug('[META-WEBHOOK] Event not claimed:', metaMsgId, claimResult?.reason || claimError?.message);
              continue;
            }

            const claimToken = claimResult.claim_token;
            mark('idempotency_claimed');
            // Process the message — wrap in try/catch for state updates
            try {
              // ── Handle WhatsApp Catalog order messages ──
              // When a customer adds items from the native WhatsApp catalog and submits,
              // Meta sends a message with type === 'order'. This is a parallel path to
              // the conversational ordering flow — both work independently.
              if (msg.type === 'order' && msg.order?.product_items?.length) {
                await handleCatalogOrder(supabase, resolved, msg, source, msgLog);
                // Fenced completion — only succeeds if we still hold the claim
                await supabase.rpc('complete_webhook_event', {
                  p_event_id: eventId,
                  p_claim_token: claimToken,
                });
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
                  // Use resolved.cloud (MetaCloudService) which has the DECRYPTED token.
                  // Do NOT read resolved.channel.meta_access_token directly — it's encrypted ciphertext.
                  if (!resolved.cloud) {
                    msgLog.error('[META-WEBHOOK] No MetaCloudService available for media download');
                    throw new Error('MetaCloudService not available');
                  }
                  const media = await resolved.cloud.downloadMedia(msg.audio.id);
                  if (media) {
                    const audioBuffer = media.buffer;
                    const ext = (msg.audio.mime_type || 'audio/ogg').includes('ogg') ? 'ogg' : 'webm';
                    const storagePath = `chat-audio/${preResolvedBusinessId || 'unknown'}/${Date.now()}.${ext}`;

                    await supabase.storage
                      .from('business-documents')
                      .upload(storagePath, audioBuffer, {
                        contentType: msg.audio.mime_type || 'audio/ogg',
                        upsert: false,
                      });

                    const { data: urlData } = await supabase.storage
                      .from('business-documents')
                      .createSignedUrl(storagePath, 3600);
                    mediaUrl = urlData?.signedUrl || '';

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
                            msgLog.debug('[META-WEBHOOK] Voice transcribed, length:', transcript.length);
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
                // Fenced completion — we handled it (sent guidance reply)
                await supabase.rpc('complete_webhook_event', {
                  p_event_id: eventId,
                  p_claim_token: claimToken,
                });
                continue;
              }

              if (!source || (!text && !mediaUrl)) {
                // Fenced completion — nothing to process
                await supabase.rpc('complete_webhook_event', {
                  p_event_id: eventId,
                  p_claim_token: claimToken,
                });
                continue;
              }

              msgLog.debug('[META-WEBHOOK] source: ...', source.slice(-4), 'type:', msgType, 'textLen:', text.length, 'pnid:', phoneNumberId);

              // Mark message as read immediately (blue ticks — shows business is active)
              if (resolved.cloud && msg.id) {
                resolved.cloud.markAsRead(msg.id).catch(() => {});
              }

              // Side-effect deadline: skip bot processing if we're too close to maxDuration (60s)
              // Leaves 10s buffer for graceful failure handling
              const SIDE_EFFECT_DEADLINE_MS = 50_000;
              const elapsedMs = Date.now() - t0;
              if (elapsedMs >= SIDE_EFFECT_DEADLINE_MS) {
                msgLog.warn('[META-WEBHOOK] Side-effect deadline exceeded, skipping bot processing:', metaMsgId);
                await supabase.rpc('fail_webhook_event', {
                  p_event_id: eventId,
                  p_claim_token: claimToken,
                  p_error: 'side_effect_deadline_exceeded',
                });
                continue;
              }

              const standalone = new StandaloneService(supabase);
              const bot = new BotService(supabase, resolved.sender, standalone, intelligenceSvc);

              mark('bot_enter');
              msgLog.debug('[META-WEBHOOK] Calling bot.handleMessage for ...', source.slice(-4), 'preResolvedBiz:', preResolvedBusinessId);
              await bot.handleMessage(source, text, msgType, phoneNumberId, preResolvedBusinessId, mediaUrl, metaMsgId);
              mark('bot_complete');
              msgLog.debug('[META-WEBHOOK] bot.handleMessage completed for ...', source.slice(-4));

              // Fenced completion — only succeeds if we still hold the claim
              await supabase.rpc('complete_webhook_event', {
                p_event_id: eventId,
                p_claim_token: claimToken,
              });
              mark('msg_complete');
              log.info('[META-WEBHOOK-PERF] timings_ms', timings);
            } catch (processingErr) {
              // Fenced failure — allows retry on next delivery
              msgLog.error('[META-WEBHOOK] Processing failed:', processingErr);
              await supabase.rpc('fail_webhook_event', {
                p_event_id: eventId,
                p_claim_token: claimToken,
                p_error: String(processingErr).slice(0, 500),
              });
              // Try to send error message to user so they know something went wrong
              try {
                await resolved.sender.sendText({
                  to: source,
                  text: 'Sorry, we encountered an error processing your message. Please try again.',
                });
              } catch (fallbackErr) {
                msgLog.error('[META-WEBHOOK] Fallback error message also failed:', fallbackErr);
              }
              // Don't rethrow — continue processing other messages in the batch
            }
            continue; // Move to next message
          }

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

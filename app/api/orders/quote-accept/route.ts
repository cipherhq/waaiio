import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { initializePayment } from '@/lib/bot/flows/shared/payment';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { formatCurrency, type CountryCode } from '@/lib/constants';

export async function POST(request: NextRequest) {
  try {
    const rl = rateLimitResponse(getRateLimitKey(request, 'quote-accept'), 10, 60_000); // 10 per min
    if (rl) return rl;

    const body = await request.json();
    const { quote_id, action } = body;

    if (!quote_id || !action || !['accept', 'reject'].includes(action)) {
      return NextResponse.json({ error: 'quote_id and action (accept/reject) required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Fetch quote
    const { data: quote, error: quoteError } = await supabase
      .from('quote_requests')
      .select('*')
      .eq('id', quote_id)
      .single();

    if (quoteError || !quote) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
    }

    if (quote.status !== 'quoted') {
      return NextResponse.json({ error: `Quote is already ${quote.status}` }, { status: 400 });
    }

    // Check expiry
    if (quote.expires_at && new Date(quote.expires_at) < new Date()) {
      await supabase.from('quote_requests').update({ status: 'expired' }).eq('id', quote_id);
      return NextResponse.json({ error: 'Quote has expired' }, { status: 400 });
    }

    const { data: biz } = await supabase
      .from('businesses')
      .select('id, name, country_code, subscription_tier, trial_ends_at, metadata')
      .eq('id', quote.business_id)
      .single();

    const cc = (biz?.country_code || 'NG') as CountryCode;

    if (action === 'reject') {
      await supabase.from('quote_requests').update({
        status: 'rejected',
        responded_at: new Date().toISOString(),
      }).eq('id', quote_id);

      // Notify owner
      const { data: ownerBiz } = await supabase
        .from('businesses')
        .select('phone, owner_id, profiles:owner_id (phone)')
        .eq('id', quote.business_id)
        .single();
      const ownerPhone = (ownerBiz?.phone as string) || ((ownerBiz?.profiles as unknown as { phone?: string })?.phone);

      if (ownerPhone) {
        try {
          const resolver = new ChannelResolver(supabase);
          const resolved = await resolver.resolveByBusinessId(quote.business_id);
          if (resolved?.sender) {
            const phone = ownerPhone.startsWith('+') ? ownerPhone.slice(1) : ownerPhone;
            await resolved.sender.sendText({
              to: phone,
              text: `❌ Price declined by ${quote.customer_name || quote.customer_phone || 'customer'}.\n\nEstimated: ${formatCurrency(quote.estimated_subtotal, cc)}\nYour price: ${formatCurrency(quote.quoted_amount, cc)}`,
            });
          } else {
            logger.warn('[QUOTE-ACCEPT] No messaging channel configured for business', quote.business_id);
          }
        } catch {}
      }

      return NextResponse.json({ success: true, action: 'rejected' });
    }

    // ── Accept: create order from snapshot ──
    const total = quote.quoted_amount || quote.estimated_subtotal;
    const cart = (quote.cart_snapshot || []) as Array<{
      product_id: string; name: string; quantity: number; price: number;
      variant_id?: string; variant_label?: string;
      addons?: Array<{ name: string; price: number; quantity?: number }>;
    }>;

    // Check for custom order deposit configuration
    const bizMeta = (biz?.metadata || {}) as Record<string, unknown>;
    const customConfig = (bizMeta.custom_order_config || {}) as Record<string, unknown>;
    const hasCustomOrderData = !!quote.custom_order_data;
    const depositPct = hasCustomOrderData ? ((customConfig.deposit_percentage as number) || 0) : 0;
    const depositAmount = depositPct > 0 ? Math.floor(total * depositPct / 100) : 0;
    const balanceAmount = depositPct > 0 ? total - depositAmount : 0;

    // Ensure user
    let userId = quote.user_id;
    if (!userId && quote.customer_phone) {
      const phoneP = quote.customer_phone.startsWith('+') ? quote.customer_phone : `+${quote.customer_phone}`;
      const phoneN = quote.customer_phone.startsWith('+') ? quote.customer_phone.slice(1) : quote.customer_phone;
      // Use two separate queries to avoid SQL injection via .or() string interpolation
      const { data: profileByPlus } = await supabase
        .from('profiles')
        .select('id')
        .eq('phone', phoneP)
        .limit(1)
        .maybeSingle();

      const profile = profileByPlus || (await supabase
        .from('profiles')
        .select('id')
        .eq('phone', phoneN)
        .limit(1)
        .maybeSingle()).data;
      userId = profile?.id || null;
    }

    // Create order (with deposit tracking for custom orders)
    const orderPayload: Record<string, unknown> = {
      business_id: quote.business_id,
      user_id: userId,
      status: 'confirmed',
      delivery_address: quote.delivery_address || null,
      delivery_phone: quote.customer_phone || null,
      total_amount: total,
      delivery_zone_id: quote.delivery_zone_id || null,
      delivery_zone_name: quote.delivery_zone_name || null,
      quote_request_id: quote_id,
      channel: quote.channel || 'whatsapp',
      notes: quote.quote_notes || null,
    };

    if (hasCustomOrderData) {
      orderPayload.custom_order_data = quote.custom_order_data;
    }
    if (depositPct > 0) {
      orderPayload.deposit_percentage = depositPct;
      orderPayload.deposit_amount = depositAmount;
      orderPayload.balance_amount = balanceAmount;
    }

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert(orderPayload)
      .select('id, reference_code')
      .single();

    if (orderError || !order) {
      logger.error('[QUOTE-ACCEPT] Order creation failed:', orderError);
      return NextResponse.json({ error: 'Failed to create order' }, { status: 500 });
    }

    // Create order items + decrement stock
    for (const item of cart) {
      await supabase.from('order_items').insert({
        order_id: order.id,
        product_id: item.product_id,
        quantity: item.quantity,
        unit_price: item.price,
        variant_id: item.variant_id || null,
        variant_label: item.variant_label || null,
        addons: item.addons || [],
      });

      // Decrement stock
      if (item.variant_id) {
        const { data: variant } = await supabase
          .from('product_variants')
          .select('stock_quantity')
          .eq('id', item.variant_id)
          .single();
        if (variant && variant.stock_quantity != null) {
          await supabase.from('product_variants')
            .update({ stock_quantity: Math.max(0, variant.stock_quantity - item.quantity) })
            .eq('id', item.variant_id);
        }
      } else if (item.product_id) {
        const { data: product } = await supabase
          .from('products')
          .select('stock_quantity, track_inventory')
          .eq('id', item.product_id)
          .single();
        if (product?.track_inventory && product.stock_quantity != null) {
          await supabase.from('products')
            .update({ stock_quantity: Math.max(0, product.stock_quantity - item.quantity) })
            .eq('id', item.product_id);
        }
      }
    }

    // Update quote
    await supabase.from('quote_requests').update({
      status: 'accepted',
      responded_at: new Date().toISOString(),
      order_id: order.id,
    }).eq('id', quote_id);

    // Platform fee is NOT recorded here — it will be recorded when the customer
    // actually pays via the gateway webhook → processSuccessfulPayment → recordPlatformFee.

    // Initialize payment and send link to customer
    const paymentAmount = depositAmount > 0 ? depositAmount : total;
    if (paymentAmount > 0 && quote.customer_phone) {
      const paymentResult = await initializePayment(supabase, {
        orderId: order.id,
        userId: userId || undefined,
        amount: paymentAmount,
        referenceCode: order.reference_code,
        businessName: biz?.name || 'Shop',
        phone: quote.customer_phone,
        countryCode: cc,
        businessId: biz?.id,
      });

      if (paymentResult) {
        try {
          const resolver = new ChannelResolver(supabase);
          const resolved = await resolver.resolveByBusinessId(quote.business_id);
          if (!resolved?.sender) {
            logger.warn('[QUOTE-ACCEPT] No messaging channel configured for business', quote.business_id);
          } else {
          const sender = resolved.sender;
          const phone = quote.customer_phone.startsWith('+')
            ? quote.customer_phone.slice(1)
            : quote.customer_phone;

          const messageLines = depositAmount > 0
            ? [
                `✅ *Price Accepted!*`,
                '',
                `\uD83D\uDED2 ${biz?.name || 'Shop'}`,
                `\uD83D\uDD11 Ref: *${order.reference_code}*`,
                `\uD83D\uDCB0 Deposit (${depositPct}%): *${formatCurrency(depositAmount, cc)}*`,
                `\uD83D\uDCB5 Balance due: *${formatCurrency(balanceAmount, cc)}*`,
                '',
                `\uD83D\uDCB3 Pay deposit now \uD83D\uDC47`,
                paymentResult.url,
                '',
                `Balance will be requested when your order is ready.`,
              ]
            : [
                `✅ *Price Accepted!*`,
                '',
                `\uD83D\uDED2 ${biz?.name || 'Shop'}`,
                `\uD83D\uDD11 Ref: *${order.reference_code}*`,
                `\uD83D\uDCB0 Total: *${formatCurrency(total, cc)}*`,
                '',
                `\uD83D\uDCB3 Pay here \uD83D\uDC47`,
                paymentResult.url,
              ];

          await sender.sendText({
            to: phone,
            text: messageLines.join('\n'),
          });
          }
        } catch (err) {
          logger.error('[QUOTE-ACCEPT] Payment link send error:', err);
        }
      }
    }

    // Notify owner
    const { data: ownerBiz } = await supabase
      .from('businesses')
      .select('phone')
      .eq('id', quote.business_id)
      .single();

    if (ownerBiz?.phone) {
      try {
        const resolver = new ChannelResolver(supabase);
        const resolved = await resolver.resolveByBusinessId(quote.business_id);
        if (resolved?.sender) {
          const phone = (ownerBiz.phone as string).startsWith('+') ? (ownerBiz.phone as string).slice(1) : ownerBiz.phone as string;
          await resolved.sender.sendText({
            to: phone,
            text: `✅ Price accepted by ${quote.customer_name || 'customer'}!\n\n🔑 Order: *${order.reference_code}*\n💰 Amount: *${formatCurrency(total, cc)}*`,
          });
        } else {
          logger.warn('[QUOTE-ACCEPT] No messaging channel configured for owner notification', quote.business_id);
        }
      } catch {}
    }

    return NextResponse.json({ success: true, action: 'accepted', orderId: order.id, referenceCode: order.reference_code });
  } catch (error) {
    logger.error('[QUOTE-ACCEPT] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

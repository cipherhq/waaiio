import { NextResponse, type NextRequest } from 'next/server';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { initializePayment } from '@/lib/bot/flows/shared/payment';
import { authenticateRequest } from '@/lib/api-auth';
import { logger } from '@/lib/logger';
import { formatCurrency, type CountryCode } from '@/lib/constants';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { order_id, business_id } = body;

    if (!order_id || !business_id) {
      return NextResponse.json({ error: 'order_id and business_id required' }, { status: 400 });
    }

    const auth = await authenticateRequest(request, { requireBusinessOwnership: true, body });
    if (auth instanceof NextResponse) return auth;

    const supabase = auth.service;

    // Fetch order
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, reference_code, business_id, user_id, total_amount, balance_amount, balance_paid_at, delivery_phone, status')
      .eq('id', order_id)
      .eq('business_id', business_id)
      .single();

    if (orderError || !order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    if (!order.balance_amount || order.balance_amount <= 0) {
      return NextResponse.json({ error: 'No balance due on this order' }, { status: 400 });
    }

    if (order.balance_paid_at) {
      return NextResponse.json({ error: 'Balance already paid' }, { status: 400 });
    }

    const { data: biz } = await supabase
      .from('businesses')
      .select('id, name, country_code')
      .eq('id', business_id)
      .single();

    const cc = (biz?.country_code || 'NG') as CountryCode;
    const customerPhone = order.delivery_phone;

    if (!customerPhone) {
      return NextResponse.json({ error: 'No customer phone on order' }, { status: 400 });
    }

    // Update order status to ready
    await supabase
      .from('orders')
      .update({ status: 'ready' })
      .eq('id', order_id);

    // Initialize payment for balance amount
    const paymentResult = await initializePayment(supabase, {
      orderId: order.id,
      userId: order.user_id || undefined,
      amount: order.balance_amount,
      referenceCode: order.reference_code,
      businessName: biz?.name || 'Shop',
      phone: customerPhone,
      countryCode: cc,
      businessId: business_id,
    });

    if (!paymentResult) {
      return NextResponse.json({ error: 'Failed to initialize payment' }, { status: 500 });
    }

    // Send WhatsApp to customer
    try {
      const resolver = new ChannelResolver(supabase);
      const resolved = await resolver.resolveByBusinessId(business_id);
      if (!resolved?.sender) {
        logger.warn('[REQUEST-BALANCE] No messaging channel configured for business', business_id);
      } else {
        const sender = resolved.sender;
        const phone = customerPhone.startsWith('+') ? customerPhone.slice(1) : customerPhone;

        await sender.sendText({
          to: phone,
          text: [
            `\u2705 *Your Order is Ready!*`,
            '',
            `\uD83D\uDED2 ${biz?.name || 'Shop'}`,
            `\uD83D\uDD11 Ref: *${order.reference_code}*`,
            `\uD83D\uDCB0 Balance Due: *${formatCurrency(order.balance_amount, cc)}*`,
            '',
            `\uD83D\uDCB3 Pay the balance to collect your order \uD83D\uDC47`,
            paymentResult.url,
          ].join('\n'),
        });
      }
    } catch (err) {
      logger.error('[REQUEST-BALANCE] WhatsApp send error:', err);
    }

    return NextResponse.json({
      success: true,
      paymentUrl: paymentResult.url,
      balanceAmount: order.balance_amount,
    });
  } catch (error) {
    logger.error('[REQUEST-BALANCE] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

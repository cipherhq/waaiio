/**
 * Catalog order handler — shared between webhook route and tests (#256).
 *
 * Extracted from app/api/webhook/meta-cloud/route.ts so the production
 * binding/suspension behavior can be tested directly without Next.js
 * route export restrictions.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import type { ResolvedChannel } from '@/lib/channels/channel-resolver';
import { logger } from '@/lib/logger';
import { createWhatsAppUser } from '@/lib/bot/flows/shared/user';
import { getCurrencyForCountry } from '@/lib/channels/catalog';
import { getPaymentGateway, getPaymentGatewayByName } from '@/lib/payments/factory';
import type { CountryCode, PaymentGatewayName } from '@/lib/constants';

export async function handleCatalogOrder(
  supabase: SupabaseClient,
  resolved: ResolvedChannel,
  msg: { order?: { catalog_id: string; text?: string; product_items: Array<{ product_retailer_id: string; quantity: number; item_price: number; currency: string }> }; id?: string },
  source: string,
  msgLog: ReturnType<typeof logger.withContext>,
  sender: MessageSender,
) {
  const outbound = sender;
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
      // Platform-scoped: no known business, send neutral guidance
      if (outbound.sendPlatformText) {
        await outbound.sendPlatformText({ to: source, text: 'Sorry, this catalog is currently unavailable. Please try again later.' });
      }
    } catch { /* ignore */ }
    return;
  }

  // S-1 (#256): Bind the catalog-resolved business before business-attributable responses
  if (outbound.bindBusiness) outbound.bindBusiness(biz.id);

  // Create or find user profile for the WhatsApp customer
  const phone = source.startsWith('+') ? source : `+${source}`;
  const userId = await createWhatsAppUser(supabase, source, '', '');
  if (!userId) {
    msgLog.error('[META-WEBHOOK] Failed to create/find user for catalog order');
    try {
      await outbound.sendText({ to: source, text: 'Something went wrong on our end. Please try again.' });
    } catch { /* ignore */ }
    return;
  }

  // Atomic RPC: validates products, uses DB prices, locks inventory, creates order + items
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
      await outbound.sendText({ to: source, text: 'Something went wrong on our end creating your order. Please try again.' });
    } catch { /* ignore */ }
    return;
  }

  if (!result.success) {
    if (result.reason === 'duplicate') { msgLog.info('[META-ORDER] Duplicate order skipped:', msg.id); return; }
    if (result.reason === 'no_valid_items') {
      const outOfStock: string[] = result.out_of_stock || [];
      const noItemsMsg = outOfStock.length > 0 ? `Sorry, the following items are out of stock: ${outOfStock.join(', ')}` : 'Sorry, none of the selected products are available right now.';
      try { await outbound.sendText({ to: source, text: noItemsMsg }); } catch { /* ignore */ }
      return;
    }
    msgLog.error('[META-ORDER] Order rejected:', result.reason);
    return;
  }

  const orderId = result.order_id as string;
  const totalAmount = result.total_amount as number;
  const referenceCode = result.reference_code as string;
  const orderItems: Array<{ product_name: string; quantity: number; unit_price: number }> = result.items || [];
  const outOfStock: string[] = result.out_of_stock || [];
  const currency = getCurrencyForCountry(biz.country_code || 'NG');
  const itemLines = orderItems.map(oi => `  ${oi.product_name} x${oi.quantity} - ${currency} ${oi.unit_price * oi.quantity}`).join('\n');
  let paymentLine = '';

  if (totalAmount > 0) {
    try {
      const gatewayName = (biz.payment_gateway || undefined) as PaymentGatewayName | undefined;
      const gateway = gatewayName ? getPaymentGatewayByName(gatewayName) : getPaymentGateway((biz.country_code || 'NG') as CountryCode);
      const paymentResult = await gateway.initializePayment({
        supabase, orderId, userId, amount: totalAmount, currency, referenceCode,
        businessName: biz.name, phone,
        callbackUrl: `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'}/payment-success`,
        businessId: biz.id,
      });
      if (paymentResult?.url) {
        await supabase.from('payments').insert({
          business_id: biz.id, order_id: orderId, user_id: userId,
          amount: totalAmount, currency, gateway: gateway.name,
          gateway_reference: referenceCode, status: 'pending',
        });
        paymentLine = `\nPay here:\n${paymentResult.url}`;
      }
    } catch (payErr) {
      msgLog.error('[META-WEBHOOK] Payment init failed for catalog order:', payErr);
      paymentLine = '\nPlease contact the business to arrange payment.';
    }
  }

  const outOfStockNote = outOfStock.length > 0
    ? `\n\n_Note: ${outOfStock.join(', ')} ${outOfStock.length === 1 ? 'was' : 'were'} out of stock and removed from your order._`
    : '';
  const confirmationMsg = [
    `*Order Received!*`, '', `*${biz.name}*`, '', itemLines, '',
    `*Total: ${currency} ${totalAmount}*`, `Ref: *${referenceCode}*`,
    customerNote ? `Note: ${customerNote}` : '', paymentLine, outOfStockNote, '',
    totalAmount > 0 ? 'Your confirmation will arrive automatically after payment.' : 'Your order has been confirmed!',
  ].filter(Boolean).join('\n');

  try { await outbound.sendText({ to: source, text: confirmationMsg }); }
  catch (sendErr) { msgLog.error('[META-WEBHOOK] Failed to send catalog order confirmation:', sendErr); }
  msgLog.debug('[META-ORDER] Catalog order created:', referenceCode, 'total:', totalAmount);
}

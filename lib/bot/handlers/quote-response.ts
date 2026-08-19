import { logger } from '@/lib/logger';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { initializePayment } from '@/lib/bot/flows/shared/payment';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { stripPlus } from '@/lib/utils/phone';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Handle a quote accept/reject button postback from WhatsApp.
 *
 * Uses atomic RPCs (accept_order_quote_atomic / reject_order_quote_atomic)
 * with the Meta-verified WhatsApp `from` as the trusted customer identity.
 * All financial values and cart data are derived from the database, never caller input.
 */
export async function handleQuoteResponse(
  supabase: SupabaseClient,
  sendText: (to: string, text: string) => Promise<void>,
  from: string,
  quoteId: string,
  action: 'accept' | 'reject',
): Promise<void> {
  try {
    if (action === 'reject') {
      const { data: result, error } = await supabase.rpc('reject_order_quote_atomic', {
        p_quote_id: quoteId,
        p_customer_phone: from,
      });

      if (error) {
        logger.error('[QUOTE-RESPONSE] reject RPC error:', error.message);
        await sendText(from, 'Something went wrong. Please try again.');
        return;
      }

      if (!result?.rejected) {
        const reason = result?.reason || 'unknown';
        if (reason === 'identity_mismatch') {
          await sendText(from, 'This quote was sent to a different number. Please use the original number.');
        } else if (reason === 'already_accepted') {
          await sendText(from, 'This quote has already been accepted.');
        } else if (reason === 'expired') {
          await sendText(from, 'This quote has expired.');
        } else {
          await sendText(from, 'This quote is no longer available.');
        }
        return;
      }

      await sendText(from, 'Price declined. Thank you for considering!');

      // Notify business owner of rejection
      try {
        const businessId = result.business_id as string;
        const customerName = result.customer_name || result.customer_phone || 'customer';
        const { data: biz } = await supabase
          .from('businesses')
          .select('phone, country_code, owner_id, profiles:owner_id (phone)')
          .eq('id', businessId)
          .single();

        const cc = (biz?.country_code || 'NG') as CountryCode;
        const ownerPhone = (biz?.phone as string) || ((biz?.profiles as unknown as { phone?: string })?.phone);

        if (ownerPhone) {
          const resolver = new ChannelResolver(supabase);
          const resolved = await resolver.resolveByBusinessId(businessId);
          if (resolved?.sender) {
            await resolved.sender.sendText({
              to: stripPlus(ownerPhone),
              text: `❌ Price declined by ${customerName}.\n\nEstimated: ${formatCurrency(result.estimated_subtotal, cc)}\nYour price: ${formatCurrency(result.quoted_amount, cc)}`,
            });
          }
        }
      } catch (err) {
        logger.error('[QUOTE-RESPONSE] Owner reject notification failed:', err);
      }
      return;
    }

    // ── Accept ──
    const { data: result, error } = await supabase.rpc('accept_order_quote_atomic', {
      p_quote_id: quoteId,
      p_customer_phone: from,
    });

    if (error) {
      // Check for insufficient stock exception
      if (error.message?.includes('insufficient_stock')) {
        const items = error.message.split(':').slice(1).join(':');
        await sendText(from, `Sorry, the following items are out of stock: ${items}. Please contact the business.`);
        return;
      }
      logger.error('[QUOTE-RESPONSE] accept RPC error:', error.message);
      await sendText(from, 'Something went wrong. Please try again.');
      return;
    }

    if (!result?.accepted) {
      const reason = result?.reason || 'unknown';
      if (reason === 'identity_mismatch') {
        await sendText(from, 'This quote was sent to a different number. Please use the original number.');
      } else if (reason === 'already_rejected') {
        await sendText(from, 'This quote has already been declined.');
      } else if (reason === 'expired') {
        await sendText(from, 'This quote has expired. Please request a new one.');
      } else {
        await sendText(from, 'This quote is no longer available.');
      }
      return;
    }

    // Idempotent accept — order already exists
    if (result.already_accepted) {
      await sendText(from, `Your order *${result.reference_code}* is already being processed.`);
      return;
    }

    // Fetch business details for payment + notifications
    const { data: biz } = await supabase
      .from('businesses')
      .select('id, name, phone, country_code, owner_id, profiles:owner_id (phone)')
      .eq('id', result.business_id as string)
      .single();

    const cc = (biz?.country_code || 'NG') as CountryCode;
    const total = (result.total as number) || 0;
    const depositAmount = (result.deposit_amount as number) || 0;
    const balanceAmount = (result.balance_amount as number) || 0;
    const orderId = result.order_id as string;
    const referenceCode = result.reference_code as string;
    const customerPhone = result.customer_phone as string;

    // Initialize payment and send link to customer
    const paymentAmount = depositAmount > 0 ? depositAmount : total;
    if (paymentAmount > 0 && customerPhone) {
      // Look up user_id for payment initialization
      const phoneP = customerPhone.startsWith('+') ? customerPhone : `+${customerPhone}`;
      const phoneN = stripPlus(customerPhone);
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

      const paymentResult = await initializePayment(supabase, {
        orderId,
        userId: profile?.id || undefined,
        amount: paymentAmount,
        referenceCode,
        businessName: biz?.name || 'Shop',
        phone: customerPhone,
        countryCode: cc,
        businessId: biz?.id,
      });

      if (paymentResult) {
        const depositPct = depositAmount > 0 ? Math.round(depositAmount / total * 100) : 0;
        const messageLines = depositAmount > 0
          ? [
              '✅ *Price Accepted!*',
              '',
              `🛒 ${biz?.name || 'Shop'}`,
              `🔑 Ref: *${referenceCode}*`,
              `💰 Deposit (${depositPct}%): *${formatCurrency(depositAmount, cc)}*`,
              `💵 Balance due: *${formatCurrency(balanceAmount, cc)}*`,
              '',
              '💳 Pay deposit now 👇',
              paymentResult.url,
              '',
              'Balance will be requested when your order is ready.',
            ]
          : [
              '✅ *Price Accepted!*',
              '',
              `🛒 ${biz?.name || 'Shop'}`,
              `🔑 Ref: *${referenceCode}*`,
              `💰 Total: *${formatCurrency(total, cc)}*`,
              '',
              '💳 Pay here 👇',
              paymentResult.url,
            ];

        await sendText(from, messageLines.join('\n'));
      } else {
        // Payment init failed but order exists
        await sendText(from, `✅ *Price Accepted!*\n\n🔑 Order: *${referenceCode}*\n💰 Total: *${formatCurrency(total, cc)}*\n\nPlease contact the business for payment details.`);
      }
    } else if (total === 0) {
      // Free order
      await sendText(from, `✅ *Order Confirmed!*\n\n🔑 Ref: *${referenceCode}*\n\nNo payment required.`);
    }

    // Notify business owner of acceptance
    try {
      const ownerPhone = (biz?.phone as string) || ((biz?.profiles as unknown as { phone?: string })?.phone);
      if (ownerPhone) {
        const resolver = new ChannelResolver(supabase);
        const resolved = await resolver.resolveByBusinessId(result.business_id as string);
        if (resolved?.sender) {
          await resolved.sender.sendText({
            to: stripPlus(ownerPhone),
            text: `✅ Price accepted by customer!\n\n🔑 Order: *${referenceCode}*\n💰 Amount: *${formatCurrency(total, cc)}*`,
          });
        }
      }
    } catch (err) {
      logger.error('[QUOTE-RESPONSE] Owner accept notification failed:', err);
    }
  } catch (err) {
    logger.error('[QUOTE-RESPONSE] Error:', err);
    await sendText(from, 'Something went wrong on our end. Send *Hi* to start over.');
  }
}

import type { FlowDefinition, FlowContext, PromptMessage, ValidationResult } from './types';
import { createWhatsAppUser, findUserByPhone } from './shared/user';
import { initializePaystackPayment, verifyPaystackPayment, recordPlatformFee } from './shared/payment';
import { getOrderConfirmationMessage } from './shared/templates';
import type { SubscriptionTier } from '@/lib/constants';

interface CartItem {
  product_id: string;
  name: string;
  quantity: number;
  price: number;
}

export const orderingFlow: FlowDefinition = {
  type: 'ordering',
  steps: [
    // ── Browse Catalog ──
    {
      id: 'browse_catalog',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        if (!ctx.business) return [{ type: 'text', text: 'Business not found.' }];

        const { data: products } = await ctx.supabase
          .from('products')
          .select('id, name, price, category')
          .eq('business_id', ctx.business.id)
          .eq('is_active', true)
          .order('sort_order')
          .limit(10);

        if (!products || products.length === 0) {
          return [{ type: 'text', text: 'No products available right now. Check back later!' }];
        }

        // Initialize cart
        if (!ctx.session.session_data.cart) {
          ctx.session.session_data.cart = [];
        }

        return [{
          type: 'list',
          title: 'Our Products',
          body: `Welcome to ${ctx.business.name}! 🛍️\n\nBrowse our products:`,
          buttonLabel: 'Browse',
          items: products.map(p => ({
            title: p.name,
            description: `₦${p.price.toLocaleString()}`,
            postbackText: p.id,
          })),
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const { data: product } = await ctx.supabase
          .from('products')
          .select('id, name, price, stock_quantity')
          .eq('id', input)
          .eq('business_id', ctx.business!.id)
          .single();

        if (!product) return { valid: false, errorMessage: 'Please select a valid product.' };

        if (product.stock_quantity !== null && product.stock_quantity <= 0) {
          return { valid: false, errorMessage: `Sorry, ${product.name} is out of stock.` };
        }

        return {
          valid: true,
          data: {
            current_product_id: product.id,
            current_product_name: product.name,
            current_product_price: product.price,
          },
        };
      },
      async next() { return 'select_quantity'; },
    },

    // ── Select Quantity ──
    {
      id: 'select_quantity',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        return [
          {
            type: 'text',
            text: `*${d.current_product_name}* — ₦${(d.current_product_price as number).toLocaleString()}\n\nHow many would you like?`,
          },
          {
            type: 'buttons',
            body: 'Select quantity:',
            buttons: [
              { id: '1', title: '1' },
              { id: '2', title: '2' },
              { id: '3', title: '3' },
            ],
          },
        ];
      },
      async validate(input: string): Promise<ValidationResult> {
        const qty = parseInt(input, 10);
        if (isNaN(qty) || qty < 1 || qty > 99) {
          return { valid: false, errorMessage: 'Please enter a number between 1 and 99.' };
        }
        return { valid: true, data: { current_quantity: qty } };
      },
      async next() { return 'add_to_cart'; },
    },

    // ── Add to Cart (processing step) ──
    {
      id: 'add_to_cart',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        const cart = (d.cart as CartItem[]) || [];

        cart.push({
          product_id: d.current_product_id as string,
          name: d.current_product_name as string,
          quantity: d.current_quantity as number,
          price: d.current_product_price as number,
        });

        d.cart = cart;
        const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

        await ctx.supabase
          .from('bot_sessions')
          .update({ session_data: d, current_step: 'continue_or_checkout' })
          .eq('id', ctx.session.id);

        const itemSummary = cart.map(i => `  • ${i.name} x${i.quantity} — ₦${(i.price * i.quantity).toLocaleString()}`).join('\n');

        return [
          {
            type: 'text',
            text: `✅ Added! Your cart:\n\n${itemSummary}\n\n*Total: ₦${total.toLocaleString()}*`,
          },
          {
            type: 'buttons',
            body: 'What next?',
            buttons: [
              { id: 'checkout', title: 'Checkout 💳' },
              { id: 'add_more', title: 'Add More' },
            ],
          },
        ];
      },
      async validate(): Promise<ValidationResult> { return { valid: true }; },
      async next() { return null; },
    },

    // ── Continue or Checkout ──
    {
      id: 'continue_or_checkout',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const cart = (ctx.session.session_data.cart as CartItem[]) || [];
        const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
        return [{
          type: 'buttons',
          body: `Cart total: ₦${total.toLocaleString()}\n\nCheckout or add more items?`,
          buttons: [
            { id: 'checkout', title: 'Checkout 💳' },
            { id: 'add_more', title: 'Add More' },
          ],
        }];
      },
      async validate(input: string): Promise<ValidationResult> {
        if (input.toLowerCase() === 'add_more') {
          return { valid: true, data: { _action: 'add_more' } };
        }
        if (input.toLowerCase() === 'checkout') {
          return { valid: true, data: { _action: 'checkout' } };
        }
        return { valid: false, errorMessage: 'Please tap *Checkout* or *Add More*.' };
      },
      async next(ctx: FlowContext) {
        return ctx.session.session_data._action === 'add_more' ? 'browse_catalog' : 'delivery_details';
      },
    },

    // ── Delivery Details ──
    {
      id: 'delivery_details',
      async prompt(): Promise<PromptMessage[]> {
        return [
          {
            type: 'buttons',
            body: 'Would you like delivery or pickup?',
            buttons: [
              { id: 'delivery', title: '🚚 Delivery' },
              { id: 'pickup', title: '🏪 Pickup' },
            ],
          },
        ];
      },
      async validate(input: string): Promise<ValidationResult> {
        if (input.toLowerCase() === 'pickup') {
          return { valid: true, data: { delivery_type: 'pickup' } };
        }
        if (input.toLowerCase() === 'delivery') {
          return { valid: true, data: { delivery_type: 'delivery' } };
        }
        return { valid: false, errorMessage: 'Please tap *Delivery* or *Pickup*.' };
      },
      async next(ctx: FlowContext) {
        return ctx.session.session_data.delivery_type === 'delivery' ? 'collect_address' : 'collect_name';
      },
    },

    // ── Collect Address ──
    {
      id: 'collect_address',
      async prompt(): Promise<PromptMessage[]> {
        return [{ type: 'text', text: '📍 Please type your delivery address:' }];
      },
      async validate(input: string): Promise<ValidationResult> {
        if (input.trim().length < 5) {
          return { valid: false, errorMessage: 'Please enter a valid address.' };
        }
        return { valid: true, data: { delivery_address: input.trim() } };
      },
      async next() { return 'collect_name'; },
    },

    // ── Collect Name ──
    {
      id: 'collect_name',
      async prompt(): Promise<PromptMessage[]> {
        return [{ type: 'text', text: 'What name should we put on the order?\n\nType your *full name*:' }];
      },
      async validate(input: string): Promise<ValidationResult> {
        const parts = input.trim().split(/\s+/);
        if (!parts[0] || parts[0].length < 2) {
          return { valid: false, errorMessage: 'Please enter a valid name.' };
        }
        return { valid: true, data: { first_name: parts[0], last_name: parts.slice(1).join(' ') || '' } };
      },
      async next() { return 'process_order'; },
      async skipIf(ctx: FlowContext) {
        if (ctx.session.user_id) {
          const user = await findUserByPhone(ctx.supabase, ctx.from);
          if (user?.first_name) {
            ctx.session.session_data.first_name = user.first_name;
            ctx.session.session_data.last_name = user.last_name;
            return true;
          }
        }
        return false;
      },
    },

    // ── Process Order ──
    {
      id: 'process_order',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        const cart = (d.cart as CartItem[]) || [];
        const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

        // Ensure user exists
        let userId = ctx.session.user_id;
        if (!userId) {
          userId = await createWhatsAppUser(ctx.supabase, ctx.from, (d.first_name as string) || '', (d.last_name as string) || '');
          if (userId) {
            ctx.session.user_id = userId;
            await ctx.supabase.from('bot_sessions').update({ user_id: userId }).eq('id', ctx.session.id);
          }
        }
        if (!userId) return [{ type: 'text', text: 'Something went wrong. Send *Hi* to try again.' }];

        // Create order
        const { data: order, error } = await ctx.supabase
          .from('orders')
          .insert({
            business_id: ctx.business!.id,
            user_id: userId,
            status: 'confirmed',
            delivery_address: (d.delivery_address as string) || null,
            delivery_phone: ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`,
            total_amount: total,
            channel: 'whatsapp',
            notes: d.delivery_type === 'pickup' ? 'Pickup order' : null,
          })
          .select('id, reference_code')
          .single();

        if (error || !order) {
          return [{ type: 'text', text: 'Something went wrong creating your order. Send *Hi* to try again.' }];
        }

        // Create order items
        for (const item of cart) {
          await ctx.supabase.from('order_items').insert({
            order_id: order.id,
            product_id: item.product_id,
            quantity: item.quantity,
            unit_price: item.price,
          });
        }

        d.order_id = order.id;
        d.reference_code = order.reference_code;
        d.total_amount = total;

        // Record platform fee
        if (ctx.business && total > 0) {
          const isInTrial = new Date(ctx.business.trial_ends_at) > new Date();
          await recordPlatformFee(ctx.supabase, {
            businessId: ctx.business.id,
            orderId: order.id,
            transactionAmount: total,
            tier: ctx.business.subscription_tier as SubscriptionTier,
            isInTrial,
          });
        }

        if (total > 0) {
          // Initialize payment
          const paymentResult = await initializePaystackPayment(ctx.supabase, {
            orderId: order.id,
            userId,
            amount: total,
            referenceCode: order.reference_code,
            businessName: ctx.business?.name || 'Shop',
            phone: ctx.from,
          });

          if (paymentResult) {
            d.payment_reference = paymentResult.reference;
            await ctx.supabase
              .from('bot_sessions')
              .update({ session_data: d, current_step: 'await_order_payment' })
              .eq('id', ctx.session.id);

            return [
              {
                type: 'text',
                text: getOrderConfirmationMessage({
                  businessName: ctx.business?.name || 'Shop',
                  items: cart,
                  totalAmount: total,
                  referenceCode: order.reference_code,
                  deliveryAddress: d.delivery_address as string | undefined,
                }) + `\n\n💳 Pay here 👇\n${paymentResult.url}`,
              },
              {
                type: 'buttons',
                body: "Tap *I've Paid* after completing payment:",
                buttons: [
                  { id: 'i_paid', title: "I've Paid" },
                  { id: 'cancel', title: 'Cancel' },
                ],
              },
            ];
          }
        }

        // Free order or payment init failed
        await ctx.supabase
          .from('bot_sessions')
          .update({ current_step: 'complete', is_active: false })
          .eq('id', ctx.session.id);

        return [{
          type: 'text',
          text: getOrderConfirmationMessage({
            businessName: ctx.business?.name || 'Shop',
            items: cart,
            totalAmount: total,
            referenceCode: order.reference_code,
            deliveryAddress: d.delivery_address as string | undefined,
          }),
        }];
      },
      async validate(): Promise<ValidationResult> { return { valid: true }; },
      async next() { return null; },
    },

    // ── Await Order Payment ──
    {
      id: 'await_order_payment',
      async prompt(): Promise<PromptMessage[]> {
        return [{
          type: 'buttons',
          body: "Complete payment using the link above.\n\nTap *I've Paid* after paying:",
          buttons: [
            { id: 'i_paid', title: "I've Paid" },
            { id: 'cancel', title: 'Cancel' },
          ],
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const text = input.toLowerCase();

        if (text === 'cancel') {
          const orderId = ctx.session.session_data.order_id as string;
          if (orderId) {
            await ctx.supabase.from('orders').update({ status: 'cancelled' }).eq('id', orderId);
          }
          await ctx.gupshup.sendText({ to: ctx.from, text: 'Order cancelled. Send *Hi* to start again.' });
          return { valid: true, data: { _action: 'cancel' } };
        }

        if (text === 'i_paid' || text === 'paid' || text === 'done') {
          const ref = ctx.session.session_data.payment_reference as string;
          if (!ref) return { valid: true, data: { _action: 'cancel' } };

          const verified = await verifyPaystackPayment(ctx.supabase, ref);
          if (verified) {
            await ctx.gupshup.sendText({
              to: ctx.from,
              text: `✅ *Payment Confirmed!*\n\nYour order *${ctx.session.session_data.reference_code}* has been confirmed.\n\nThank you! 🎉`,
            });
            return { valid: true, data: { _action: 'payment_confirmed' } };
          }

          return { valid: false, errorMessage: "Payment not yet received. Please complete payment." };
        }

        return { valid: false, errorMessage: "Tap *I've Paid* or *Cancel*." };
      },
      async next() { return null; },
    },
  ],
};

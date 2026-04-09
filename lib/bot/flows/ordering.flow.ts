import type { FlowDefinition, FlowContext, PromptMessage, ValidationResult } from './types';
import { createWhatsAppUser, findUserByPhone } from './shared/user';
import { initializePayment, verifyPayment, recordPlatformFee } from './shared/payment';
import { getOrderConfirmationMessage } from './shared/templates';
import { handlePostCompletion } from './shared/post-completion';
import { formatCurrency, type CountryCode, type SubscriptionTier } from '@/lib/constants';

/** Category-specific labels for ordering flow */
function getOrderingLabels(category: string): { noun: string; emoji: string; browseLabel: string } {
  switch (category) {
    case 'restaurant':
    case 'food_delivery':
      return { noun: 'menu', emoji: '\uD83C\uDF7D\uFE0F', browseLabel: 'View Menu' };
    case 'pharmacy':
      return { noun: 'medicines', emoji: '\uD83D\uDC8A', browseLabel: 'Browse' };
    case 'logistics':
      return { noun: 'services', emoji: '\uD83D\uDCE6', browseLabel: 'Browse' };
    default:
      return { noun: 'products', emoji: '\uD83D\uDECD\uFE0F', browseLabel: 'Browse' };
  }
}

interface OptionGroup {
  name: string;
  values: string[];
}

interface CartItem {
  product_id: string;
  name: string;
  quantity: number;
  price: number;
  variant_id?: string;
  variant_label?: string;
}

export const orderingFlow: FlowDefinition = {
  type: 'ordering',
  steps: [
    // ── Browse Catalog ──
    {
      id: 'browse_catalog',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        if (!ctx.business) return [{ type: 'text', text: 'Business not found.' }];

        const { data: rawProducts } = await ctx.supabase
          .from('products')
          .select('id, name, price, category, stock_quantity, track_inventory, low_stock_threshold, has_variants, image_url, variant_options')
          .eq('business_id', ctx.business.id)
          .eq('is_active', true)
          .order('sort_order')
          .limit(10);

        // Filter out out-of-stock items that track inventory
        const products = (rawProducts || []).filter(p =>
          !p.track_inventory || (p.stock_quantity !== null && p.stock_quantity > 0)
        );

        if (!products || products.length === 0) {
          return [{ type: 'text', text: 'Nothing available right now. Check back later!' }];
        }

        // Initialize cart
        if (!ctx.session.session_data.cart) {
          ctx.session.session_data.cart = [];
        }

        const cc = (ctx.business.country_code || 'NG') as CountryCode;
        const labels = getOrderingLabels(ctx.business.category);
        return [{
          type: 'list',
          title: `Our ${labels.noun.charAt(0).toUpperCase() + labels.noun.slice(1)}`,
          body: `Welcome to ${ctx.business.name}! ${labels.emoji}\n\nBrowse our ${labels.noun}:`,
          buttonLabel: labels.browseLabel,
          items: products.map(p => {
            let desc = p.has_variants ? 'Multiple options' : formatCurrency(p.price, cc);
            if (!p.has_variants && p.track_inventory && p.stock_quantity !== null && p.low_stock_threshold && p.stock_quantity <= p.low_stock_threshold) {
              desc += ` (${p.stock_quantity} left)`;
            }
            return { title: p.name, description: desc, postbackText: p.id };
          }),
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const { data: product } = await ctx.supabase
          .from('products')
          .select('id, name, price, stock_quantity, has_variants, image_url, variant_options')
          .eq('id', input)
          .eq('business_id', ctx.business!.id)
          .single();

        if (!product) return { valid: false, errorMessage: 'Please select a valid product.' };

        if (!product.has_variants && product.stock_quantity !== null && product.stock_quantity <= 0) {
          return { valid: false, errorMessage: `Sorry, ${product.name} is out of stock.` };
        }

        return {
          valid: true,
          data: {
            current_product_id: product.id,
            current_product_name: product.name,
            current_product_price: product.price,
            current_product_has_variants: product.has_variants,
            current_product_image_url: product.image_url || null,
            current_product_variant_options: product.variant_options || [],
            current_stock_quantity: product.has_variants ? null : product.stock_quantity,
          },
        };
      },
      async next(ctx: FlowContext) {
        const d = ctx.session.session_data;
        if (!d.current_product_has_variants) return 'select_quantity';

        const variantOptions = (d.current_product_variant_options as OptionGroup[]) || [];
        if (variantOptions.length >= 2 && variantOptions.every(g => g.name && g.values.length > 0)) {
          // Multi-axis: step through each option group
          d.current_option_axis_index = 0;
          d.current_selected_options = {};
          return 'select_option_axis';
        }
        // Single axis or legacy flat variants
        return 'select_variant';
      },
    },

    // ── Select Option Axis (multi-axis sequential selection) ──
    {
      id: 'select_option_axis',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        const variantOptions = (d.current_product_variant_options as OptionGroup[]) || [];
        const axisIndex = (d.current_option_axis_index as number) || 0;
        const axis = variantOptions[axisIndex];

        if (!axis) {
          return [{ type: 'text', text: 'Something went wrong. Send *Hi* to start again.' }];
        }

        const messages: PromptMessage[] = [];

        // On first axis, send product image
        if (axisIndex === 0 && d.current_product_image_url) {
          messages.push({
            type: 'image',
            imageUrl: d.current_product_image_url as string,
            caption: `${d.current_product_name}`,
          });
        }

        messages.push({
          type: 'list',
          title: `Choose ${axis.name}`,
          body: `Select *${axis.name}* for *${d.current_product_name}*:`,
          buttonLabel: `Choose ${axis.name}`,
          items: axis.values.map(val => ({
            title: val,
            description: '',
            postbackText: val,
          })),
        });

        return messages;
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const d = ctx.session.session_data;
        const variantOptions = (d.current_product_variant_options as OptionGroup[]) || [];
        const axisIndex = (d.current_option_axis_index as number) || 0;
        const axis = variantOptions[axisIndex];

        if (!axis) return { valid: false, errorMessage: 'Invalid option. Send *Hi* to start again.' };

        // Match input to a value (case-insensitive)
        const match = axis.values.find(v => v.toLowerCase() === input.toLowerCase());
        if (!match) {
          return { valid: false, errorMessage: `Please select a valid ${axis.name}.` };
        }

        // Store selected option
        const selectedOptions = (d.current_selected_options as Record<string, string>) || {};
        selectedOptions[axis.name] = match;

        return {
          valid: true,
          data: {
            current_selected_options: selectedOptions,
            current_option_axis_index: axisIndex + 1,
          },
        };
      },
      async next(ctx: FlowContext) {
        const d = ctx.session.session_data;
        const variantOptions = (d.current_product_variant_options as OptionGroup[]) || [];
        const axisIndex = (d.current_option_axis_index as number) || 0;

        // More axes remaining?
        if (axisIndex < variantOptions.length) {
          return 'select_option_axis';
        }

        // All axes done — find matching variant
        const selectedOptions = (d.current_selected_options as Record<string, string>) || {};
        const productId = d.current_product_id as string;

        const { data: variants } = await ctx.supabase
          .from('product_variants')
          .select('id, label, price, stock_quantity, image_url, options')
          .eq('product_id', productId)
          .eq('is_active', true);

        // Find variant whose options match all selected values
        const matchingVariant = (variants || []).find(v => {
          const opts = (v.options as Record<string, string>) || {};
          return Object.entries(selectedOptions).every(([key, val]) => opts[key] === val);
        });

        if (!matchingVariant) {
          return 'select_variant_error';
        }

        if (matchingVariant.stock_quantity !== null && matchingVariant.stock_quantity <= 0) {
          return 'select_variant_error';
        }

        // Store variant details
        d.current_variant_id = matchingVariant.id;
        d.current_variant_label = matchingVariant.label;
        d.current_product_price = matchingVariant.price;
        d.current_variant_image_url = matchingVariant.image_url || null;
        d.current_stock_quantity = matchingVariant.stock_quantity;

        return 'select_quantity';
      },
    },

    // ── Select Variant Error ──
    {
      id: 'select_variant_error',
      async prompt(): Promise<PromptMessage[]> {
        return [{
          type: 'text',
          text: 'Sorry, that combination is not available. Send *Hi* to start again.',
        }];
      },
      async validate(): Promise<ValidationResult> {
        return { valid: true };
      },
      async next() { return null; },
    },

    // ── Select Variant (single-axis / legacy flat) ──
    {
      id: 'select_variant',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        const productId = d.current_product_id as string;

        const { data: variants } = await ctx.supabase
          .from('product_variants')
          .select('id, label, price, stock_quantity, image_url')
          .eq('product_id', productId)
          .eq('is_active', true)
          .order('sort_order');

        const available = (variants || []).filter(v => v.stock_quantity === null || v.stock_quantity > 0);

        if (available.length === 0) {
          return [{ type: 'text', text: `Sorry, all options for *${d.current_product_name}* are out of stock.` }];
        }

        const messages: PromptMessage[] = [];

        // Send product image if available
        if (d.current_product_image_url) {
          messages.push({
            type: 'image',
            imageUrl: d.current_product_image_url as string,
            caption: `${d.current_product_name}`,
          });
        }

        const cc = (ctx.business?.country_code || 'NG') as CountryCode;
        messages.push({
          type: 'list',
          title: `${d.current_product_name}`,
          body: `Choose an option for *${d.current_product_name}*:`,
          buttonLabel: 'Select Option',
          items: available.map(v => ({
            title: v.label,
            description: formatCurrency(v.price, cc) + (v.stock_quantity !== null && v.stock_quantity <= 3 ? ` (${v.stock_quantity} left)` : ''),
            postbackText: v.id,
          })),
        });

        return messages;
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const { data: variant } = await ctx.supabase
          .from('product_variants')
          .select('id, label, price, stock_quantity, image_url')
          .eq('id', input)
          .single();

        if (!variant) return { valid: false, errorMessage: 'Please select a valid option.' };

        if (variant.stock_quantity !== null && variant.stock_quantity <= 0) {
          return { valid: false, errorMessage: `Sorry, ${variant.label} is out of stock.` };
        }

        return {
          valid: true,
          data: {
            current_variant_id: variant.id,
            current_variant_label: variant.label,
            current_product_price: variant.price,
            current_variant_image_url: variant.image_url || null,
            current_stock_quantity: variant.stock_quantity,
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
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;
        const variantInfo = d.current_variant_label ? ` (${d.current_variant_label})` : '';
        const productName = d.current_product_name as string;
        const stockQty = d.current_stock_quantity as number | null;

        // Calculate how many of this product/variant are already in cart
        const cart = (d.cart as CartItem[]) || [];
        const variantId = d.current_variant_id as string | undefined;
        const productId = d.current_product_id as string;
        const inCart = cart
          .filter(i => variantId ? i.variant_id === variantId : i.product_id === productId && !i.variant_id)
          .reduce((sum, i) => sum + i.quantity, 0);

        const available = stockQty !== null ? stockQty - inCart : null;

        const messages: PromptMessage[] = [];

        // Send variant image or product image
        const imageUrl = (d.current_variant_image_url as string) || (d.current_product_image_url as string);
        if (imageUrl) {
          messages.push({
            type: 'image',
            imageUrl,
            caption: `${productName}${variantInfo}`,
          });
        }

        let promptText = `*${productName}*${variantInfo} \u2014 ${formatCurrency(d.current_product_price as number, cc)}`;
        if (available !== null && available <= 5) {
          promptText += `\n\n_Only ${available} available_`;
        }
        promptText += '\n\nHow many would you like?';

        // Cap quick-select buttons to available stock
        const quickOptions = [1, 2, 3].filter(n => available === null || n <= available);

        messages.push({ type: 'text', text: promptText });

        if (quickOptions.length > 0) {
          messages.push({
            type: 'buttons',
            body: 'Select quantity:',
            buttons: quickOptions.map(n => ({ id: String(n), title: String(n) })),
          });
        }

        return messages;
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const qty = parseInt(input, 10);
        if (isNaN(qty) || qty < 1 || qty > 99) {
          return { valid: false, errorMessage: 'Please enter a number between 1 and 99.' };
        }

        const d = ctx.session.session_data;
        const stockQty = d.current_stock_quantity as number | null;

        if (stockQty !== null) {
          // Account for items already in cart for this product/variant
          const cart = (d.cart as CartItem[]) || [];
          const variantId = d.current_variant_id as string | undefined;
          const productId = d.current_product_id as string;
          const inCart = cart
            .filter(i => variantId ? i.variant_id === variantId : i.product_id === productId && !i.variant_id)
            .reduce((sum, i) => sum + i.quantity, 0);

          const available = stockQty - inCart;

          if (available <= 0) {
            return { valid: false, errorMessage: `Sorry, this item is already fully added to your cart.` };
          }

          if (qty > available) {
            return { valid: false, errorMessage: `Only ${available} available. Please enter ${available} or less.` };
          }
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

        const cartItem: CartItem = {
          product_id: d.current_product_id as string,
          name: d.current_product_name as string,
          quantity: d.current_quantity as number,
          price: d.current_product_price as number,
        };

        if (d.current_variant_id) {
          cartItem.variant_id = d.current_variant_id as string;
          cartItem.variant_label = d.current_variant_label as string;
        }

        cart.push(cartItem);

        // Clean up variant + multi-axis session data
        delete d.current_variant_id;
        delete d.current_variant_label;
        delete d.current_product_has_variants;
        delete d.current_product_image_url;
        delete d.current_variant_image_url;
        delete d.current_product_variant_options;
        delete d.current_option_axis_index;
        delete d.current_selected_options;
        delete d.current_stock_quantity;

        d.cart = cart;
        const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;

        await ctx.supabase
          .from('bot_sessions')
          .update({ session_data: d, current_step: 'continue_or_checkout' })
          .eq('id', ctx.session.id);

        const itemSummary = cart.map(i => {
          const label = i.variant_label ? `${i.name} (${i.variant_label})` : i.name;
          return `  \u2022 ${label} x${i.quantity} \u2014 ${formatCurrency(i.price * i.quantity, cc)}`;
        }).join('\n');

        return [
          {
            type: 'text',
            text: `\u2705 Added! Your cart:\n\n${itemSummary}\n\n*Total: ${formatCurrency(total, cc)}*`,
          },
          {
            type: 'buttons',
            body: 'What next?',
            buttons: [
              { id: 'checkout', title: 'Checkout \uD83D\uDCB3' },
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
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;
        return [{
          type: 'buttons',
          body: `Cart total: ${formatCurrency(total, cc)}\n\nCheckout or add more items?`,
          buttons: [
            { id: 'checkout', title: 'Checkout \uD83D\uDCB3' },
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
        return ctx.session.session_data._action === 'add_more' ? 'browse_catalog' : 'apply_promo';
      },
    },

    // ── Apply Promo Code ──
    {
      id: 'apply_promo',
      async prompt(): Promise<PromptMessage[]> {
        return [{
          type: 'buttons',
          body: 'Do you have a promo code?',
          buttons: [
            { id: 'enter_promo', title: 'Yes, enter code' },
            { id: 'skip_promo', title: 'No, continue' },
          ],
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        if (input.toLowerCase() === 'skip_promo' || input.toLowerCase() === 'no') {
          return { valid: true, data: { _promo_action: 'skip' } };
        }
        if (input.toLowerCase() === 'enter_promo' || input.toLowerCase() === 'yes') {
          return { valid: true, data: { _promo_action: 'enter' } };
        }
        // Direct code entry
        const code = input.trim().toUpperCase();
        if (code.length >= 3) {
          const { data: promo } = await ctx.supabase
            .from('promo_codes')
            .select('id, code, discount_type, discount_value, min_order_amount, max_uses, current_uses, valid_until, is_active')
            .eq('business_id', ctx.business!.id)
            .eq('code', code)
            .eq('is_active', true)
            .maybeSingle();

          if (!promo) return { valid: false, errorMessage: 'Invalid promo code. Try again or tap *No, continue*.' };
          if (promo.max_uses && promo.current_uses >= promo.max_uses) return { valid: false, errorMessage: 'This promo code has been fully redeemed.' };
          if (promo.valid_until && new Date(promo.valid_until) < new Date()) return { valid: false, errorMessage: 'This promo code has expired.' };

          const cart = (ctx.session.session_data.cart as CartItem[]) || [];
          const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
          if (promo.min_order_amount && total < promo.min_order_amount) {
            const cc = (ctx.business?.country_code || 'NG') as CountryCode;
            return { valid: false, errorMessage: `Minimum order of ${formatCurrency(promo.min_order_amount, cc)} required for this code.` };
          }

          const discount = promo.discount_type === 'percentage'
            ? Math.round(total * promo.discount_value / 100)
            : Math.min(promo.discount_value, total);

          return { valid: true, data: { promo_code_id: promo.id, discount_amount: discount, promo_code: code, _promo_action: 'applied' } };
        }
        return { valid: false, errorMessage: 'Please tap an option or enter a promo code.' };
      },
      async next(ctx: FlowContext) {
        return ctx.session.session_data._promo_action === 'enter' ? 'enter_promo_code' : 'delivery_details';
      },
    },

    // ── Enter Promo Code ──
    {
      id: 'enter_promo_code',
      async prompt(): Promise<PromptMessage[]> {
        return [{ type: 'text', text: 'Type your promo code:' }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const code = input.trim().toUpperCase();
        const { data: promo } = await ctx.supabase
          .from('promo_codes')
          .select('id, code, discount_type, discount_value, min_order_amount, max_uses, current_uses, valid_until, is_active')
          .eq('business_id', ctx.business!.id)
          .eq('code', code)
          .eq('is_active', true)
          .maybeSingle();

        if (!promo) return { valid: false, errorMessage: 'Invalid code. Check and try again:' };
        if (promo.max_uses && promo.current_uses >= promo.max_uses) return { valid: false, errorMessage: 'This code has been fully redeemed.' };
        if (promo.valid_until && new Date(promo.valid_until) < new Date()) return { valid: false, errorMessage: 'This code has expired.' };

        const cart = (ctx.session.session_data.cart as CartItem[]) || [];
        const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
        if (promo.min_order_amount && total < promo.min_order_amount) {
          const cc = (ctx.business?.country_code || 'NG') as CountryCode;
          return { valid: false, errorMessage: `Minimum order ${formatCurrency(promo.min_order_amount, cc)} required.` };
        }

        const discount = promo.discount_type === 'percentage'
          ? Math.round(total * promo.discount_value / 100)
          : Math.min(promo.discount_value, total);

        return { valid: true, data: { promo_code_id: promo.id, discount_amount: discount, promo_code: code } };
      },
      async next() { return 'delivery_details'; },
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
              { id: 'delivery', title: '\uD83D\uDE9A Delivery' },
              { id: 'pickup', title: '\uD83C\uDFEA Pickup' },
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
        return [{ type: 'text', text: '\uD83D\uDCCD Please type your delivery address:' }];
      },
      async validate(input: string): Promise<ValidationResult> {
        if (input.trim().length < 5) {
          return { valid: false, errorMessage: 'Please enter a valid address.' };
        }
        return { valid: true, data: { delivery_address: input.trim() } };
      },
      async next() { return 'confirm_address'; },
    },

    // ── Confirm Address ──
    {
      id: 'confirm_address',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const address = ctx.session.session_data.delivery_address as string;
        return [{
          type: 'buttons',
          body: `\uD83D\uDCCD Your delivery address:\n\n*${address}*\n\nIs this correct?`,
          buttons: [
            { id: 'yes', title: 'Yes, correct' },
            { id: 'change', title: 'Change address' },
          ],
        }];
      },
      async validate(input: string): Promise<ValidationResult> {
        const text = input.toLowerCase();
        if (text === 'yes' || text === 'yes, correct') {
          return { valid: true, data: { address_confirmed: true } };
        }
        if (text === 'change' || text === 'change address') {
          return { valid: true, data: { address_confirmed: false } };
        }
        return { valid: false, errorMessage: 'Please tap *Yes, correct* or *Change address*.' };
      },
      async next(ctx: FlowContext) {
        return ctx.session.session_data.address_confirmed ? 'collect_name' : 'collect_address';
      },
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
        const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
        const discount = (d.discount_amount as number) || 0;

        // Calculate shipping cost
        let shippingCost = 0;
        if (d.delivery_type === 'delivery' && ctx.business) {
          const shippingMode = (ctx.business.metadata?.shipping_mode as string) || 'none';
          const defaultFee = (ctx.business.metadata?.default_shipping_fee as number) || 0;

          if (shippingMode === 'flat') {
            shippingCost = defaultFee;
          } else {
            // Fetch per-product shipping costs (works for 'per_product' mode
            // AND auto-detects when products have shipping_cost even without explicit mode)
            const productIds = [...new Set(cart.map(i => i.product_id))];
            const { data: productsData } = await ctx.supabase
              .from('products')
              .select('id, shipping_cost')
              .in('id', productIds);

            const shippingMap: Record<string, number> = {};
            for (const p of productsData || []) {
              shippingMap[p.id] = p.shipping_cost ?? (shippingMode === 'per_product' ? defaultFee : 0);
            }

            for (const item of cart) {
              shippingCost += (shippingMap[item.product_id] || 0) * item.quantity;
            }
          }
        }

        const total = Math.max(0, subtotal - discount + shippingCost);

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
            discount_amount: discount,
            shipping_cost: shippingCost,
            promo_code_id: (d.promo_code_id as string) || null,
            channel: 'whatsapp',
            notes: d.delivery_type === 'pickup' ? 'Pickup order' : null,
          })
          .select('id, reference_code')
          .single();

        if (error || !order) {
          return [{ type: 'text', text: 'Something went wrong creating your order. Send *Hi* to try again.' }];
        }

        // Create order items and decrement stock
        for (const item of cart) {
          await ctx.supabase.from('order_items').insert({
            order_id: order.id,
            product_id: item.product_id,
            quantity: item.quantity,
            unit_price: item.price,
            variant_id: item.variant_id || null,
            variant_label: item.variant_label || null,
          });

          // Decrement stock: use variant stock if applicable, otherwise product stock
          if (item.variant_id) {
            await ctx.supabase.rpc('decrement_variant_stock', {
              p_variant_id: item.variant_id,
              qty: item.quantity,
            });
          } else {
            await ctx.supabase.rpc('decrement_stock', {
              p_product_id: item.product_id,
              qty: item.quantity,
            });
          }
        }

        d.order_id = order.id;
        d.reference_code = order.reference_code;
        d.total_amount = total;
        d.shipping_cost = shippingCost;

        // Increment promo code usage
        if (d.promo_code_id) {
          await ctx.supabase.rpc('increment_promo_usage', { p_code_id: d.promo_code_id as string });
        }

        // Upsert customer profile
        await ctx.supabase.rpc('upsert_customer_profile', {
          p_business_id: ctx.business!.id,
          p_phone: ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`,
          p_name: `${d.first_name || ''} ${d.last_name || ''}`.trim() || null,
          p_booking_amount: total,
          p_is_order: true,
        });

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
          // Initialize payment (uses correct gateway per country: Paystack, Stripe, Square, etc.)
          const cc = (ctx.business?.country_code || 'NG') as CountryCode;
          const paymentResult = await initializePayment(ctx.supabase, {
            orderId: order.id,
            userId,
            amount: total,
            referenceCode: order.reference_code,
            businessName: ctx.business?.name || 'Shop',
            phone: ctx.from,
            countryCode: cc,
            businessId: ctx.business?.id,
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
                  shippingCost: shippingCost || undefined,
                  countryCode: cc,
                }) + `\n\n\uD83D\uDCB3 Pay here \uD83D\uDC47\n${paymentResult.url}\n\n\u2757 After completing payment, *come back to this chat* and tap *I've Paid* to confirm your order.`,
              },
              {
                type: 'buttons',
                body: "\uD83D\uDD14 Completed payment? Return here and tap *I've Paid* to confirm:",
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

        // Post-completion: loyalty, feedback, referral
        if (ctx.business) {
          handlePostCompletion({
            supabase: ctx.supabase,
            businessId: ctx.business.id,
            customerPhone: ctx.from,
            customerName: `${d.first_name || ''} ${d.last_name || ''}`.trim() || null,
            serviceType: 'order',
            referenceId: order.id,
            sender: ctx.sender,
          }).catch(err => console.error('[ORDERING] Post-completion error:', err));
        }

        return [{
          type: 'text',
          text: getOrderConfirmationMessage({
            businessName: ctx.business?.name || 'Shop',
            items: cart,
            totalAmount: total,
            referenceCode: order.reference_code,
            deliveryAddress: d.delivery_address as string | undefined,
            shippingCost: shippingCost || undefined,
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
          body: "Complete payment using the link above, then *come back here* and tap *I've Paid* to confirm your order:",
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
          await ctx.sender.sendText({ to: ctx.from, text: 'Order cancelled. Send *Hi* to start again.' });
          return { valid: true, data: { _action: 'cancel' } };
        }

        if (text === 'i_paid' || text === 'paid' || text === 'done') {
          const ref = ctx.session.session_data.payment_reference as string;
          if (!ref) return { valid: true, data: { _action: 'cancel' } };

          const cc = (ctx.business?.country_code || 'NG') as CountryCode;
          const verified = await verifyPayment(ctx.supabase, ref, cc);
          if (verified) {
            await ctx.sender.sendText({
              to: ctx.from,
              text: `\u2705 *Payment Confirmed!*\n\nYour order *${ctx.session.session_data.reference_code}* has been confirmed.\n\nThank you! \uD83C\uDF89`,
            });

            // Post-completion: loyalty, feedback, referral
            if (ctx.business) {
              const sd = ctx.session.session_data;
              handlePostCompletion({
                supabase: ctx.supabase,
                businessId: ctx.business.id,
                customerPhone: ctx.from,
                customerName: `${sd.first_name || ''} ${sd.last_name || ''}`.trim() || null,
                serviceType: 'order',
                referenceId: sd.order_id as string,
                sender: ctx.sender,
              }).catch(err => console.error('[ORDERING] Post-completion error:', err));
            }

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

import type { FlowDefinition, FlowContext, PromptMessage, ValidationResult } from './types';
import { createWhatsAppUser, findUserByPhone } from './shared/user';
import { initializePayment, verifyPayment, recordPlatformFee } from './shared/payment';
import { getOrderConfirmationMessage } from './shared/templates';
import { handlePostCompletion } from './shared/post-completion';
import { notifyOwnerNewOrder, notifyOwnerNewQuoteRequest } from './shared/notify-owner';
import { evaluateRules } from '@/lib/bot/automation/rules-engine';
import { triggerSequences } from '@/lib/bot/automation/sequence-service';
import { formatCurrency, type CountryCode, type SubscriptionTier } from '@/lib/constants';
import { logger } from '@/lib/logger';

/** Generic labels for ordering flow */
function getOrderingLabels(_category: string): { noun: string; emoji: string; browseLabel: string } {
  return { noun: 'catalog', emoji: '\uD83D\uDECD\uFE0F', browseLabel: 'Browse' };
}

/** WhatsApp list row titles max 24 chars, descriptions max 72 chars */
function truncTitle(s: string, max = 24): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '\u2026';
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
  addons?: Array<{ name: string; price: number; quantity?: number }>;
}

interface AddonRecord {
  id: string;
  name: string;
  price: number;
  price_type: 'fixed' | 'per_unit' | 'quote';
  unit_label: string | null;
  min_quantity: number | null;
  max_quantity: number | null;
  is_required: boolean;
  is_negotiable: boolean;
}

/** Calculate cart total including addons */
function calculateCartTotal(cart: CartItem[]): number {
  let total = 0;
  for (const item of cart) {
    total += item.price * item.quantity;
    if (item.addons) {
      for (const a of item.addons) {
        total += a.price * (a.quantity || 1);
      }
    }
  }
  return total;
}

/** Route to the correct step after a product is selected */
function routeAfterProductSelection(d: Record<string, unknown>): string {
  if (!d.current_product_has_variants) return 'select_quantity';
  const variantOptions = (d.current_product_variant_options as OptionGroup[]) || [];
  if (variantOptions.length >= 2 && variantOptions.every(g => g.name && g.values.length > 0)) {
    d.current_option_axis_index = 0;
    d.current_selected_options = {};
    return 'select_option_axis';
  }
  return 'select_variant';
}

export const orderingFlow: FlowDefinition = {
  type: 'ordering',
  steps: [
    // ── Browse Catalog ──
    {
      id: 'browse_catalog',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        if (!ctx.business) return [{ type: 'text', text: 'Business not found.' }];

        const meta = (ctx.business.metadata || {}) as Record<string, unknown>;
        const browseByCategory = (meta.ordering_browse_by_category as boolean) || false;

        const { data: rawProducts } = await ctx.supabase
          .from('products')
          .select('id, name, price, category, stock_quantity, track_inventory, low_stock_threshold, has_variants, image_url, variant_options, min_order_qty')
          .eq('business_id', ctx.business.id)
          .eq('is_active', true)
          .is('deleted_at', null)
          .order('sort_order')
          .limit(100);

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

        const formatItem = (p: typeof products[0]) => {
          let desc = p.has_variants ? 'Multiple options' : formatCurrency(p.price, cc);
          if (!p.has_variants && p.track_inventory && p.stock_quantity !== null && p.low_stock_threshold && p.stock_quantity <= p.low_stock_threshold) {
            desc += ` (${p.stock_quantity} left)`;
          }
          return { title: truncTitle(p.name), description: desc, postbackText: p.id };
        };

        // Group products by category
        const categoryMap = new Map<string, typeof products>();
        for (const p of products) {
          const cat = p.category || 'Menu';
          if (!categoryMap.has(cat)) categoryMap.set(cat, []);
          categoryMap.get(cat)!.push(p);
        }
        const categories = Array.from(categoryMap.entries());

        // Browse-by-category mode: show category list first
        if (browseByCategory && categories.length > 1) {
          ctx.session.session_data._category_list = categories.map(([cat, items]) => cat);
          return [{
            type: 'list',
            title: 'Categories',
            body: `Welcome to ${ctx.business.name}! ${labels.emoji}\n\nChoose a category to browse:`,
            buttonLabel: 'View Categories',
            items: categories.slice(0, 10).map(([cat, items]) => ({
              title: truncTitle(cat),
              description: `${items.length} item${items.length !== 1 ? 's' : ''}`,
              postbackText: `cat:${cat}`,
            })),
          }];
        }

        // All-at-once mode: show products with sections
        const needsSections = categories.length > 1 && products.length > 10;

        if (needsSections) {
          const sections = categories.slice(0, 10).map(([cat, items]) => ({
            title: truncTitle(cat),
            items: items.slice(0, 10).map(formatItem),
          }));

          return [{
            type: 'list' as const,
            title: `Our ${labels.noun.charAt(0).toUpperCase() + labels.noun.slice(1)}`,
            body: `Welcome to ${ctx.business.name}! ${labels.emoji}\n\nBrowse our ${labels.noun}:`,
            buttonLabel: labels.browseLabel,
            items: products.slice(0, 10).map(formatItem),
            sections,
          }];
        }

        return [{
          type: 'list',
          title: `Our ${labels.noun.charAt(0).toUpperCase() + labels.noun.slice(1)}`,
          body: `Welcome to ${ctx.business.name}! ${labels.emoji}\n\nBrowse our ${labels.noun}:`,
          buttonLabel: labels.browseLabel,
          items: products.slice(0, 10).map(formatItem),
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        // Handle category selection in browse-by-category mode
        if (input.startsWith('cat:')) {
          const selectedCat = input.slice(4);
          return { valid: true, data: { _selected_category: selectedCat } };
        }

        const { data: product } = await ctx.supabase
          .from('products')
          .select('id, name, price, stock_quantity, has_variants, image_url, variant_options, min_order_qty')
          .eq('id', input)
          .eq('business_id', ctx.business!.id)
          .is('deleted_at', null)
          .single();

        if (!product) return { valid: false, errorMessage: 'Please select a valid option.' };

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
            current_min_order_qty: product.min_order_qty || 1,
          },
        };
      },
      async next(ctx: FlowContext) {
        const d = ctx.session.session_data;

        // Category selected → show products in that category
        if (d._selected_category) {
          return 'browse_category_items';
        }

        const meta = (ctx.business?.metadata || {}) as Record<string, unknown>;
        const quickAdd = meta.ordering_quick_add !== false;

        // Quick-add: simple products (no variants) with no required addons
        if (quickAdd && !d.current_product_has_variants) {
          const minQty = (d.current_min_order_qty as number) || 1;
          if (minQty <= 1) {
            const productId = d.current_product_id as string;
            const { data: requiredAddons } = await ctx.supabase
              .from('product_addons')
              .select('id')
              .eq('product_id', productId)
              .eq('is_active', true)
              .eq('is_required', true)
              .limit(1);

            if (!requiredAddons || requiredAddons.length === 0) {
              d.current_quantity = 1;
              d.current_addons = [];
              d._addon_action = 'skip';
              return 'add_to_cart';
            }
          }
        }

        return routeAfterProductSelection(d);
      },
    },

    // ── Browse Category Items (shows products within a selected category) ──
    {
      id: 'browse_category_items',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        const selectedCat = d._selected_category as string;
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;

        const { data: rawProducts } = await ctx.supabase
          .from('products')
          .select('id, name, price, category, stock_quantity, track_inventory, low_stock_threshold, has_variants')
          .eq('business_id', ctx.business!.id)
          .eq('is_active', true)
          .eq('category', selectedCat)
          .is('deleted_at', null)
          .order('sort_order')
          .limit(10);

        const products = (rawProducts || []).filter(p =>
          !p.track_inventory || (p.stock_quantity !== null && p.stock_quantity > 0)
        );

        if (!products || products.length === 0) {
          delete d._selected_category;
          return [{ type: 'text', text: `Nothing available in ${selectedCat} right now. Send *Hi* to start over.` }];
        }

        const items = [
          { title: '\u2B05 Back to Categories', description: 'Browse other categories', postbackText: 'back_to_categories' },
          ...products.map(p => {
            let desc = p.has_variants ? 'Multiple options' : formatCurrency(p.price, cc);
            if (!p.has_variants && p.track_inventory && p.stock_quantity !== null && p.low_stock_threshold && p.stock_quantity <= p.low_stock_threshold) {
              desc += ` (${p.stock_quantity} left)`;
            }
            return { title: truncTitle(p.name), description: desc, postbackText: p.id };
          }),
        ];

        const cart = (d.cart as CartItem[]) || [];
        const cartInfo = cart.length > 0
          ? `\n\n\uD83D\uDED2 Cart: ${cart.length} item${cart.length !== 1 ? 's' : ''} \u2014 ${formatCurrency(calculateCartTotal(cart), cc)}`
          : '';

        return [{
          type: 'list',
          title: truncTitle(selectedCat),
          body: `*${selectedCat}*${cartInfo}\n\nSelect an item:`,
          buttonLabel: 'View Items',
          items: items.slice(0, 10),
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        if (input === 'back_to_categories') {
          delete ctx.session.session_data._selected_category;
          return { valid: true, data: { _back_to_categories: true } };
        }

        const { data: product } = await ctx.supabase
          .from('products')
          .select('id, name, price, stock_quantity, has_variants, image_url, variant_options, min_order_qty')
          .eq('id', input)
          .eq('business_id', ctx.business!.id)
          .is('deleted_at', null)
          .single();

        if (!product) return { valid: false, errorMessage: 'Please select a valid item.' };

        if (!product.has_variants && product.stock_quantity !== null && product.stock_quantity <= 0) {
          return { valid: false, errorMessage: `Sorry, ${product.name} is out of stock.` };
        }

        delete ctx.session.session_data._selected_category;

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
            current_min_order_qty: product.min_order_qty || 1,
          },
        };
      },
      async next(ctx: FlowContext) {
        const d = ctx.session.session_data;

        if (d._back_to_categories) {
          delete d._back_to_categories;
          return 'browse_catalog';
        }

        const meta = (ctx.business?.metadata || {}) as Record<string, unknown>;
        const quickAdd = meta.ordering_quick_add !== false;

        // Quick-add for simple products
        if (quickAdd && !d.current_product_has_variants) {
          const minQty = (d.current_min_order_qty as number) || 1;
          if (minQty <= 1) {
            const productId = d.current_product_id as string;
            const { data: requiredAddons } = await ctx.supabase
              .from('product_addons')
              .select('id')
              .eq('product_id', productId)
              .eq('is_active', true)
              .eq('is_required', true)
              .limit(1);

            if (!requiredAddons || requiredAddons.length === 0) {
              d.current_quantity = 1;
              d.current_addons = [];
              d._addon_action = 'skip';
              return 'add_to_cart';
            }
          }
        }

        return routeAfterProductSelection(d);
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
          title: truncTitle(`Choose ${axis.name}`),
          body: `Select *${axis.name}* for *${d.current_product_name}*:`,
          buttonLabel: truncTitle(`Choose ${axis.name}`, 20),
          items: axis.values.map(val => ({
            title: truncTitle(val),
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
          title: truncTitle(d.current_product_name as string),
          body: `Choose an option for *${d.current_product_name}*:`,
          buttonLabel: 'Select Option',
          items: available.map(v => ({
            title: truncTitle(v.label),
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

        const minQty = (d.current_min_order_qty as number) || 1;
        let promptText = `*${productName}*${variantInfo} \u2014 ${formatCurrency(d.current_product_price as number, cc)}`;
        if (available !== null && available <= 5) {
          promptText += `\n\n_Only ${available} available_`;
        }
        if (minQty > 1) {
          promptText += `\n\n_Minimum order: ${minQty} units_`;
        }
        promptText += '\n\nHow many would you like? Type a number:';

        messages.push({ type: 'text', text: promptText });

        return messages;
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const qty = parseInt(input, 10);
        if (isNaN(qty) || qty < 1 || qty > 9999) {
          return { valid: false, errorMessage: 'Please enter a valid number.' };
        }

        const d = ctx.session.session_data;
        const minQty = (d.current_min_order_qty as number) || 1;
        if (qty < minQty) {
          return { valid: false, errorMessage: `Minimum order for this product is ${minQty} units. Please enter ${minQty} or more.` };
        }

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
      async next() { return 'select_addons'; },
    },

    // ── Select Add-ons ──
    {
      id: 'select_addons',
      async skipIf(ctx: FlowContext) {
        if (!ctx.business) {
          ctx.session.session_data._addon_action = 'skip';
          return true;
        }
        const productId = ctx.session.session_data.current_product_id as string;
        const { data: addons } = await ctx.supabase
          .from('product_addons')
          .select('id')
          .eq('product_id', productId)
          .eq('is_active', true)
          .limit(1);
        if (!addons || addons.length === 0) {
          ctx.session.session_data.current_addons = [];
          ctx.session.session_data._addon_action = 'skip';
          return true;
        }
        if (!ctx.session.session_data.current_addons) {
          ctx.session.session_data.current_addons = [];
        }
        return false;
      },
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        const productId = d.current_product_id as string;
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;

        const { data: addons } = await ctx.supabase
          .from('product_addons')
          .select('id, name, price, price_type, unit_label, is_required, is_negotiable')
          .eq('product_id', productId)
          .eq('is_active', true)
          .order('sort_order')
          .limit(9);

        if (!addons || addons.length === 0) {
          return [{ type: 'text', text: 'No add-ons available.' }];
        }

        // Filter out already-selected addons
        const selected = (d.current_addons as Array<{ name: string }>) || [];
        const selectedNames = new Set(selected.map(a => a.name));
        const available = addons.filter(a => !selectedNames.has(a.name));

        if (available.length === 0) {
          return [{
            type: 'buttons',
            body: 'All available add-ons selected. Continue?',
            buttons: [{ id: 'skip_addons', title: 'Continue' }],
          }];
        }

        const items = available.map(a => {
          let desc = a.price_type === 'quote' ? 'Get a quote' : formatCurrency(a.price, cc);
          if (a.price_type === 'per_unit' && a.unit_label) desc += ` ${a.unit_label}`;
          if (a.is_required) desc += ' (Required)';
          return { title: truncTitle(a.name), description: desc, postbackText: a.id };
        });

        // Add "No add-ons" option (if no required addons remain)
        const hasRequired = available.some(a => a.is_required);
        if (!hasRequired) {
          items.push({ title: 'No add-ons', description: 'Continue without', postbackText: 'skip_addons' });
        }

        return [{
          type: 'list',
          title: 'Add-ons',
          body: `Would you like to add extras to *${d.current_product_name}*?`,
          buttonLabel: 'View Add-ons',
          items: items.slice(0, 10),
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        if (input === 'skip_addons') {
          return { valid: true, data: { _addon_action: 'skip' } };
        }

        const { data: addon } = await ctx.supabase
          .from('product_addons')
          .select('id, name, price, price_type, unit_label, min_quantity, max_quantity, is_negotiable')
          .eq('id', input)
          .single();

        if (!addon) return { valid: false, errorMessage: 'Please select a valid add-on or tap *No add-ons*.' };

        return {
          valid: true,
          data: {
            _addon_action: 'selected',
            _selected_addon: addon,
          },
        };
      },
      async next(ctx: FlowContext) {
        const d = ctx.session.session_data;
        if (d._addon_action === 'skip') return 'add_to_cart';

        const addon = d._selected_addon as AddonRecord;
        if (addon.price_type === 'per_unit') {
          return 'select_addon_quantity';
        }

        // Fixed price or quote — add directly
        const addons = (d.current_addons as Array<{ name: string; price: number; quantity?: number }>) || [];
        addons.push({ name: addon.name, price: addon.price, quantity: 1 });
        d.current_addons = addons;
        d._has_negotiable_addon = d._has_negotiable_addon || addon.is_negotiable;
        delete d._selected_addon;
        delete d._addon_action;

        return 'addon_continue';
      },
    },

    // ── Select Addon Quantity ──
    {
      id: 'select_addon_quantity',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const addon = ctx.session.session_data._selected_addon as AddonRecord;
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;
        let text = `How many *${addon.name}* @ ${formatCurrency(addon.price, cc)}`;
        if (addon.unit_label) text += ` ${addon.unit_label}`;
        text += '?';
        if (addon.min_quantity) text += `\n_Minimum: ${addon.min_quantity}_`;
        if (addon.max_quantity) text += `\n_Maximum: ${addon.max_quantity}_`;
        return [{ type: 'text', text }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const qty = parseInt(input, 10);
        if (isNaN(qty) || qty < 1) return { valid: false, errorMessage: 'Please enter a valid number.' };

        const addon = ctx.session.session_data._selected_addon as AddonRecord;
        if (addon.min_quantity && qty < addon.min_quantity) {
          return { valid: false, errorMessage: `Minimum quantity is ${addon.min_quantity}.` };
        }
        if (addon.max_quantity && qty > addon.max_quantity) {
          return { valid: false, errorMessage: `Maximum quantity is ${addon.max_quantity}.` };
        }

        const d = ctx.session.session_data;
        const addons = (d.current_addons as Array<{ name: string; price: number; quantity?: number }>) || [];
        addons.push({ name: addon.name, price: addon.price, quantity: qty });
        d.current_addons = addons;
        d._has_negotiable_addon = d._has_negotiable_addon || addon.is_negotiable;
        delete d._selected_addon;
        delete d._addon_action;

        return { valid: true };
      },
      async next() { return 'addon_continue'; },
    },

    // ── Addon Continue (add more or proceed) ──
    {
      id: 'addon_continue',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        const addons = (d.current_addons as Array<{ name: string; price: number; quantity?: number }>) || [];
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;
        const lastAddon = addons[addons.length - 1];
        const addonCost = lastAddon ? formatCurrency(lastAddon.price * (lastAddon.quantity || 1), cc) : '';
        return [{
          type: 'buttons',
          body: `\u2705 Added: ${lastAddon?.name} (${addonCost})\n\nAdd another extra?`,
          buttons: [
            { id: 'more_addons', title: 'Add more' },
            { id: 'done_addons', title: 'Continue' },
          ],
        }];
      },
      async validate(input: string): Promise<ValidationResult> {
        if (input === 'more_addons') return { valid: true, data: { _addon_continue: 'more' } };
        if (input === 'done_addons') return { valid: true, data: { _addon_continue: 'done' } };
        return { valid: false, errorMessage: 'Please tap *Add more* or *Continue*.' };
      },
      async next(ctx: FlowContext) {
        return ctx.session.session_data._addon_continue === 'more' ? 'select_addons' : 'add_to_cart';
      },
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

        // Attach addons to cart item
        const currentAddons = (d.current_addons as Array<{ name: string; price: number; quantity?: number }>) || [];
        if (currentAddons.length > 0) {
          cartItem.addons = currentAddons;
        }

        cart.push(cartItem);

        // Clean up variant + multi-axis + addon session data
        delete d.current_variant_id;
        delete d.current_variant_label;
        delete d.current_product_has_variants;
        delete d.current_product_image_url;
        delete d.current_variant_image_url;
        delete d.current_product_variant_options;
        delete d.current_option_axis_index;
        delete d.current_selected_options;
        delete d.current_stock_quantity;
        delete d.current_addons;
        delete d._addon_action;
        delete d._addon_continue;
        delete d._selected_addon;

        d.cart = cart;
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;
        const total = calculateCartTotal(cart);
        const variantInfo = cartItem.variant_label ? ` (${cartItem.variant_label})` : '';
        const addedText = `\u2705 *${cartItem.name}*${variantInfo} x${cartItem.quantity} added!\n\n\uD83D\uDED2 Cart: ${cart.length} item${cart.length !== 1 ? 's' : ''} \u2014 *${formatCurrency(total, cc)}*`;

        const meta = (ctx.business?.metadata || {}) as Record<string, unknown>;
        const browseByCategory = (meta.ordering_browse_by_category as boolean) || false;

        // Browse-by-category mode: single buttons message to keep the category flow
        if (browseByCategory) {
          await ctx.supabase
            .from('bot_sessions')
            .update({ session_data: d, current_step: 'continue_or_checkout' })
            .eq('id', ctx.session.id);

          return [{
            type: 'buttons' as const,
            body: addedText + '\n\nWhat would you like to do?',
            buttons: [
              { id: 'browse_more', title: 'Browse Menu' },
              { id: 'checkout', title: 'Checkout' },
            ],
          }];
        }

        // All-at-once mode: show integrated catalog+checkout list
        const { data: rawProducts } = await ctx.supabase
          .from('products')
          .select('id, name, price, category, has_variants, track_inventory, stock_quantity')
          .eq('business_id', ctx.business!.id)
          .eq('is_active', true)
          .is('deleted_at', null)
          .order('sort_order')
          .limit(100);

        const products = (rawProducts || []).filter(p =>
          !p.track_inventory || (p.stock_quantity !== null && p.stock_quantity > 0)
        );

        const checkoutItem = { title: 'Checkout \u2705', description: `Total: ${formatCurrency(total, cc)}`, postbackText: 'checkout' };

        await ctx.supabase
          .from('bot_sessions')
          .update({ session_data: d, current_step: 'continue_or_checkout' })
          .eq('id', ctx.session.id);

        // Group by category into sections
        const catMap = new Map<string, typeof products>();
        for (const p of products) {
          const cat = p.category || 'Menu';
          if (!catMap.has(cat)) catMap.set(cat, []);
          catMap.get(cat)!.push(p);
        }
        const cats = Array.from(catMap.entries());
        const useSections = cats.length > 1 && products.length > 9;

        const formatProd = (p: typeof products[0]) => ({
          title: truncTitle(p.name),
          description: p.has_variants ? 'Multiple options' : formatCurrency(p.price, cc),
          postbackText: p.id,
        });

        if (useSections) {
          const sections = [
            { title: 'Your Order', items: [checkoutItem] },
            ...cats.slice(0, 9).map(([cat, items]) => ({
              title: truncTitle(cat),
              items: items.slice(0, 10).map(formatProd),
            })),
          ];

          return [
            { type: 'text' as const, text: addedText },
            {
              type: 'list' as const,
              title: 'Continue',
              body: 'Add more items or checkout:',
              buttonLabel: 'View Options',
              items: [checkoutItem, ...products.slice(0, 9).map(formatProd)],
              sections,
            },
          ];
        }

        const listItems = [
          checkoutItem,
          ...products.slice(0, 9).map(formatProd),
        ];

        return [
          { type: 'text' as const, text: addedText },
          {
            type: 'list' as const,
            title: 'Continue',
            body: 'Add more items or checkout:',
            buttonLabel: 'View Options',
            items: listItems.slice(0, 10),
          },
        ];
      },
      async validate(): Promise<ValidationResult> { return { valid: true }; },
      async next() { return null; },
    },

    // ── Continue or Checkout (handles product selection + checkout) ──
    {
      id: 'continue_or_checkout',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        const cart = (d.cart as CartItem[]) || [];
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;
        const total = calculateCartTotal(cart);

        // Browse-by-category mode: simple buttons
        const meta = (ctx.business?.metadata || {}) as Record<string, unknown>;
        const browseByCategory = (meta.ordering_browse_by_category as boolean) || false;

        if (browseByCategory) {
          return [{
            type: 'buttons' as const,
            body: `\uD83D\uDED2 ${cart.length} item${cart.length !== 1 ? 's' : ''} in cart \u2014 *${formatCurrency(total, cc)}*\n\nAdd more items or checkout:`,
            buttons: [
              { id: 'browse_more', title: 'Browse Menu' },
              { id: 'checkout', title: 'Checkout' },
            ],
          }];
        }

        // All-at-once mode: product list
        const { data: rawProducts } = await ctx.supabase
          .from('products')
          .select('id, name, price, category, has_variants, track_inventory, stock_quantity')
          .eq('business_id', ctx.business!.id)
          .eq('is_active', true)
          .is('deleted_at', null)
          .order('sort_order')
          .limit(100);

        const products = (rawProducts || []).filter(p =>
          !p.track_inventory || (p.stock_quantity !== null && p.stock_quantity > 0)
        );

        const checkoutItem = { title: 'Checkout \u2705', description: `Total: ${formatCurrency(total, cc)}`, postbackText: 'checkout' };

        // Group by category into sections
        const categoryMap = new Map<string, typeof products>();
        for (const p of products) {
          const cat = p.category || 'Menu';
          if (!categoryMap.has(cat)) categoryMap.set(cat, []);
          categoryMap.get(cat)!.push(p);
        }

        const categories = Array.from(categoryMap.entries());
        const needsSections = categories.length > 1 && products.length > 9;

        if (needsSections) {
          const sections = [
            { title: 'Your Order', items: [checkoutItem] },
            ...categories.slice(0, 9).map(([cat, items]) => ({
              title: truncTitle(cat),
              items: items.slice(0, 10).map(p => ({
                title: truncTitle(p.name),
                description: p.has_variants ? 'Multiple options' : formatCurrency(p.price, cc),
                postbackText: p.id,
              })),
            })),
          ];

          return [{
            type: 'list' as const,
            title: 'Your Cart',
            body: `\uD83D\uDED2 ${cart.length} item${cart.length !== 1 ? 's' : ''} in cart \u2014 ${formatCurrency(total, cc)}\n\nAdd more items or checkout:`,
            buttonLabel: 'View Options',
            items: [checkoutItem, ...products.slice(0, 9).map(p => ({
              title: truncTitle(p.name),
              description: p.has_variants ? 'Multiple options' : formatCurrency(p.price, cc),
              postbackText: p.id,
            }))],
            sections,
          }];
        }

        const listItems = [
          checkoutItem,
          ...products.slice(0, 9).map(p => ({
            title: truncTitle(p.name),
            description: p.has_variants ? 'Multiple options' : formatCurrency(p.price, cc),
            postbackText: p.id,
          })),
        ];

        return [{
          type: 'list',
          title: 'Your Cart',
          body: `\uD83D\uDED2 ${cart.length} item${cart.length !== 1 ? 's' : ''} in cart \u2014 ${formatCurrency(total, cc)}\n\nAdd more items or checkout:`,
          buttonLabel: 'View Options',
          items: listItems.slice(0, 10),
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        if (input.toLowerCase() === 'checkout') {
          return { valid: true, data: { _action: 'checkout' } };
        }
        if (input === 'browse_more') {
          return { valid: true, data: { _action: 'browse_more' } };
        }

        // Treat as product selection
        const { data: product } = await ctx.supabase
          .from('products')
          .select('id, name, price, stock_quantity, has_variants, image_url, variant_options, min_order_qty')
          .eq('id', input)
          .eq('business_id', ctx.business!.id)
          .is('deleted_at', null)
          .single();

        if (!product) return { valid: false, errorMessage: 'Please select an option from the list.' };

        if (!product.has_variants && product.stock_quantity !== null && product.stock_quantity <= 0) {
          return { valid: false, errorMessage: `Sorry, ${product.name} is out of stock.` };
        }

        return {
          valid: true,
          data: {
            _action: 'add_more',
            current_product_id: product.id,
            current_product_name: product.name,
            current_product_price: product.price,
            current_product_has_variants: product.has_variants,
            current_product_image_url: product.image_url || null,
            current_product_variant_options: product.variant_options || [],
            current_stock_quantity: product.has_variants ? null : product.stock_quantity,
            current_min_order_qty: product.min_order_qty || 1,
          },
        };
      },
      async next(ctx: FlowContext) {
        const d = ctx.session.session_data;
        if (d._action === 'checkout') return 'apply_promo';
        if (d._action === 'browse_more') return 'browse_catalog';

        const meta = (ctx.business?.metadata || {}) as Record<string, unknown>;
        const quickAdd = meta.ordering_quick_add !== false;

        // Quick-add: simple products with no variants and no required addons
        if (quickAdd && !d.current_product_has_variants) {
          const minQty = (d.current_min_order_qty as number) || 1;
          if (minQty <= 1) {
            const productId = d.current_product_id as string;
            const { data: requiredAddons } = await ctx.supabase
              .from('product_addons')
              .select('id')
              .eq('product_id', productId)
              .eq('is_active', true)
              .eq('is_required', true)
              .limit(1);

            if (!requiredAddons || requiredAddons.length === 0) {
              d.current_quantity = 1;
              d.current_addons = [];
              d._addon_action = 'skip';
              return 'add_to_cart';
            }
          }
        }

        return routeAfterProductSelection(d);
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
        return ctx.session.session_data._promo_action === 'enter' ? 'enter_promo_code' : 'select_delivery_zone';
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
      async next() { return 'select_delivery_zone'; },
    },

    // ── Select Delivery Zone ──
    {
      id: 'select_delivery_zone',
      async skipIf(ctx: FlowContext) {
        if (!ctx.business) return true;
        const { data: zones } = await ctx.supabase
          .from('delivery_zones')
          .select('id')
          .eq('business_id', ctx.business.id)
          .eq('is_active', true)
          .limit(1);
        // No zones configured → fall through to regular delivery_details
        return !zones || zones.length === 0;
      },
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const { data: zones } = await ctx.supabase
          .from('delivery_zones')
          .select('id, name, price, estimated_time, is_pickup, is_negotiable')
          .eq('business_id', ctx.business!.id)
          .eq('is_active', true)
          .order('sort_order')
          .limit(10);

        if (!zones || zones.length === 0) {
          return [{ type: 'text', text: 'No delivery zones available.' }];
        }

        const cc = (ctx.business?.country_code || 'NG') as CountryCode;
        return [{
          type: 'list',
          title: 'Delivery Zone',
          body: 'Select your delivery zone:',
          buttonLabel: 'Choose Zone',
          items: zones.map(z => {
            let desc = z.is_pickup ? 'Pickup' : z.price > 0 ? formatCurrency(z.price, cc) : 'FREE';
            if (z.estimated_time) desc += ` \u2022 ${z.estimated_time}`;
            if (z.is_negotiable) desc += ' (Negotiable)';
            return { title: z.name, description: desc, postbackText: z.id };
          }),
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const { data: zone } = await ctx.supabase
          .from('delivery_zones')
          .select('id, name, price, is_pickup, is_negotiable')
          .eq('id', input)
          .single();

        if (!zone) return { valid: false, errorMessage: 'Please select a valid delivery zone.' };

        return {
          valid: true,
          data: {
            delivery_zone_id: zone.id,
            delivery_zone_name: zone.name,
            delivery_zone_price: zone.price,
            delivery_type: zone.is_pickup ? 'pickup' : 'delivery',
            _zone_is_negotiable: zone.is_negotiable,
          },
        };
      },
      async next(ctx: FlowContext) {
        const d = ctx.session.session_data;
        // If skipped (no zones), fall through to regular delivery_details
        if (!d.delivery_zone_id) return 'delivery_details';
        if (d._zone_is_negotiable) {
          d._has_negotiable_addon = true;
        }
        return d.delivery_type === 'pickup' ? 'collect_name' : 'collect_address';
      },
    },

    // ── Delivery Details (fallback when no zones configured) ──
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
      async next() { return 'collect_email'; },
    },

    // ── Collect Email ──
    {
      id: 'collect_email',
      async prompt(): Promise<PromptMessage[]> {
        return [{ type: 'text', text: '\uD83D\uDCE7 Please type your email address:' }];
      },
      async validate(input: string): Promise<ValidationResult> {
        const email = input.trim().toLowerCase();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
          return { valid: false, errorMessage: 'Please enter a valid email address.' };
        }
        return { valid: true, data: { customer_email: email } };
      },
      async next() { return 'review_order_summary'; },
    },

    // ── Review Order Summary ──
    {
      id: 'review_order_summary',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        const cart = (d.cart as CartItem[]) || [];
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;

        // Calculate subtotal
        let subtotal = 0;
        let addonsTotal = 0;
        const lines: string[] = [];

        for (const item of cart) {
          const label = item.variant_label ? `${item.name} (${item.variant_label})` : item.name;
          const itemTotal = item.price * item.quantity;
          subtotal += itemTotal;
          lines.push(`\u2022 ${label} x${item.quantity} \u2014 ${formatCurrency(itemTotal, cc)}`);
          if (item.addons && item.addons.length > 0) {
            for (const a of item.addons) {
              const addonCost = a.price * (a.quantity || 1);
              addonsTotal += addonCost;
              lines.push(`  + ${a.name}: ${formatCurrency(addonCost, cc)}`);
            }
          }
        }

        // Calculate volume discounts
        let volumeDiscountTotal = 0;
        if (ctx.business) {
          for (const item of cart) {
            try {
              const { data: discountResult } = await ctx.supabase.rpc('calculate_volume_discount', {
                p_business_id: ctx.business.id,
                p_product_id: item.product_id,
                p_quantity: item.quantity,
                p_unit_price: item.price,
              });
              if (discountResult && discountResult > 0) {
                volumeDiscountTotal += discountResult;
              }
            } catch {
              // Volume discount calculation failed — continue without
            }
          }
        }

        const promoDiscount = (d.discount_amount as number) || 0;
        const zonePrice = (d.delivery_zone_price as number) || 0;
        const zoneName = d.delivery_zone_name as string | undefined;

        // Shipping cost (when no zone selected)
        let shippingCost = 0;
        if (!zoneName && d.delivery_type === 'delivery' && ctx.business) {
          const shippingMode = (ctx.business.metadata?.shipping_mode as string) || 'none';
          const defaultFee = (ctx.business.metadata?.default_shipping_fee as number) || 0;
          if (shippingMode === 'flat') {
            shippingCost = defaultFee;
          } else {
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

        const deliveryCost = zoneName ? zonePrice : shippingCost;
        const total = Math.max(0, subtotal + addonsTotal - volumeDiscountTotal - promoDiscount + deliveryCost);

        // Store calculated values for process_order
        d._calc_subtotal = subtotal;
        d._calc_addons_total = addonsTotal;
        d._calc_volume_discount = volumeDiscountTotal;
        d._calc_shipping_cost = shippingCost;
        d._calc_total = total;

        // Check minimum order amount
        const meta = (ctx.business?.metadata || {}) as Record<string, unknown>;
        const minOrder = (meta.min_order_amount as number) || 0;
        if (minOrder > 0 && total < minOrder) {
          return [
            {
              type: 'text',
              text: `\u26A0\uFE0F Minimum order amount is *${formatCurrency(minOrder, cc)}*.\n\nYour current total is ${formatCurrency(total, cc)}. Please add more items to continue.`,
            },
            {
              type: 'buttons',
              body: 'Add more items to meet the minimum:',
              buttons: [{ id: 'add_more_items', title: 'Add More Items' }],
            },
          ];
        }

        // Build summary
        const summary: string[] = [
          `\uD83D\uDED2 *Order Summary*`,
          '',
          ...lines,
        ];

        if (addonsTotal > 0) {
          summary.push(`\n\uD83D\uDD27 Add-ons: ${formatCurrency(addonsTotal, cc)}`);
        }
        if (volumeDiscountTotal > 0) {
          summary.push(`\uD83C\uDF81 Volume Discount: -${formatCurrency(volumeDiscountTotal, cc)}`);
        }
        if (promoDiscount > 0) {
          summary.push(`\uD83C\uDF9F\uFE0F Promo: -${formatCurrency(promoDiscount, cc)}`);
        }
        if (zoneName) {
          summary.push(`\uD83D\uDE9A ${zoneName}: ${zonePrice > 0 ? formatCurrency(zonePrice, cc) : 'FREE'}`);
        } else if (shippingCost > 0) {
          summary.push(`\uD83D\uDE9A Shipping: ${formatCurrency(shippingCost, cc)}`);
        }

        summary.push('', `\uD83D\uDCB0 *Total: ${formatCurrency(total, cc)}*`);

        if (d.delivery_address) {
          summary.push('', `\uD83D\uDCCD ${d.delivery_address}`);
        }

        const hasNegotiable = !!d._has_negotiable_addon;
        const buttons = hasNegotiable
          ? [
              { id: 'confirm_order', title: 'Confirm Order' },
              { id: 'request_quote', title: 'Request Quote' },
            ]
          : [
              { id: 'confirm_order', title: 'Confirm Order \u2705' },
            ];

        return [
          { type: 'text', text: summary.join('\n') },
          {
            type: 'buttons',
            body: hasNegotiable
              ? 'Some items have negotiable pricing. Request a quote or confirm at listed prices?'
              : 'Ready to place your order?',
            buttons,
          },
        ];
      },
      async validate(input: string): Promise<ValidationResult> {
        if (input === 'confirm_order') return { valid: true, data: { _order_action: 'confirm' } };
        if (input === 'request_quote') return { valid: true, data: { _order_action: 'quote' } };
        if (input === 'add_more_items') return { valid: true, data: { _order_action: 'add_more' } };
        return { valid: false, errorMessage: 'Please select an option.' };
      },
      async next(ctx: FlowContext) {
        const action = ctx.session.session_data._order_action;
        if (action === 'add_more') return 'browse_catalog';
        if (action === 'quote') return 'submit_quote_request';
        return 'process_order';
      },
    },

    // ── Submit Quote Request ──
    {
      id: 'submit_quote_request',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        const cart = (d.cart as CartItem[]) || [];
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;
        const customerName = `${d.first_name || ''} ${d.last_name || ''}`.trim() || 'Customer';
        const customerPhone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
        const estimatedSubtotal = (d._calc_total as number) || cart.reduce((s, i) => s + i.price * i.quantity, 0);

        // Gather all addons from cart items
        const allAddons: Array<{ name: string; price: number; quantity?: number }> = [];
        for (const item of cart) {
          if (item.addons) allAddons.push(...item.addons);
        }

        // Ensure user exists
        let userId = ctx.session.user_id;
        if (!userId) {
          userId = await createWhatsAppUser(ctx.supabase, ctx.from, (d.first_name as string) || '', (d.last_name as string) || '');
          if (userId) {
            ctx.session.user_id = userId;
            await ctx.supabase.from('bot_sessions').update({ user_id: userId }).eq('id', ctx.session.id);
          }
        }

        // Create quote request
        const { data: quote, error } = await ctx.supabase
          .from('quote_requests')
          .insert({
            business_id: ctx.business!.id,
            user_id: userId,
            customer_phone: customerPhone,
            customer_name: customerName,
            status: 'pending',
            cart_snapshot: cart,
            addons_snapshot: allAddons,
            delivery_zone_id: (d.delivery_zone_id as string) || null,
            delivery_zone_name: (d.delivery_zone_name as string) || null,
            delivery_address: (d.delivery_address as string) || null,
            estimated_subtotal: estimatedSubtotal,
            channel: 'whatsapp',
          })
          .select('id')
          .single();

        if (error || !quote) {
          logger.error('[ORDERING] Quote request creation failed:', error);
          return [{ type: 'text', text: 'Something went wrong. Send *Hi* to try again.' }];
        }

        // Notify business owner
        if (ctx.business) {
          notifyOwnerNewQuoteRequest({
            supabase: ctx.supabase,
            sender: ctx.sender,
            businessId: ctx.business.id,
            businessName: ctx.business.name,
            countryCode: cc,
            customerName,
            customerPhone,
            items: cart,
            addons: allAddons.length > 0 ? allAddons : undefined,
            estimatedSubtotal,
            deliveryZoneName: (d.delivery_zone_name as string) || undefined,
          }).catch(err => logger.error('[ORDERING] Quote notification error:', err));
        }

        // End session
        await ctx.supabase
          .from('bot_sessions')
          .update({ current_step: 'complete', is_active: false })
          .eq('id', ctx.session.id);

        return [{
          type: 'text',
          text: `\uD83D\uDCCB *Quote Request Submitted!*\n\n${ctx.business?.name || 'The business'} will review your order and send you a price.\n\nYou'll receive a WhatsApp message with their quote.\n\nThank you! \uD83D\uDE4F`,
        }];
      },
      async validate(): Promise<ValidationResult> { return { valid: true }; },
      async next() { return null; },
    },

    // ── Process Order ──
    {
      id: 'process_order',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        const cart = (d.cart as CartItem[]) || [];
        const discount = (d.discount_amount as number) || 0;

        // Use pre-calculated values from review_order_summary if available
        const addonsTotal = (d._calc_addons_total as number) || 0;
        const volumeDiscountTotal = (d._calc_volume_discount as number) || 0;
        const zoneName = d.delivery_zone_name as string | undefined;
        const zonePrice = (d.delivery_zone_price as number) || 0;

        // Calculate shipping cost (zone price takes priority)
        let shippingCost = 0;
        if (zoneName) {
          shippingCost = zonePrice;
        } else if (d.delivery_type === 'delivery' && ctx.business) {
          shippingCost = (d._calc_shipping_cost as number) || 0;
          // Fallback: recalculate if not pre-calculated
          if (!shippingCost) {
            const shippingMode = (ctx.business.metadata?.shipping_mode as string) || 'none';
            const defaultFee = (ctx.business.metadata?.default_shipping_fee as number) || 0;
            if (shippingMode === 'flat') {
              shippingCost = defaultFee;
            } else {
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
        }

        const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
        const total = Math.max(0, subtotal + addonsTotal - volumeDiscountTotal - discount + shippingCost);

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

        // Create order with new fields
        const orderPayload: Record<string, unknown> = {
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
        };

        // Add new ordering building block fields
        if (d.delivery_zone_id) orderPayload.delivery_zone_id = d.delivery_zone_id;
        if (zoneName) orderPayload.delivery_zone_name = zoneName;
        if (addonsTotal > 0) orderPayload.addons_total = addonsTotal;
        if (volumeDiscountTotal > 0) orderPayload.volume_discount_amount = volumeDiscountTotal;

        const { data: order, error } = await ctx.supabase
          .from('orders')
          .insert(orderPayload)
          .select('id, reference_code')
          .single();

        if (error || !order) {
          return [{ type: 'text', text: 'Something went wrong creating your order. Send *Hi* to try again.' }];
        }

        // Create order items (with addons) and decrement stock
        for (const item of cart) {
          const itemPayload: Record<string, unknown> = {
            order_id: order.id,
            product_id: item.product_id,
            quantity: item.quantity,
            unit_price: item.price,
            variant_id: item.variant_id || null,
            variant_label: item.variant_label || null,
          };
          if (item.addons && item.addons.length > 0) {
            itemPayload.addons = item.addons;
          }
          await ctx.supabase.from('order_items').insert(itemPayload);

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

        // ── Fire order_created rules + sequences (non-blocking) ──
        if (ctx.business) {
          const orderRuleCtx = {
            customer_phone: ctx.from,
            customer_name: `${d.first_name || ''} ${d.last_name || ''}`.trim() || undefined,
            business_name: ctx.business.name,
            reference_code: order.reference_code,
            reference_id: order.id,
            total_amount: total,
            item_count: cart.length,
            delivery_type: (d.delivery_type as string) || 'pickup',
          };
          const orderSendMsg = async (to: string, txt: string) => {
            await ctx.sender.sendText({ to, text: txt });
          };
          evaluateRules(ctx.supabase, ctx.business.id, 'order_created', orderRuleCtx, orderSendMsg)
            .catch(err => logger.error('[ORDERING] order_created rule error:', err));
          triggerSequences(ctx.supabase, ctx.business.id, 'after_order', ctx.from, orderRuleCtx)
            .catch(err => logger.error('[ORDERING] after_order sequence error:', err));
        }

        // Notify business owner via email + WhatsApp (non-blocking)
        if (ctx.business) {
          notifyOwnerNewOrder({
            supabase: ctx.supabase,
            sender: ctx.sender,
            businessId: ctx.business.id,
            businessName: ctx.business.name,
            countryCode: (ctx.business.country_code || 'NG') as CountryCode,
            referenceCode: order.reference_code,
            customerName: `${d.first_name || ''} ${d.last_name || ''}`.trim() || 'Customer',
            items: cart,
            totalAmount: total,
            deliveryAddress: (d.delivery_address as string) || undefined,
          }).catch(err => console.error('[ORDERING] Owner notification error:', err));
        }

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
                  shippingCost: zoneName ? undefined : (shippingCost || undefined),
                  deliveryZoneName: zoneName,
                  deliveryZonePrice: zoneName ? zonePrice : undefined,
                  addonsTotal: addonsTotal || undefined,
                  volumeDiscountAmount: volumeDiscountTotal || undefined,
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
            shippingCost: zoneName ? undefined : (shippingCost || undefined),
            deliveryZoneName: zoneName,
            deliveryZonePrice: zoneName ? zonePrice : undefined,
            addonsTotal: addonsTotal || undefined,
            volumeDiscountAmount: volumeDiscountTotal || undefined,
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

              // Fire payment_received rule (non-blocking)
              const pmtSendMsg = async (to: string, txt: string) => {
                await ctx.sender.sendText({ to, text: txt });
              };
              evaluateRules(ctx.supabase, ctx.business.id, 'payment_received', {
                customer_phone: ctx.from,
                customer_name: `${sd.first_name || ''} ${sd.last_name || ''}`.trim() || undefined,
                business_name: ctx.business.name,
                reference_code: sd.reference_code as string,
                reference_id: sd.order_id as string,
                total_amount: sd.total_amount as number || 0,
                service_type: 'order',
              }, pmtSendMsg).catch(err => logger.error('[ORDERING] payment_received rule error:', err));
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

import type { FlowDefinition, FlowStepConfig, FlowContext, PromptMessage, ValidationResult } from './types';
import type { CapabilityId } from '@/lib/capabilities/types';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';
import { truncTitle } from '../utils/truncate';
import { getCapabilityCustomLabels } from '@/lib/capabilities/service';
import { getCapabilityLabel } from '@/lib/capabilities/labels';
import { getCategoryLabels } from '@/lib/categoryConfig';

export { getCapabilityLabel };

/** Map capability to the first step of its corresponding flow */
function getFirstStepForCapability(cap: CapabilityId): string {
  switch (cap) {
    case 'appointment': return 'select_appointment';
    case 'scheduling': return 'select_service';
    case 'giving': return 'select_category'; // giving uses the payment flow
    case 'payment': return 'select_category';
    case 'ordering': return 'browse_catalog';
    case 'ticketing': return 'select_event';
    case 'reservation': return 'select_apartment';
    case 'crowdfunding': return 'select_campaign';
    case 'chat': return 'chat_start';
    case 'waitlist': return 'waitlist_join';
    case 'queue': return 'queue_start';
    case 'loyalty': return 'loyalty_menu';
    case 'invoice': return 'invoice_list';
    default: return 'select_service';
  }
}

const selectCapabilityStep: FlowStepConfig = {
  id: 'select_capability',

  async skipIf(ctx: FlowContext) {
    if (!ctx.business) return false;
    const capabilities = (ctx.session.session_data.capabilities as CapabilityId[]) || [];
    const businessId = ctx.business.id;

    // Filter out non-user-facing capabilities
    const nonUserFacing = new Set(['reminders', 'feedback', 'loyalty', 'referral', 'reports', 'staff', 'whatsapp_sign', 'survey', 'poll', 'broadcast', 'recurring', 'auto_reply', 'membership', 'estimates', 'packages', 'class_booking', 'multi_location']);
    if (capabilities.includes('scheduling')) { nonUserFacing.add('payment'); nonUserFacing.add('invoice'); }
    let userFacing = capabilities.filter(c => !nonUserFacing.has(c));

    // Only keep capabilities that have backing data
    const checks = await Promise.all(userFacing.map(async (cap): Promise<[CapabilityId, boolean]> => {
      switch (cap) {
        case 'ordering': {
          const { count } = await ctx.supabase.from('products').select('id', { count: 'exact', head: true })
            .eq('business_id', businessId).eq('is_active', true).is('deleted_at', null);
          return [cap, (count || 0) > 0];
        }
        case 'giving': {
          const { count } = await ctx.supabase.from('services').select('id', { count: 'exact', head: true })
            .eq('business_id', businessId).eq('is_active', true).eq('service_type', 'giving').is('deleted_at', null);
          return [cap, (count || 0) > 0];
        }
        case 'appointment': {
          const { count } = await ctx.supabase.from('appointments').select('id', { count: 'exact', head: true })
            .eq('business_id', businessId).eq('is_active', true);
          return [cap, (count || 0) > 0];
        }
        case 'scheduling': {
          const { count } = await ctx.supabase.from('services').select('id', { count: 'exact', head: true })
            .eq('business_id', businessId).eq('is_active', true).neq('service_type', 'giving').is('deleted_at', null);
          return [cap, (count || 0) > 0];
        }
        case 'ticketing': {
          const { count } = await ctx.supabase.from('events').select('id', { count: 'exact', head: true })
            .eq('business_id', businessId).eq('status', 'published');
          return [cap, (count || 0) > 0];
        }
        case 'crowdfunding': {
          const { count } = await ctx.supabase.from('campaigns').select('id', { count: 'exact', head: true })
            .eq('business_id', businessId).eq('status', 'active');
          return [cap, (count || 0) > 0];
        }
        case 'reservation': {
          const { count } = await ctx.supabase.from('properties').select('id', { count: 'exact', head: true })
            .eq('business_id', businessId).eq('is_active', true);
          return [cap, (count || 0) > 0];
        }
        case 'table_reservation': {
          const { count } = await ctx.supabase.from('services').select('id', { count: 'exact', head: true })
            .eq('business_id', businessId).eq('is_active', true).neq('service_type', 'giving').is('deleted_at', null);
          return [cap, (count || 0) > 0];
        }
        case 'waiver': {
          const { count } = await ctx.supabase.from('waiver_templates').select('id', { count: 'exact', head: true })
            .eq('business_id', businessId).eq('is_active', true);
          return [cap, (count || 0) > 0];
        }
        case 'waitlist':
          return [cap, false]; // waitlist is never shown as a menu option — triggered automatically when no slots
        default:
          return [cap, true]; // chat, queue, payment — always available
      }
    }));
    userFacing = checks.filter(([, hasData]) => hasData).map(([cap]) => cap);

    // Fetch custom labels for bot menu
    const customLabels = await getCapabilityCustomLabels(ctx.supabase, businessId);
    ctx.session.session_data._capability_custom_labels = customLabels;

    // Store filtered list for prompt to use
    ctx.session.session_data._filtered_capabilities = userFacing;

    // If 0 or 1 capability with data, auto-select and skip the menu
    if (userFacing.length <= 1) {
      const cap = userFacing[0] || capabilities[0] || 'scheduling';
      ctx.session.session_data.active_capability = cap;
      // Send greeting as standalone text since capability menu is skipped
      const greeting = ctx.session.session_data._greeting as string | undefined;
      if (greeting) {
        await ctx.sender.sendText({ to: ctx.from, text: greeting });
        delete ctx.session.session_data._greeting;
      }
      return true;
    }
    return false;
  },

  async prompt(ctx: FlowContext) {
    const userFacing = (ctx.session.session_data._filtered_capabilities as CapabilityId[]) || [];
    const category = ctx.business?.category || 'other';

    // Check if returning customer has past bookings/orders — show "My Account" option
    let hasHistory = false;
    if (ctx.business) {
      const phone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
      const { data: profile } = await ctx.supabase
        .from('profiles')
        .select('id')
        .eq('phone', phone)
        .maybeSingle();
      if (profile?.id) {
        const phoneP = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
        const phoneN = ctx.from.startsWith('+') ? ctx.from.slice(1) : ctx.from;

        // Check if customer has ANY history (bookings, orders, payments, invoices, donations)
        const [
          { count: bookingCount },
          { count: orderCount },
          { count: paymentCount },
          { count: invoiceCount },
          { count: donationCount },
        ] = await Promise.all([
          ctx.supabase.from('bookings').select('id', { count: 'exact', head: true })
            .eq('user_id', profile.id).limit(1),
          ctx.supabase.from('orders').select('id', { count: 'exact', head: true })
            .eq('user_id', profile.id).limit(1),
          ctx.supabase.from('payments').select('id', { count: 'exact', head: true })
            .eq('user_id', profile.id).eq('status', 'success').limit(1),
          ctx.supabase.from('invoices').select('id', { count: 'exact', head: true })
            .or(`customer_phone.eq.${sanitizeFilterValue(phoneP)},customer_phone.eq.${sanitizeFilterValue(phoneN)}`)
            .limit(1),
          ctx.supabase.from('campaign_donations').select('id', { count: 'exact', head: true })
            .or(`donor_phone.eq.${sanitizeFilterValue(phoneP)},donor_phone.eq.${sanitizeFilterValue(phoneN)}`)
            .eq('status', 'success').limit(1),
        ]);
        hasHistory = (bookingCount || 0) > 0 || (orderCount || 0) > 0 || (paymentCount || 0) > 0
          || (invoiceCount || 0) > 0 || (donationCount || 0) > 0;
      }
    }

    // Build capability items (use custom labels if set)
    const customLabels = (ctx.session.session_data._capability_custom_labels as Record<string, string>) || {};
    const capItems = userFacing.map(cap => ({
      id: `cap_${cap}`,
      title: getCapabilityLabel(cap, category, customLabels[cap]),
      postbackText: `cap_${cap}`,
    }));

    // Add "My Account" for returning customers
    if (hasHistory) {
      capItems.push({ id: 'cap_my_account', title: 'My Account', postbackText: 'cap_my_account' });
    }

    // Use greeting as body if available (first-time display), then clear it
    const greeting = ctx.session.session_data._greeting as string | undefined;
    const bodyText = greeting
      ? `${greeting}\n\nWhat would you like to do? 👇`
      : 'What would you like to do? 👇';
    if (greeting) delete ctx.session.session_data._greeting;

    // WhatsApp buttons max 3 — use a list for more options
    if (capItems.length <= 3) {
      return [{
        type: 'buttons' as const,
        body: bodyText,
        buttons: capItems.map(i => ({ id: i.id, title: i.title })),
      }];
    }

    // List message for 4+ items
    // WhatsApp list body max is 1024 chars — trim greeting if needed
    const listBody = bodyText.length > 1000 ? bodyText.slice(0, 997) + '...' : bodyText;
    return [{
      type: 'list' as const,
      title: ctx.business?.name || 'Menu',
      body: listBody,
      buttonLabel: 'View Options',
      items: capItems.map(i => ({ title: i.title, postbackText: i.postbackText })),
    }];
  },

  async validate(input: string, ctx: FlowContext) {
    const capabilities = (ctx.session.session_data.capabilities as CapabilityId[]) || [];
    const category = ctx.business?.category || 'other';
    const nonUF = new Set(['reminders', 'feedback', 'loyalty', 'referral', 'reports', 'staff', 'whatsapp_sign', 'survey', 'poll', 'broadcast', 'recurring', 'auto_reply', 'membership', 'estimates', 'packages', 'class_booking', 'multi_location']);
    if (capabilities.includes('scheduling')) { nonUF.add('payment'); nonUF.add('invoice'); }
    const userFacing = capabilities.filter(c => !nonUF.has(c));

    let capId: CapabilityId | null = null;

    // Handle "My Account" selection
    if (input === 'cap_my_account' || /^(my account|manage|my stuff)$/i.test(input.trim())) {
      ctx.session.session_data.active_capability = 'my_account';
      return { valid: true, data: { active_capability: 'my_account' } };
    }

    if (input.startsWith('cap_')) {
      capId = input.replace('cap_', '') as CapabilityId;
    } else {
      // Numeric selection: "1", "2", etc.
      const num = parseInt(input, 10);
      if (num >= 1 && num <= userFacing.length) {
        capId = userFacing[num - 1];
      }
      // Label match: "buy tickets", "give", etc.
      if (!capId) {
        const lower = input.toLowerCase();
        const valCustomLabels = (ctx.session.session_data._capability_custom_labels as Record<string, string>) || {};
        // Exact label match (check custom label first, then default)
        capId = userFacing.find(c => getCapabilityLabel(c, category, valCustomLabels[c]).toLowerCase() === lower) || null;
        // Partial match: input contains label or label contains input
        if (!capId) {
          capId = userFacing.find(c => {
            const label = getCapabilityLabel(c, category, valCustomLabels[c]).toLowerCase();
            return lower.includes(label) || label.includes(lower);
          }) || null;
        }
        // Keyword-based intent matching
        if (!capId) {
          if (/\b(book|appoint|schedule|reserv)\b/i.test(input)) {
            capId = userFacing.find(c => c === 'scheduling' || c === 'reservation') || null;
          } else if (/\b(give|tithe?|offer|donat|sadaqah|zakat|pay\s*tithe?|pay\s*offer|pay\s*seed)\b/i.test(input)) {
            // Prioritize giving over payment — "pay tithe" should go to giving, not payment
            capId = userFacing.find(c => c === 'giving') || userFacing.find(c => c === 'payment') || null;
          } else if (/\b(pay|fee|bill|dues|levy)\b/i.test(input)) {
            capId = userFacing.find(c => c === 'payment') || null;
          } else if (/\b(order|buy|shop|menu|food)\b/i.test(input)) {
            capId = userFacing.find(c => c === 'ordering') || null;
          } else if (/\b(ticket|event|show|concert)\b/i.test(input)) {
            capId = userFacing.find(c => c === 'ticketing') || null;
          } else if (/\b(chat|talk|speak|help|support)\b/i.test(input)) {
            capId = userFacing.find(c => c === 'chat') || null;
          } else if (/\b(waiver|sign|release\s*form|liability)\b/i.test(input)) {
            capId = userFacing.find(c => c === 'waiver') || null;
          }
        }
      }
    }

    if (!capId || !capabilities.includes(capId)) {
      return { valid: false, errorMessage: 'I didn\'t understand that. Try typing *book*, *order*, *tickets*, or tap *View Options* to see the menu.' };
    }

    // Smart intent: extract date/time/service from natural language input
    // so the scheduling flow can fast-track (skip already-answered steps)
    if ((capId === 'scheduling' || capId === 'reservation' || capId === 'payment' || capId === 'giving' || capId === 'ticketing' || capId === 'ordering') && ctx.business) {
      try {
        const { parseSmartIntentHybrid, matchServiceFromKeywords } = await import('@/lib/bot/smart-intent');
        const parsed = await parseSmartIntentHybrid(input, ctx.business.category || null, ctx.supabase, ctx.business.id || null);

        if (parsed.understood) {
          // Match service keywords — single match skips, multiple shows picker
          if (parsed.serviceKeywords.length > 0) {
            const { matchServicesFromKeywords } = await import('@/lib/bot/smart-intent');
            const matches = await matchServicesFromKeywords(ctx.supabase, ctx.business.id, parsed.serviceKeywords);
            if (matches.length === 1) {
              // Unambiguous — skip service picker
              ctx.session.session_data.service_id = matches[0].id;
              ctx.session.session_data.service_name = matches[0].name;
              ctx.session.session_data.service_price = matches[0].price;
              ctx.session.session_data.service_duration = matches[0].duration_minutes;
              ctx.session.session_data.service_deposit = matches[0].deposit_amount || 0;
              ctx.session.session_data.skip_service = true;
            } else if (matches.length > 1) {
              // Ambiguous — store matched IDs so service picker shows only these
              ctx.session.session_data._matched_service_ids = matches.map(m => m.id);
            }
          }
          if (parsed.date) ctx.session.session_data.date = parsed.date;
          if (parsed.specificTime) ctx.session.session_data.time = parsed.specificTime;
          if (parsed.timePreference) ctx.session.session_data._time_preference = parsed.timePreference;
          if (parsed.quantity && parsed.quantity >= 1 && parsed.quantity <= 20) {
            ctx.session.session_data.party_size = parsed.quantity;
            ctx.session.session_data.ticket_quantity = parsed.quantity;
          }
          if (parsed.amount && parsed.amount >= 1) {
            ctx.session.session_data.amount = parsed.amount;
          }

          // Match products for ordering flow
          if (capId === 'ordering' && parsed.serviceKeywords.length > 0) {
            const { matchProductsFromKeywords } = await import('@/lib/bot/smart-intent');
            const productMatches = await matchProductsFromKeywords(ctx.supabase, ctx.business.id, parsed.serviceKeywords);
            if (productMatches.length === 1) {
              // Single match — pre-add to cart
              const p = productMatches[0];
              const qty = parsed.quantity || 1;
              ctx.session.session_data.cart = [{
                product_id: p.id, name: p.name, price: p.price,
                quantity: qty, variant: null, variant_label: null,
              }];
              ctx.session.session_data._auto_added_to_cart = true;
              ctx.session.session_data._skip_browse = true;
            } else if (productMatches.length > 1) {
              // Multiple matches — filter catalog
              ctx.session.session_data._matched_product_ids = productMatches.map(m => m.id);
            }
          }

          // Store variant hints for ordering flow auto-selection
          if (capId === 'ordering' && parsed.variantKeywords.length > 0) {
            ctx.session.session_data._variant_hints = parsed.variantKeywords;
          }

          // Send acknowledgment
          const productName = ctx.session.session_data._auto_added_to_cart
            ? ((ctx.session.session_data.cart as Array<{name: string}>)?.[0]?.name || null)
            : null;
          const { buildAcknowledgment } = await import('@/lib/bot/smart-intent');
          const { getLocale } = await import('@/lib/constants');
          const ack = buildAcknowledgment(parsed, ctx.session.session_data.service_name as string | null || productName, getLocale(ctx.business.country_code));
          if (ack) {
            await ctx.sender.sendText({ to: ctx.from, text: await ctx.t(ack) });
          }
        }
      } catch {
        // Non-fatal — flow continues normally without pre-fill
      }
    }

    // Waiver: send signing link inline (no separate flow)
    if (capId === 'waiver' && ctx.business) {
      const { data: templates } = await ctx.supabase
        .from('waiver_templates')
        .select('id, title, token')
        .eq('business_id', ctx.business.id)
        .eq('is_active', true)
        .order('created_at', { ascending: false });

      if (templates && templates.length > 0) {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
        if (templates.length === 1) {
          const t = templates[0];
          await ctx.sender.sendText({
            to: ctx.from,
            text: await ctx.t(`📋 *${t.title}*\n\nSign your waiver here:\n${appUrl}/w/${t.token}\n\nOpen the link on your phone to read and sign.`),
          });
        } else {
          const lines = templates.map((t, i) => `${i + 1}. *${t.title}*\n   ${appUrl}/w/${t.token}`);
          await ctx.sender.sendText({
            to: ctx.from,
            text: await ctx.t(`📋 *Waivers to Sign*\n\n${lines.join('\n\n')}\n\nOpen a link to read and sign.`),
          });
        }
      } else {
        await ctx.sender.sendText({
          to: ctx.from,
          text: await ctx.t('No waivers are available right now.'),
        });
      }
      // Return to capability menu
      return { valid: true, data: { active_capability: 'waiver', _waiver_handled: true } };
    }

    return {
      valid: true,
      data: { active_capability: capId },
    };
  },

  async next(ctx: FlowContext) {
    const cap = ctx.session.session_data.active_capability as string;
    if (cap === 'my_account') return 'my_account_menu';
    // Waiver was handled inline — return to capability menu
    if (ctx.session.session_data._waiver_handled) {
      delete ctx.session.session_data._waiver_handled;
      return 'select_capability';
    }
    return getFirstStepForCapability(cap as CapabilityId);
  },
};

// ── My Account Menu ──
// Shows self-service options for returning customers

const myAccountMenuStep: FlowStepConfig = {
  id: 'my_account_menu',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const capabilities = (ctx.session.session_data.capabilities as CapabilityId[]) || [];
    const hasCapability = (...caps: CapabilityId[]) => caps.some(c => capabilities.includes(c));

    // Build menu items based on enabled capabilities
    const allItems = [
      // My Bookings — always show (covers scheduling, appointment, ticketing, reservation)
      { title: 'My Bookings', description: 'Appointments, tickets, stays', postbackText: 'acct_bookings', show: true },
      // My Orders — show if ordering capability enabled
      { title: 'My Orders', description: 'Track order status', postbackText: 'acct_orders', show: hasCapability('ordering') },
      // My Giving — show if giving or crowdfunding capability enabled
      { title: 'My Giving', description: 'Donation & offering history', postbackText: 'acct_giving', show: hasCapability('giving', 'crowdfunding') },
      // My Invoices — show if invoice capability enabled
      { title: 'My Invoices', description: 'View and pay invoices', postbackText: 'acct_invoices', show: hasCapability('invoice') },
      // My Contracts — show if whatsapp_sign capability enabled
      { title: 'My Contracts', description: 'Sign or view contracts', postbackText: 'acct_contracts', show: hasCapability('whatsapp_sign') },
      // My Quotes — show if estimates capability enabled
      { title: 'My Quotes', description: 'Price request status', postbackText: 'acct_quotes', show: hasCapability('estimates') },
      // My Points — show if loyalty capability enabled
      { title: 'My Points', description: 'Loyalty balance', postbackText: 'acct_loyalty', show: hasCapability('loyalty') },
      // Subscriptions — show if recurring capability enabled
      { title: 'Subscriptions', description: 'Manage recurring payments', postbackText: 'acct_subscriptions', show: hasCapability('recurring') },
      // Get Receipt — always show
      { title: 'Get Receipt', description: 'Download your last receipt', postbackText: 'acct_receipt', show: true },
      // Switch Business — always show (helps users discover how to change)
      { title: 'Switch Business', description: 'Visit a different business', postbackText: 'acct_switch', show: true },
    ];

    const items = allItems
      .filter(i => i.show)
      .map(({ title, description, postbackText }) => ({ title, description, postbackText }));

    items.push({ title: '← Back', description: 'Return to main menu', postbackText: 'acct_back' });

    return [{
      type: 'list' as const,
      title: 'My Account',
      body: 'Manage your bookings, orders, and more.\n\nType *cancel* to exit or *Hi* to start over.',
      buttonLabel: 'My Account',
      items,
    }];
  },

  async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
    const action = input.toLowerCase().trim();

    // Handle back to account menu (from sub-section back buttons)
    if (action === 'back_to_account') {
      ctx.session.session_data._my_account_route = 'my_account_menu';
      return { valid: true, data: { _my_account_route: 'my_account_menu' } };
    }

    // Handle back to main capability menu
    if (action === 'acct_back') {
      return { valid: true, data: { _my_account_route: 'back_to_capabilities' } };
    }

    // Map selections to built-in bot.service.ts handlers via session step
    // Handle receipt request — try PDF, fall back to text receipt via transaction-docs handler
    if (action === 'acct_receipt' || action === 'receipt' || action === 'my receipt') {
      let userId = ctx.session.user_id;
      if (!userId) {
        const { findUserByPhone } = await import('./shared/user');
        const profile = await findUserByPhone(ctx.supabase, ctx.from);
        userId = profile?.id || null;
      }

      if (userId) {
        // Delegate to the same handler used by typing "receipt" — handles PDF, image, and text fallbacks
        const { handleTransactionDocument } = await import('../handlers/transaction-docs');
        const sendText = async (to: string, text: string) => { await ctx.sender.sendText({ to, text: await ctx.t(text) }); };
        await handleTransactionDocument(ctx.supabase, ctx.sender, sendText, ctx.from, userId, 'receipt');
      } else {
        await ctx.sender.sendText({ to: ctx.from, text: await ctx.t('No account found for this number. Send *Hi* to start over.') });
      }
      ctx.session.session_data._my_account_route = 'select_capability';
      return { valid: true, data: { _my_account_route: 'select_capability' } };
    }

    // Handle switch business
    if (action === 'acct_switch' || action === 'switch' || action === 'switch business') {
      // Deactivate current session so user can start fresh
      await ctx.supabase.from('bot_sessions')
        .update({ is_active: false })
        .eq('id', ctx.session.id);
      await ctx.sender.sendText({
        to: ctx.from,
        text: await ctx.t('To switch to a different business:\n\n• Type *switch* followed by the business name\n  _e.g. switch FacesByKoph_\n\n• Or send *Hi* to see your recent businesses'),
      });
      return { valid: true, data: {} };
    }

    // Handle giving history inline
    if (action === 'acct_giving' || action === 'my giving' || action === 'giving') {
      const phoneP = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
      const phoneN = ctx.from.startsWith('+') ? ctx.from.slice(1) : ctx.from;

      // Giving payments are bookings linked to services with service_type='giving'
      // and deposit_status='paid'. Also include campaign_donations.
      const [{ data: givingBookings }, { data: donations }] = await Promise.all([
        // Fetch paid bookings — limit higher because we post-filter for service_type='giving'
        // (Supabase can't filter on joined column directly)
        ctx.supabase.from('bookings')
          .select('total_amount, created_at, services:service_id(name, service_type), businesses:business_id(name)')
          .or(`guest_phone.eq.${sanitizeFilterValue(phoneP)},guest_phone.eq.${sanitizeFilterValue(phoneN)}`)
          .eq('deposit_status', 'paid')
          .order('created_at', { ascending: false }).limit(100),
        ctx.supabase.from('campaign_donations')
          .select('amount, created_at, reference_code')
          .or(`donor_phone.eq.${sanitizeFilterValue(phoneP)},donor_phone.eq.${sanitizeFilterValue(phoneN)}`)
          .eq('status', 'success')
          .order('created_at', { ascending: false }).limit(10),
      ]);

      const allGiving: Array<{ amount: number; date: string; label: string }> = [];
      if (givingBookings) {
        for (const b of givingBookings) {
          const svc = b.services as unknown as { name: string; service_type?: string } | null;
          if (svc?.service_type !== 'giving') continue;
          const biz = b.businesses as unknown as { name: string } | null;
          allGiving.push({
            amount: Number(b.total_amount || 0),
            date: new Date(b.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
            label: svc.name || biz?.name || 'Offering',
          });
        }
      }
      if (donations) {
        for (const d of donations) {
          allGiving.push({
            amount: Number(d.amount),
            date: new Date(d.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
            label: `Campaign (${d.reference_code})`,
          });
        }
      }

      if (allGiving.length === 0) {
        await ctx.sender.sendButtons({
          to: ctx.from,
          body: await ctx.t("You don't have any giving history yet. Send *Hi* to give!"),
          buttons: [{ id: 'back_to_account', title: '← Back' }],
        });
      } else {
        const total = allGiving.reduce((sum, g) => sum + g.amount, 0);
        const bizCC = (ctx.business?.country_code || 'NG') as CountryCode;
        const lines = ['🙏 *Your Giving History*', '',
          ...allGiving.slice(0, 8).map(g => `📅 ${g.date} — *${g.label}* — ${formatCurrency(g.amount, bizCC)}`),
          '', `💰 *Total: ${formatCurrency(total, bizCC)}*`];
        await ctx.sender.sendText({ to: ctx.from, text: await ctx.t(lines.join('\n')) });
        await ctx.sender.sendButtons({
          to: ctx.from,
          body: ' ',
          buttons: [{ id: 'back_to_account', title: '← Back' }],
        });
      }
      ctx.session.session_data._my_account_route = 'my_account_menu';
      return { valid: true, data: { _my_account_route: 'my_account_menu' } };
    }

    // Handle contracts inline
    if (action === 'acct_contracts' || action === 'my contracts' || action === 'contracts') {
      const phoneP = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
      const phoneN = ctx.from.startsWith('+') ? ctx.from.slice(1) : ctx.from;
      const { data: contracts } = await ctx.supabase
        .from('contracts')
        .select('id, title, status, signed_at, created_at, token, businesses:business_id(name)')
        .or(`signer_phone.eq.${sanitizeFilterValue(phoneP)},signer_phone.eq.${sanitizeFilterValue(phoneN)}`)
        .order('created_at', { ascending: false })
        .limit(10);

      if (!contracts || contracts.length === 0) {
        await ctx.sender.sendButtons({
          to: ctx.from,
          body: await ctx.t("You don't have any contracts."),
          buttons: [{ id: 'back_to_account', title: '← Back' }],
        });
      } else {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
        const pending = contracts.filter(c => c.status === 'pending');
        const signed = contracts.filter(c => c.status === 'signed');
        const lines = ['📋 *Your Contracts*', ''];
        if (pending.length > 0) {
          lines.push('⏳ *Pending:*');
          for (const c of pending) { lines.push(`• ${c.title} — ${appUrl}/sign/${c.token}`); }
          lines.push('');
        }
        if (signed.length > 0) {
          lines.push('✅ *Signed:*');
          for (const c of signed) {
            const d = c.signed_at ? new Date(c.signed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
            lines.push(`• ${c.title} — ${d}`);
          }
        }
        await ctx.sender.sendText({ to: ctx.from, text: await ctx.t(lines.join('\n')) });
        await ctx.sender.sendButtons({
          to: ctx.from,
          body: ' ',
          buttons: [{ id: 'back_to_account', title: '← Back' }],
        });
      }
      ctx.session.session_data._my_account_route = 'my_account_menu';
      return { valid: true, data: { _my_account_route: 'my_account_menu' } };
    }

    // Handle quotes inline
    if (action === 'acct_quotes' || action === 'my quotes' || action === 'quotes') {
      const phoneP = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
      const phoneN = ctx.from.startsWith('+') ? ctx.from.slice(1) : ctx.from;
      const { data: quotes } = await ctx.supabase
        .from('quote_requests')
        .select('id, status, quoted_amount, created_at, businesses:business_id(name)')
        .or(`customer_phone.eq.${sanitizeFilterValue(phoneP)},customer_phone.eq.${sanitizeFilterValue(phoneN)}`)
        .order('created_at', { ascending: false })
        .limit(10);

      if (!quotes || quotes.length === 0) {
        await ctx.sender.sendButtons({
          to: ctx.from,
          body: await ctx.t("You don't have any price requests."),
          buttons: [{ id: 'back_to_account', title: '← Back' }],
        });
      } else {
        const emoji: Record<string, string> = { pending: '⏳', quoted: '💰', accepted: '✅', rejected: '❌', expired: '⌛' };
        const lines = ['📋 *Your Price Requests*', ''];
        for (const q of quotes) {
          const biz = q.businesses as any;
          const d = new Date(q.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          const e = emoji[q.status] || '📋';
          let line = `${e} ${biz?.name || 'Business'} — ${d}`;
          if (q.status === 'quoted' && q.quoted_amount) line += ` — ${q.quoted_amount}`;
          else if (q.status === 'pending') line += ' — Awaiting response';
          lines.push(line);
        }
        await ctx.sender.sendText({ to: ctx.from, text: await ctx.t(lines.join('\n')) });
        await ctx.sender.sendButtons({
          to: ctx.from,
          body: ' ',
          buttons: [{ id: 'back_to_account', title: '← Back' }],
        });
      }
      ctx.session.session_data._my_account_route = 'my_account_menu';
      return { valid: true, data: { _my_account_route: 'my_account_menu' } };
    }

    // Route to flow steps — bookings/orders are stub steps in this flow,
    // subscriptions/loyalty/invoices are steps in their own flows.
    // All found via cross-flow lookup in the executor.
    const routeMap: Record<string, string> = {
      'acct_bookings': 'my_bookings',
      'my bookings': 'my_bookings',
      'bookings': 'my_bookings',
      'acct_orders': 'my_orders',
      'my orders': 'my_orders',
      'orders': 'my_orders',
      'track': 'my_orders',
      'acct_subscriptions': 'list_subscriptions',
      'subscriptions': 'list_subscriptions',
      'acct_loyalty': 'loyalty_menu',
      'acct_invoices': 'invoice_list',
      'my points': 'loyalty_menu',
      'points': 'loyalty_menu',
      'loyalty': 'loyalty_menu',
      'my invoices': 'invoice_list',
      'invoices': 'invoice_list',
    };

    const targetStep = routeMap[action];
    if (targetStep) {
      ctx.session.session_data._my_account_route = targetStep;
      return { valid: true, data: { _my_account_route: targetStep } };
    }

    return { valid: false, errorMessage: 'Please pick an option from the list.' };
  },

  async next(ctx: FlowContext) {
    const route = ctx.session.session_data._my_account_route as string;
    // If explicitly done, end the flow
    if (route === 'done') return null;
    // Back to main capability selection menu
    if (route === 'back_to_capabilities') return 'select_capability';
    // If handled inline (giving, contracts, quotes, receipt), return to My Account menu
    if (route === 'select_capability') return 'my_account_menu';
    // Otherwise route to the flow step
    return route || 'my_account_menu';
  },
};

// ── My Bookings Stub ──
// Shows bookings listing via prompt(). Follow-up messages (booking_123, ticket_456)
// are intercepted by bot.service.ts before the executor runs.
const myBookingsStep: FlowStepConfig = {
  id: 'my_bookings',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const phoneP = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
    const phoneN = ctx.from.startsWith('+') ? ctx.from.slice(1) : ctx.from;

    const [{ data: upcoming }, { data: tickets }, { data: reservations }] = await Promise.all([
      ctx.supabase.from('bookings')
        .select('id, date, time, party_size, reference_code, businesses (name)')
        .eq('user_id', ctx.session.user_id!)
        .in('status', ['confirmed', 'pending'])
        .gte('date', new Date().toISOString().split('T')[0])
        .order('date', { ascending: true }).limit(5),
      ctx.supabase.from('event_tickets')
        .select('id, ticket_code, guest_name, status, created_at, event:events!event_id(name, date, time, venue)')
        .or(`guest_phone.eq.${sanitizeFilterValue(phoneP)},guest_phone.eq.${sanitizeFilterValue(phoneN)}`)
        .eq('status', 'valid')
        .order('created_at', { ascending: false }).limit(5),
      ctx.supabase.from('reservations')
        .select('id, check_in, check_out, reference_code, guest_name, status, property_id, businesses:business_id(name)')
        .or(`guest_phone.eq.${sanitizeFilterValue(phoneP)},guest_phone.eq.${sanitizeFilterValue(phoneN)}`)
        .in('status', ['confirmed', 'pending', 'checked_in'])
        .gte('check_out', new Date().toISOString().split('T')[0])
        .order('check_in', { ascending: true }).limit(5),
    ]);

    const items: { title: string; description: string; postbackText: string }[] = [];
    if (upcoming) {
      for (const r of upcoming) {
        const biz = r.businesses as unknown as { name: string } | null;
        const dateLabel = new Date(r.date + 'T00:00').toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' });
        items.push({ title: biz?.name || 'Business', description: `${dateLabel} at ${r.time} • ${r.party_size} ${getCategoryLabels(ctx.business?.category || 'restaurant').quantityLabel}`, postbackText: `booking_${r.id}` });
      }
    }
    if (tickets) {
      for (const t of tickets) {
        const evt = t.event as unknown as { name: string; date: string; time?: string; venue?: string } | null;
        const dateLabel = evt?.date ? new Date(evt.date + 'T00:00').toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
        items.push({ title: evt?.name || 'Event', description: `${dateLabel} • Ticket: ${t.ticket_code}`, postbackText: `ticket_${t.id}` });
      }
    }
    if (reservations) {
      for (const r of reservations) {
        const biz = r.businesses as unknown as { name: string } | null;
        const checkIn = new Date(r.check_in + 'T00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
        const checkOut = new Date(r.check_out + 'T00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
        items.push({ title: biz?.name || 'Stay', description: `${checkIn} → ${checkOut} • Ref: ${r.reference_code}`, postbackText: `reservation_${r.id}` });
      }
    }

    if (items.length === 0) {
      return [{ type: 'text' as const, text: "You don't have any upcoming bookings, tickets, or stays. Send *Hi* to start over." }];
    }
    return [{
      type: 'list' as const,
      title: 'Your Bookings & Tickets',
      body: 'Select a booking, ticket, or stay to view:',
      buttonLabel: 'View All',
      items,
    }];
  },

  // validate/next are never called — bot.service.ts intercepts at current_step === 'my_bookings'
  async validate() { return { valid: true }; },
  async next() { return null; },
};

// ── My Orders Stub ──
// Shows orders listing via prompt(). Follow-up messages (order_123)
// are intercepted by bot.service.ts before the executor runs.
const myOrdersStep: FlowStepConfig = {
  id: 'my_orders',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const { data: orders } = await ctx.supabase
      .from('orders')
      .select('id, reference_code, status, total_amount, created_at, businesses (name, country_code)')
      .eq('user_id', ctx.session.user_id!)
      .in('status', ['pending', 'confirmed', 'processing', 'ready', 'shipped'])
      .order('created_at', { ascending: false }).limit(10);

    if (!orders || orders.length === 0) {
      return [{ type: 'text' as const, text: "You don't have any active orders. Send *Hi* to place an order!" }];
    }

    const statusLabel: Record<string, string> = { pending: 'Pending', confirmed: 'Confirmed', processing: 'Processing', ready: 'Ready', shipped: 'Shipped' };
    const statusEmoji: Record<string, string> = { pending: '🕐', confirmed: '✅', processing: '🔧', ready: '📦', shipped: '🚚' };

    if (orders.length <= 3) {
      const lines = orders.map((o) => {
        const b = o.businesses as unknown as { name: string; country_code?: string } | null;
        const cc = (b?.country_code as CountryCode) || 'NG';
        const dateLabel = new Date(o.created_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
        return `${statusEmoji[o.status] || '📋'} *${o.reference_code}* — ${statusLabel[o.status] || o.status}\n   ${b?.name || 'Order'} • ${dateLabel} • ${formatCurrency(o.total_amount || 0, cc)}`;
      });
      return [
        { type: 'text' as const, text: `📦 *Your Orders*\n\n${lines.join('\n\n')}` },
        { type: 'buttons' as const, body: 'Select an order to view details:', buttons: orders.slice(0, 3).map((o) => ({ id: `order_${o.id}`, title: truncTitle(`${o.reference_code}`) })) },
      ];
    }

    return [{
      type: 'list' as const,
      title: 'Your Orders',
      body: '📦 Select an order to view details:',
      buttonLabel: 'View Orders',
      items: orders.map((o) => {
        const b = o.businesses as unknown as { name: string; country_code?: string } | null;
        const cc = (b?.country_code as CountryCode) || 'NG';
        return {
          title: truncTitle(`${o.reference_code}`, 24),
          description: `${statusLabel[o.status] || o.status} • ${b?.name || 'Order'} • ${formatCurrency(o.total_amount || 0, cc)}`.slice(0, 72),
          postbackText: `order_${o.id}`,
        };
      }),
    }];
  },

  // validate/next are never called — bot.service.ts intercepts at current_step === 'my_orders'
  async validate() { return { valid: true }; },
  async next() { return null; },
};

export const capabilitySelectionFlow: FlowDefinition = {
  type: 'scheduling', // placeholder — this is a pseudo-flow
  steps: [selectCapabilityStep, myAccountMenuStep, myBookingsStep, myOrdersStep],
};

export { getFirstStepForCapability };

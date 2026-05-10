import type { FlowDefinition, FlowStepConfig, FlowContext, PromptMessage, ValidationResult } from './types';
import type { CapabilityId } from '@/lib/capabilities/types';

/** Generic labels for capability selection buttons */
export function getCapabilityLabel(cap: CapabilityId, category: string): string {
  switch (cap) {
    case 'scheduling':
      return 'Our Services';
    case 'appointment': {
      const bookingLabels: Record<string, string> = {
        restaurant: 'Book a Table',
        event_services: 'Book a Service',
        photographer: 'Book a Session',
        gym: 'Book a Session',
        tutor: 'Book a Session',
        coworking: 'Book a Space',
        car_wash: 'Book a Wash',
      };
      return bookingLabels[category] || 'Book Appointment';
    }
    case 'giving':
      return 'Give';
    case 'payment':
      return 'Make Payment';
    case 'ordering':
      return 'Place an Order';
    case 'ticketing':
      return 'Buy Tickets';
    case 'reservation':
      return 'Book a Stay';
    case 'crowdfunding':
      return 'Support a Campaign';
    case 'reminders':
      return 'My Reminders';
    case 'chat':
      return 'Chat with Us';
    case 'waitlist':
      return 'Join Waitlist';
    case 'queue':
      return 'Check In';
    case 'loyalty':
      return 'My Rewards';
    case 'invoice':
      return 'My Invoices';
    default:
      return cap;
  }
}

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
    const nonUserFacing = new Set(['reminders', 'feedback', 'loyalty', 'referral', 'reports', 'staff', 'whatsapp_sign', 'survey', 'poll']);
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
        case 'waitlist':
          return [cap, false]; // waitlist is never shown as a menu option — triggered automatically when no slots
        default:
          return [cap, true]; // chat, queue — always available
      }
    }));
    userFacing = checks.filter(([, hasData]) => hasData).map(([cap]) => cap);

    // Store filtered list for prompt to use
    ctx.session.session_data._filtered_capabilities = userFacing;

    // If 0 or 1 capability with data, auto-select and skip the menu
    if (userFacing.length <= 1) {
      const cap = userFacing[0] || capabilities[0] || 'scheduling';
      ctx.session.session_data.active_capability = cap;
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
        const { count: bookingCount } = await ctx.supabase
          .from('bookings')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', profile.id)
          .limit(1);
        const { count: orderCount } = await ctx.supabase
          .from('orders')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', profile.id)
          .limit(1);
        hasHistory = (bookingCount || 0) > 0 || (orderCount || 0) > 0;
      }
    }

    // Build capability items
    const capItems = userFacing.map(cap => ({
      id: `cap_${cap}`,
      title: getCapabilityLabel(cap, category),
      postbackText: `cap_${cap}`,
    }));

    // Add "My Account" for returning customers
    if (hasHistory) {
      capItems.push({ id: 'cap_my_account', title: 'My Account', postbackText: 'cap_my_account' });
    }

    // WhatsApp buttons max 3 — use a list for more options
    if (capItems.length <= 3) {
      return [{
        type: 'buttons' as const,
        body: 'What would you like to do?',
        buttons: capItems.map(i => ({ id: i.id, title: i.title })),
      }];
    }

    // List message for 4+ items
    return [{
      type: 'list' as const,
      title: 'Services',
      body: 'What would you like to do?',
      buttonLabel: 'View Options',
      items: capItems.map(i => ({ title: i.title, postbackText: i.postbackText })),
    }];
  },

  async validate(input: string, ctx: FlowContext) {
    const capabilities = (ctx.session.session_data.capabilities as CapabilityId[]) || [];
    const category = ctx.business?.category || 'other';
    const nonUF = new Set(['reminders', 'feedback', 'loyalty', 'referral', 'reports', 'staff', 'whatsapp_sign', 'survey', 'poll']);
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
        // Exact label match
        capId = userFacing.find(c => getCapabilityLabel(c, category).toLowerCase() === lower) || null;
        // Partial match: input contains label or label contains input
        if (!capId) {
          capId = userFacing.find(c => {
            const label = getCapabilityLabel(c, category).toLowerCase();
            return lower.includes(label) || label.includes(lower);
          }) || null;
        }
        // Keyword-based intent matching
        if (!capId) {
          if (/\b(book|appoint|schedule|reserv)\b/i.test(input)) {
            capId = userFacing.find(c => c === 'scheduling' || c === 'reservation') || null;
          } else if (/\b(give|tith|offer|donat|sadaqah|zakat)\b/i.test(input)) {
            capId = userFacing.find(c => c === 'giving' || c === 'payment') || null;
          } else if (/\b(order|buy|shop|menu|food)\b/i.test(input)) {
            capId = userFacing.find(c => c === 'ordering') || null;
          } else if (/\b(ticket|event|show|concert)\b/i.test(input)) {
            capId = userFacing.find(c => c === 'ticketing') || null;
          } else if (/\b(chat|talk|speak|help|support)\b/i.test(input)) {
            capId = userFacing.find(c => c === 'chat') || null;
          }
        }
      }
    }

    if (!capId || !capabilities.includes(capId)) {
      return { valid: false, errorMessage: 'Please select an option from the menu.' };
    }

    return {
      valid: true,
      data: { active_capability: capId },
    };
  },

  async next(ctx: FlowContext) {
    const cap = ctx.session.session_data.active_capability as string;
    if (cap === 'my_account') return 'my_account_menu';
    return getFirstStepForCapability(cap as CapabilityId);
  },
};

// ── My Account Menu ──
// Shows self-service options for returning customers

const myAccountMenuStep: FlowStepConfig = {
  id: 'my_account_menu',

  async prompt(): Promise<PromptMessage[]> {
    return [{
      type: 'list' as const,
      title: 'My Account',
      body: 'Manage your bookings, orders, and more:',
      buttonLabel: 'My Account',
      items: [
        { title: 'My Bookings', description: 'View, reschedule, or cancel', postbackText: 'acct_bookings' },
        { title: 'My Orders', description: 'Track order status', postbackText: 'acct_orders' },
        { title: 'My Points', description: 'Check loyalty balance', postbackText: 'acct_loyalty' },
        { title: 'My Invoices', description: 'View and pay invoices', postbackText: 'acct_invoices' },
        { title: 'Get Receipt', description: 'Download your last receipt', postbackText: 'acct_receipt' },
      ],
    }];
  },

  async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
    const action = input.toLowerCase().trim();

    // Map selections to built-in bot.service.ts handlers via session step
    // Handle receipt request directly — no flow step, uses bot.service.ts handler
    if (action === 'acct_receipt' || action === 'receipt' || action === 'my receipt') {
      // Get user profile for receipt generation
      const phone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
      const { data: profile } = await ctx.supabase
        .from('profiles')
        .select('id')
        .eq('phone', phone)
        .maybeSingle();

      if (profile?.id) {
        const baseUrl = process.env.NEXT_PUBLIC_APP_URL || '';
        try {
          const res = await fetch(`${baseUrl}/api/receipts/generate`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-internal-token': process.env.INTERNAL_API_TOKEN || '',
            },
            body: JSON.stringify({ userId: profile.id, type: 'receipt', phone: ctx.from }),
          });
          if (res.ok) {
            const { url, filename } = await res.json();
            await ctx.sender.sendDocument({ to: ctx.from, documentUrl: url, filename, caption: 'Your latest receipt' });
          } else {
            await ctx.sender.sendText({ to: ctx.from, text: 'No recent transactions found. Make a purchase first!' });
          }
        } catch {
          await ctx.sender.sendText({ to: ctx.from, text: 'Sorry, could not generate your receipt right now. Try again later.' });
        }
      } else {
        await ctx.sender.sendText({ to: ctx.from, text: 'No account found for this number. Send *Hi* to get started!' });
      }
      // Return to menu
      ctx.session.session_data._my_account_route = 'select_capability';
      return { valid: true, data: { _my_account_route: 'select_capability' } };
    }

    const routeMap: Record<string, string> = {
      'acct_bookings': 'my_bookings',
      'acct_orders': 'my_orders',
      'acct_loyalty': 'loyalty_menu',
      'acct_invoices': 'invoice_list',
      // Natural language fallbacks
      'my bookings': 'my_bookings',
      'bookings': 'my_bookings',
      'my orders': 'my_orders',
      'orders': 'my_orders',
      'track': 'my_orders',
      'my points': 'loyalty_menu',
      'points': 'loyalty_menu',
      'loyalty': 'loyalty_menu',
      'my invoices': 'invoice_list',
      'invoices': 'invoice_list',
    };

    const targetStep = routeMap[action];
    if (targetStep) {
      // Route to the built-in handler by updating the session step directly
      await ctx.supabase.from('bot_sessions')
        .update({ current_step: targetStep })
        .eq('id', ctx.session.id);
      ctx.session.session_data._my_account_route = targetStep;
      return { valid: true, data: { _my_account_route: targetStep } };
    }

    return { valid: false, errorMessage: 'Please pick an option from the list.' };
  },

  async next(ctx: FlowContext) {
    // The session step was already updated in validate — return null to let the executor re-route
    return ctx.session.session_data._my_account_route as string || 'select_capability';
  },
};

export const capabilitySelectionFlow: FlowDefinition = {
  type: 'scheduling', // placeholder — this is a pseudo-flow
  steps: [selectCapabilityStep, myAccountMenuStep],
};

export { getFirstStepForCapability };

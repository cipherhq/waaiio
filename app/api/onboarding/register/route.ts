import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import {
  generateSlug,
  generateBotCode,
  getCitiesForCountry,
  CATEGORY_FLOW_MAP,
  DEFAULT_SERVICES,
  type BusinessCategoryKey,
  type CountryCode,
} from '@/lib/constants';
import { loadCountries, isValidCountryCode } from '@/lib/countries';
import { loadCategories, getAllCategoryKeys } from '@/lib/categoryConfig';
import { initCapabilities } from '@/lib/capabilities/service';
import type { CapabilityId } from '@/lib/capabilities/types';
import { sendEmail } from '@/lib/email/client';
import { welcomeEmail, businessRegisteredEmail } from '@/lib/email/templates';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';

export async function POST(request: NextRequest) {
  try {
    // Rate limit: max 5 registrations per IP per hour
    const rateLimit = rateLimitResponse(getRateLimitKey(request, 'onboarding-register'), 5, 3600_000);
    if (rateLimit) return rateLimit;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }

    await loadCountries();
    await loadCategories();
    const body = await request.json();
    const { first_name, last_name, name, city, state, zip_code, address, phone, category, country, bot_alias, bot_greeting, wa_method, wa_own_phone, capabilities, bot_code: customBotCode } = body;
    const countryCode: CountryCode = isValidCountryCode(country) ? country : 'NG';

    if (!name || !city || !address || !phone || !category) {
      return NextResponse.json(
        { message: 'Missing required fields: name, city, address, phone, category' },
        { status: 400 },
      );
    }

    const validCategories = getAllCategoryKeys();
    if (!validCategories.includes(category)) {
      return NextResponse.json(
        { message: 'Invalid category' },
        { status: 400 },
      );
    }

    const service = createServiceClient();

    const slug = generateSlug(name);

    // Use custom bot code if provided, otherwise auto-generate from name
    let botCode = customBotCode
      ? String(customBotCode).trim().toUpperCase().replace(/\s+/g, '-').replace(/[^A-Z0-9-]/g, '').replace(/-+/g, '-').slice(0, 30)
      : generateBotCode(name);

    // Validate minimum length
    if (botCode.length < 2) botCode = generateBotCode(name);

    // Fetch template from DB (with fallback to hardcoded constants)
    const { data: template } = await service
      .from('category_templates')
      .select('flow_type, default_services, default_greeting, metadata')
      .eq('key', category)
      .eq('is_active', true)
      .maybeSingle();

    const flowType = template?.flow_type || CATEGORY_FLOW_MAP[category as BusinessCategoryKey];

    // Handle bot_code collision
    const { data: existing } = await service
      .from('businesses')
      .select('bot_code')
      .eq('bot_code', botCode)
      .maybeSingle();

    if (existing) {
      // If user chose a custom code and it collides, reject it
      if (customBotCode) {
        return NextResponse.json(
          { message: 'Bot code is already taken. Please choose a different one.' },
          { status: 409 },
        );
      }
      // Auto-generated code collision: append suffix as fallback
      for (let i = 1; i <= 99; i++) {
        const candidate = `${botCode}-${String(i).padStart(2, '0')}`.slice(0, 30);
        const { data: collision } = await service
          .from('businesses')
          .select('bot_code')
          .eq('bot_code', candidate)
          .maybeSingle();
        if (!collision) {
          botCode = candidate;
          break;
        }
      }
    }

    // Handle slug collision
    let finalSlug = slug;
    const { data: slugExists } = await service
      .from('businesses')
      .select('slug')
      .eq('slug', slug)
      .maybeSingle();

    if (slugExists) {
      for (let i = 1; i <= 99; i++) {
        const candidate = `${slug}-${i}`;
        const { data: collision } = await service
          .from('businesses')
          .select('slug')
          .eq('slug', candidate)
          .maybeSingle();
        if (!collision) {
          finalSlug = candidate;
          break;
        }
      }
    }

    const { data: business, error: insertError } = await service
      .from('businesses')
      .insert({
        owner_id: user.id,
        name,
        slug: finalSlug,
        bot_code: botCode,
        city,
        state: state || null,
        zip_code: zip_code || null,
        address,
        phone,
        category,
        flow_type: flowType,
        country_code: countryCode,
        wa_method: wa_method || 'shared',
        subscription_tier: 'free',
        status: 'pending',
        trial_ends_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .select('id, bot_code, slug')
      .single();

    if (insertError || !business) {
      return NextResponse.json(
        { message: 'Failed to create business', error: insertError?.message },
        { status: 500 },
      );
    }

    // Create WhatsApp config — prefer DB template greeting, then user-provided, then hardcoded
    const templateGreeting = template?.default_greeting
      ? (template.default_greeting as string).replace(/\{\{name\}\}/g, name)
      : null;
    const defaultGreeting = bot_greeting || templateGreeting || getDefaultGreeting(name, category as BusinessCategoryKey);
    await service.from('whatsapp_config').insert({
      business_id: business.id,
      bot_greeting: defaultGreeting,
      bot_alias: bot_alias || null,
      auto_confirm: true,
      welcome_buttons: getDefaultWelcomeButtons(category as BusinessCategoryKey),
    });

    // Auto-create default services — prefer DB template, fall back to constants
    const defaultServices = (template?.default_services as typeof DEFAULT_SERVICES[BusinessCategoryKey]) || DEFAULT_SERVICES[category as BusinessCategoryKey] || [];
    if (defaultServices.length > 0) {
      await service.from('services').insert(
        defaultServices.map((s, i) => ({
          business_id: business.id,
          name: s.name,
          price: s.price,
          price_is_variable: s.price_is_variable,
          duration_minutes: s.duration_minutes,
          deposit_amount: s.deposit_amount,
          sort_order: i,
        })),
      );
    }

    // Auto-create capabilities
    // Priority: user-selected > template metadata > hardcoded defaults
    const templateCaps = (template?.metadata as Record<string, unknown>)?.default_capabilities as CapabilityId[] | undefined;
    const capsToInit = (capabilities as CapabilityId[] | undefined) || (templateCaps?.length ? templateCaps : undefined);
    await initCapabilities(
      service,
      business.id,
      category,
      capsToInit,
    );

    // Create default canned responses if chat capability is enabled
    const enabledCaps = capabilities as CapabilityId[] | undefined;
    if (enabledCaps?.includes('chat')) {
      const defaultCanned = [
        { title: 'Thanks for waiting', message_text: 'Thanks for your patience! How can I help you?', sort_order: 0 },
        { title: 'Operating hours', message_text: 'Our operating hours are Monday - Saturday, 9am - 6pm. We\'re closed on Sundays.', sort_order: 1 },
        { title: 'Price inquiry', message_text: 'I\'d be happy to help with pricing! Which service are you interested in?', sort_order: 2 },
        { title: 'Booking help', message_text: 'I can help you book an appointment. Would you like to proceed?', sort_order: 3 },
        { title: 'Follow up', message_text: 'Just following up on our conversation. Is there anything else I can help with?', sort_order: 4 },
      ];
      await service.from('canned_responses').insert(
        defaultCanned.map((cr) => ({
          business_id: business.id,
          ...cr,
        })),
      );
    }

    // Update profile: role + owner name
    const { data: profile } = await service
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    const isFirstBusiness = !profile?.role || profile.role === 'diner';
    const profileUpdate: Record<string, string> = {};
    if (isFirstBusiness) profileUpdate.role = 'restaurant_owner';
    if (first_name) profileUpdate.first_name = String(first_name).trim();
    if (last_name) profileUpdate.last_name = String(last_name).trim();

    if (Object.keys(profileUpdate).length > 0) {
      await service
        .from('profiles')
        .update(profileUpdate)
        .eq('id', user.id);
    }

    // Send emails (non-blocking)
    const userEmail = user.email;
    if (userEmail) {
      const categoryLabel = (category as string).replace(/_/g, ' ');
      if (isFirstBusiness) {
        const welcome = welcomeEmail(name);
        sendEmail({ to: userEmail, ...welcome }).catch(() => {});
      }
      const registered = businessRegisteredEmail(name, business.bot_code, categoryLabel);
      sendEmail({ to: userEmail, ...registered }).catch(() => {});
    }

    return NextResponse.json({
      business_id: business.id,
      bot_code: business.bot_code,
      slug: business.slug,
      category,
      flow_type: flowType,
    });
  } catch (error) {
    return NextResponse.json(
      { message: 'Internal server error', error: (error as Error).message },
      { status: 500 },
    );
  }
}

function getDefaultWelcomeButtons(category: BusinessCategoryKey): Array<{ label: string; action: string; payload?: string }> {
  switch (category) {
    case 'barber':
    case 'salon':
    case 'spa':
    case 'tattoo':
      return [
        { label: 'Book Appointment', action: 'start_flow' },
        { label: 'Chat with Us', action: 'quick_reply', payload: 'chat' },
      ];
    case 'restaurant':
    case 'food_delivery':
    case 'catering':
      return [
        { label: 'Place Order', action: 'start_flow' },
        { label: 'Book a Table', action: 'quick_reply', payload: 'book' },
      ];
    case 'church':
    case 'mosque':
      return [
        { label: 'Give / Pay', action: 'start_flow' },
        { label: 'Upcoming Events', action: 'quick_reply', payload: 'events' },
      ];
    case 'shop':
    case 'instagram_vendor':
    case 'pharmacy':
      return [
        { label: 'Browse Products', action: 'start_flow' },
        { label: 'Track Order', action: 'quick_reply', payload: 'my orders' },
      ];
    case 'events':
    case 'cinema':
      return [
        { label: 'Buy Tickets', action: 'start_flow' },
        { label: 'View Events', action: 'quick_reply', payload: 'events' },
      ];
    case 'clinic':
    case 'dental':
    case 'veterinary':
      return [
        { label: 'Book Appointment', action: 'start_flow' },
        { label: 'Chat with Us', action: 'quick_reply', payload: 'chat' },
      ];
    case 'hotel':
    case 'shortlet':
      return [
        { label: 'Book a Stay', action: 'start_flow' },
        { label: 'Check Availability', action: 'quick_reply', payload: 'book' },
      ];
    case 'gym':
      return [
        { label: 'Book Session', action: 'start_flow' },
        { label: 'My Membership', action: 'quick_reply', payload: 'my subscriptions' },
      ];
    default:
      return [
        { label: 'Get Started', action: 'start_flow' },
        { label: 'Chat with Us', action: 'quick_reply', payload: 'chat' },
      ];
  }
}

function getDefaultGreeting(name: string, category: BusinessCategoryKey): string {
  switch (category) {
    case 'restaurant':
      return `Welcome to ${name}! I can help you book a table. When would you like to dine?`;
    case 'barber':
      return `Welcome to ${name}! 💈 I can help you book an appointment. What service would you like?`;
    case 'spa':
    case 'salon':
      return `Welcome to ${name}! ✨ I can help you book a session. What would you like?`;
    case 'church':
    case 'mosque':
      return `Welcome to ${name}! 🙏 I can help you make payments. What would you like to pay for?`;
    case 'school':
      return `Welcome to ${name}! 🎓 I can help you make payments. Select a category to proceed.`;
    case 'shop':
    case 'food_delivery':
      return `Welcome to ${name}! 🛍️ Browse our products and place an order.`;
    case 'events':
      return `Welcome to ${name}! 🎪 Check out our upcoming events and get your tickets!`;
    default:
      return `Welcome to ${name}! How can I help you today?`;
  }
}

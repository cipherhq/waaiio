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

    // Validate country matches phone number to prevent fee arbitrage
    const phoneDialingCodes: Record<string, CountryCode[]> = {
      '+234': ['NG'], '+233': ['GH'], '+1': ['US', 'CA'], '+44': ['GB'],
    };
    if (phone) {
      const matchedCountries = Object.entries(phoneDialingCodes).find(([code]) => phone.startsWith(code));
      if (matchedCountries && !matchedCountries[1].includes(countryCode)) {
        return NextResponse.json(
          { message: `Phone number doesn't match selected country. A ${phone.slice(0, 4)} number should use ${matchedCountries[1].join(' or ')}.` },
          { status: 400 },
        );
      }
    }

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

    // Auto-create default appointments (calendar-based bookable items)
    const { DEFAULT_APPOINTMENTS } = await import('@/lib/constants');
    const defaultAppts = DEFAULT_APPOINTMENTS[category as BusinessCategoryKey] || [];
    if (defaultAppts.length > 0) {
      await service.from('appointments').insert(
        defaultAppts.map((a, i) => ({
          business_id: business.id,
          name: a.name,
          price: a.price,
          price_is_variable: a.price_is_variable,
          duration_minutes: a.duration_minutes,
          deposit_amount: a.deposit_amount,
          sort_order: i,
        })),
      );
    }

    // Auto-create default properties for reservation categories (shortlet, hotel, car_rental)
    const { DEFAULT_PROPERTIES, RESERVATION_CATEGORIES } = await import('@/lib/constants');
    if (RESERVATION_CATEGORIES.includes(category as BusinessCategoryKey)) {
      const defaultProps = DEFAULT_PROPERTIES[category as BusinessCategoryKey] || [];
      if (defaultProps.length > 0) {
        await service.from('properties').insert(
          defaultProps.map((p, i) => ({
            business_id: business.id,
            name: p.name,
            price: p.price,
            deposit_amount: p.deposit_amount,
            property_type: p.property_type,
            max_guests: p.max_guests,
            bedrooms: p.bedrooms,
            bathrooms: p.bathrooms,
            sort_order: i,
          })),
        );
      }
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
        { title: 'Price inquiry', message_text: 'I\'d be happy to help with pricing! What are you interested in?', sort_order: 2 },
        { title: 'How to book', message_text: 'I can help you get started. Would you like to proceed?', sort_order: 3 },
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
    case 'catering':
      return `Welcome to ${name}! 🍽️ I can help you book a table or place an order.`;
    case 'barber':
      return `Welcome to ${name}! 💈 Ready to book? What service would you like?`;
    case 'spa':
    case 'salon':
      return `Welcome to ${name}! ✨ I can help you book a session. What would you like?`;
    case 'tattoo':
      return `Welcome to ${name}! 🎨 Ready to book your session?`;
    case 'gym':
      return `Welcome to ${name}! 🏋️ Book a session or check your membership.`;
    case 'clinic':
    case 'dental':
      return `Welcome to ${name}! 🏥 I can help you schedule an appointment.`;
    case 'veterinary':
      return `Welcome to ${name}! 🐾 I can help you book an appointment for your pet.`;
    case 'church':
      return `Welcome to ${name}! 🙏 We're glad you're here. How can we serve you today?`;
    case 'mosque':
      return `Assalamu Alaikum! Welcome to ${name}. 🕌 How can we help you today?`;
    case 'school':
      return `Welcome to ${name}! 🎓 I can help you make payments. Select a category to proceed.`;
    case 'ngo':
    case 'crowdfunding_org':
      return `Welcome to ${name}! 🤝 Thank you for your support. How can we help?`;
    case 'shop':
    case 'instagram_vendor':
    case 'mall_vendor':
    case 'pharmacy':
      return `Welcome to ${name}! 🛍️ Browse our products and place an order.`;
    case 'food_delivery':
      return `Welcome to ${name}! 🛵 Ready to order? Check out our menu!`;
    case 'events':
    case 'cinema':
      return `Welcome to ${name}! 🎪 Check out our upcoming events and get your tickets!`;
    case 'event_services':
    case 'photographer':
      return `Welcome to ${name}! ✨ Select your experience and let's make your event unforgettable!`;
    case 'hotel':
    case 'shortlet':
      return `Welcome to ${name}! 🏨 I can help you book a stay. When are you visiting?`;
    case 'coworking':
      return `Welcome to ${name}! 🏢 I can help you book a space.`;
    case 'consultant':
    case 'tutor':
      return `Welcome to ${name}! 💼 I can help you schedule a session.`;
    case 'laundry':
    case 'car_wash':
      return `Welcome to ${name}! I can help you schedule a pickup or drop-off.`;
    case 'logistics':
      return `Welcome to ${name}! 🚚 I can help you ship a package.`;
    case 'transport':
      return `Welcome to ${name}! 🚌 I can help you book your trip.`;
    case 'tailor':
      return `Welcome to ${name}! ✂️ Browse our styles and place an order.`;
    case 'real_estate':
      return `Welcome to ${name}! 🏠 I can help you schedule a viewing.`;
    case 'travel_agency':
      return `Welcome to ${name}! ✈️ Ready to plan your trip?`;
    case 'nail_tech':
      return `Welcome to ${name}! 💅 Ready to book your nails?`;
    case 'mua':
      return `Welcome to ${name}! 💄 Let's get you glammed up! What look are you going for?`;
    case 'pet_grooming':
      return `Welcome to ${name}! 🐕 I can help you book a grooming session for your pet.`;
    case 'therapy':
      return `Welcome to ${name}. 🧠 I can help you schedule a session.`;
    case 'bakery':
      return `Welcome to ${name}! 🧁 Browse our treats and place an order.`;
    case 'mechanic':
      return `Welcome to ${name}! 🔧 I can help you book a service for your vehicle.`;
    case 'cleaning':
      return `Welcome to ${name}! 🧹 I can help you schedule a cleaning.`;
    case 'plumber':
      return `Welcome to ${name}! 🔌 I can help you book a service call.`;
    case 'pest_control':
      return `Welcome to ${name}! 🐜 I can help you schedule a treatment.`;
    case 'driving_school':
      return `Welcome to ${name}! 🚗 Ready to start your driving lessons?`;
    case 'music_studio':
      return `Welcome to ${name}! 🎵 I can help you book a session.`;
    case 'legal':
      return `Welcome to ${name}! ⚖️ I can help you schedule a consultation.`;
    case 'daycare':
      return `Welcome to ${name}! 👶 I can help you with payments and registration.`;
    case 'printing':
      return `Welcome to ${name}! 🖨️ Browse our services and place an order.`;
    case 'car_rental':
      return `Welcome to ${name}! 🚙 I can help you book a vehicle.`;
    case 'supermarket':
      return `Welcome to ${name}! 🛒 Browse our products and place an order.`;
    case 'security':
      return `Welcome to ${name}! 🛡️ I can help you book our services.`;
    case 'accounting':
      return `Welcome to ${name}! 📊 I can help you schedule a consultation.`;
    default:
      return `Welcome to ${name}! How can I help you today?`;
  }
}

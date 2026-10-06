import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { finalizeOnboarding } from '@/lib/onboarding/finalize';
import {
  generateSlug,
  generateBotCode,
  CATEGORY_FLOW_MAP,
  type BusinessCategoryKey,
  type CountryCode,
} from '@/lib/constants';
import { initCapabilities } from '@/lib/capabilities/service';
import type { CapabilityId } from '@/lib/capabilities/types';
import { sendEmail } from '@/lib/email/client';
import { loadPlatformSettings } from '@/lib/platformSettings';
import { welcomeEmail, businessRegisteredEmail } from '@/lib/email/templates';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { OnboardingValidationError, validateBusinessAuthorityInputs } from '@/lib/onboarding/validation';
import { OnboardingProvisionError, provisionPendingBusiness } from '@/lib/onboarding/provision-business';

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }

    // ── Signup gate: block new business creation when signup is closed ──
    const { isSignupOpen } = await import('@/lib/signup-gate');
    if (!(await isSignupOpen())) {
      return NextResponse.json(
        { message: 'Public signup is not yet open. Check back at launch.' },
        { status: 403 },
      );
    }

    const body = await request.json();
    const { first_name, last_name, name, city, state, zip_code, address, phone, category, country, bot_alias, bot_greeting, wa_method, wa_own_phone, capabilities, bot_code: customBotCode, retryBusinessId } = body;

    // ── Retry path: resume a pending business that failed capability init ──
    // Separate rate limiter keyed by authenticated user + business ID (not IP).
    // A valid retry must not depend on or consume the fresh-registration quota.
    if (retryBusinessId) {
      // Rate limit retries: max 10 per user+business per hour
      const retryKey = `onboarding-retry:${user.id}:${retryBusinessId}`;
      const retryLimit = await rateLimitResponseAsync(retryKey, 10, 3600_000);
      if (retryLimit) return retryLimit;

      const service = createServiceClient();
      const { data: pendingBiz, error: retryError } = await service
        .from('businesses')
        .select('id, owner_id, status, category, bot_code')
        .eq('id', retryBusinessId)
        .eq('owner_id', user.id)
        .eq('status', 'pending')
        .maybeSingle();

      if (retryError || !pendingBiz) {
        return NextResponse.json(
          { message: 'Cannot resume setup: business not found, not owned by you, or already active.' },
          { status: 400 },
        );
      }

      // Retry capability initialization (idempotent upsert)
      const capsToInit = (capabilities as CapabilityId[] | undefined);
      try {
        await initCapabilities(service, pendingBiz.id, pendingBiz.category, capsToInit);
      } catch (err) {
        logger.error('[ONBOARDING] Retry initCapabilities failed:', err);
        return NextResponse.json(
          { error: 'Capability setup failed on retry. Please try again.', recoverable: true, businessId: pendingBiz.id },
          { status: 500 },
        );
      }

      // Run shared finalization
      try {
        await finalizeOnboarding(service, {
          businessId: pendingBiz.id,
          userId: user.id,
          capabilities: capsToInit || [],
          firstName: body.first_name ? String(body.first_name) : undefined,
          lastName: body.last_name ? String(body.last_name) : undefined,
        });
      } catch (err) {
        logger.error('[ONBOARDING] Retry finalization failed:', err);
        return NextResponse.json(
          { error: 'Setup finalization failed. Please try again.', recoverable: true, businessId: pendingBiz.id },
          { status: 500 },
        );
      }

      return NextResponse.json({ business_id: pendingBiz.id, bot_code: pendingBiz.bot_code });
    }

    // ── Fresh registration path ──
    // Rate limit: max 5 fresh registrations per IP per hour (abuse protection)
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'onboarding-register'), 5, 3600_000);
    if (rateLimit) return rateLimit;
    // Limit businesses per user (prevent abuse) — only for fresh registration, not retry
    const svcCheck = createServiceClient();
    const { count: bizCount } = await svcCheck
      .from('businesses')
      .select('id', { count: 'exact', head: true })
      .eq('owner_id', user.id)
      .in('status', ['active', 'pending']);
    const settings = await loadPlatformSettings({ useServiceClient: true });
    if ((bizCount || 0) >= settings.max_businesses_per_user) {
      return NextResponse.json({ message: `Maximum number of businesses reached (${settings.max_businesses_per_user}). Contact support to increase.` }, { status: 400 });
    }

    if (!name || !city || !address || !phone || !category) {
      return NextResponse.json(
        { message: 'Missing required fields: name, city, address, phone, category' },
        { status: 400 },
      );
    }

    let countryCode: CountryCode;
    try {
      ({ countryCode } = await validateBusinessAuthorityInputs(svcCheck, { country, category, phone }));
    } catch (validationError) {
      if (validationError instanceof OnboardingValidationError) {
        return NextResponse.json({ message: validationError.message }, { status: validationError.status });
      }
      throw validationError;
    }

    const service = createServiceClient();
    let business: Awaited<ReturnType<typeof provisionPendingBusiness>>;
    try {
      business = await provisionPendingBusiness(service, {
        ownerId: user.id, name, city, state, zipCode: zip_code, address, phone,
        category, countryCode, customBotCode, botAlias: bot_alias, botGreeting: bot_greeting,
        capabilities: capabilities as CapabilityId[] | undefined,
        firstName: first_name ? String(first_name) : undefined,
        lastName: last_name ? String(last_name) : undefined,
      });
    } catch (error) {
      if (error instanceof OnboardingProvisionError) {
        return NextResponse.json({ message: error.message, error: error.message, recoverable: error.status >= 500, businessId: error.businessId }, { status: error.status });
      }
      throw error;
    }

    // Send emails (optional, non-blocking)
    const userEmail = user.email;
    if (userEmail) {
      const categoryLabel = (category as string).replace(/_/g, ' ');
      // Welcome email for first-time business owners
      const { data: profileCheck } = await service.from('profiles').select('role').eq('id', user.id).single();
      if (profileCheck?.role === 'restaurant_owner') {
        // Only send welcome if this was their first business (role was just set by finalization)
        const { count: bizCount2 } = await service.from('businesses').select('id', { count: 'exact', head: true }).eq('owner_id', user.id);
        if ((bizCount2 || 0) <= 1) {
          const welcome = welcomeEmail(name);
          sendEmail({ to: userEmail, ...welcome }).catch(() => {});
        }
      }
      const registered = businessRegisteredEmail(name, business.bot_code, categoryLabel);
      sendEmail({ to: userEmail, ...registered }).catch(() => {});
    }

    // Emit production-readiness event
    try {
      const { emitServerEvent } = await import('@/lib/observability/server-events');
      emitServerEvent(request, 'business.created', user.id, { business_id: business.id, entity_id: business.id, entity_type: 'business' });
    } catch { /* instrumentation must never fail registration */ }

    return NextResponse.json({
      business_id: business.id,
      bot_code: business.bot_code,
      slug: business.slug,
      category,
      flow_type: business.flowType,
      payment_ready: business.paymentReady,
      ...(!business.paymentReady ? { payment_readiness_reason: 'No payment gateway configured for this country.' } : {}),
    });
  } catch (error) {
    logger.error('Onboarding register error:', error);
    return NextResponse.json(
      { message: 'Something went wrong' },
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

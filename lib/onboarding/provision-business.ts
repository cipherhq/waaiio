import type { SupabaseClient } from '@supabase/supabase-js';
import { CATEGORY_FLOW_MAP, generateBotCode, generateSlug, type BusinessCategoryKey, type CountryCode } from '@/lib/constants';
import { initCapabilities } from '@/lib/capabilities/service';
import { finalizeOnboarding } from '@/lib/onboarding/finalize';
import type { CapabilityId } from '@/lib/capabilities/types';

export class OnboardingProvisionError extends Error {
  constructor(message: string, readonly status = 500, readonly businessId?: string) {
    super(message);
  }
}

export interface ProvisionBusinessInput {
  ownerId: string;
  name: string;
  city: string;
  state?: string;
  zipCode?: string;
  address: string;
  phone: string;
  category: string;
  countryCode: CountryCode;
  customBotCode?: string;
  botAlias?: string;
  botGreeting?: string;
  capabilities?: CapabilityId[];
  firstName?: string;
  lastName?: string;
  metadata?: Record<string, unknown>;
}

async function allocateUnique(service: SupabaseClient, column: 'slug' | 'bot_code', initial: string, maxLength: number, rejectCollision: boolean) {
  for (let suffix = 0; suffix <= 99; suffix += 1) {
    const value = suffix === 0 ? initial : `${initial.slice(0, maxLength - 3)}-${String(suffix).padStart(2, '0')}`;
    const { data, error } = await service.from('businesses').select(column).eq(column, value).maybeSingle();
    if (error) throw new OnboardingProvisionError(`Unable to validate ${column}`);
    if (!data) return value;
    if (rejectCollision) throw new OnboardingProvisionError('Bot code is already taken. Please choose a different one.', 409);
  }
  if (!rejectCollision) return `${initial.slice(0, maxLength - 6)}-${Math.random().toString(36).slice(2, 7)}`;
  throw new OnboardingProvisionError(`Unable to allocate unique ${column}`, 409);
}

export async function provisionPendingBusiness(service: SupabaseClient, input: ProvisionBusinessInput) {
  const requested = input.customBotCode
    ? input.customBotCode.trim().toUpperCase().replace(/\s+/g, '-').replace(/[^A-Z0-9-]/g, '').replace(/-+/g, '-').slice(0, 30)
    : generateBotCode(input.name);
  const initialBotCode = requested.length >= 2 ? requested : generateBotCode(input.name);
  const botCode = await allocateUnique(service, 'bot_code', initialBotCode, 30, Boolean(input.customBotCode));
  const slug = await allocateUnique(service, 'slug', generateSlug(input.name), 50, false);

  const { data: template, error: templateError } = await service.from('category_templates')
    .select('flow_type, default_greeting, metadata').eq('key', input.category).eq('is_active', true).maybeSingle();
  if (templateError) throw new OnboardingProvisionError('Unable to load category configuration');
  const flowType = template?.flow_type || CATEGORY_FLOW_MAP[input.category as BusinessCategoryKey];
  const { resolveCountryGateway } = await import('@/lib/payments/gateway-resolver');
  const gateway = await resolveCountryGateway(service, input.countryCode);

  const { data: business, error } = await service.from('businesses').insert({
    owner_id: input.ownerId,
    name: input.name,
    slug,
    bot_code: botCode,
    city: input.city,
    state: input.state || null,
    zip_code: input.zipCode || null,
    address: input.address,
    phone: input.phone,
    category: input.category,
    flow_type: flowType,
    country_code: input.countryCode,
    wa_method: 'shared',
    subscription_tier: 'free',
    status: 'pending',
    payment_gateway: gateway.gateway ?? null,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  }).select('id, bot_code, slug').single();
  if (error || !business) {
    if (error?.code === '23505') throw new OnboardingProvisionError('Business identity is already taken. Please choose another name or bot code.', 409);
    throw new OnboardingProvisionError('Failed to create business. Please try again.');
  }

  const templateGreeting = template?.default_greeting
    ? String(template.default_greeting).replace(/\{\{name\}\}/g, input.name)
    : undefined;
  const { error: configError } = await service.from('whatsapp_config').insert({
    business_id: business.id,
    bot_greeting: input.botGreeting || templateGreeting || `Welcome to ${input.name}! How can I help you today?`,
    bot_alias: input.botAlias || null,
    auto_confirm: true,
  });
  if (configError) throw new OnboardingProvisionError(`WhatsApp configuration failed: ${configError.message}`, 500, business.id);

  const templateCaps = (template?.metadata as Record<string, unknown> | null)?.default_capabilities as CapabilityId[] | undefined;
  const capabilities = input.capabilities || (templateCaps?.length ? templateCaps : undefined);
  try {
    await initCapabilities(service, business.id, input.category, capabilities);
  } catch {
    throw new OnboardingProvisionError('Capability setup failed. Please try again.', 500, business.id);
  }
  try {
    await finalizeOnboarding(service, {
      businessId: business.id,
      userId: input.ownerId,
      capabilities: capabilities || [],
      firstName: input.firstName,
      lastName: input.lastName,
    });
  } catch {
    throw new OnboardingProvisionError('Setup finalization failed. Please try again.', 500, business.id);
  }

  return { ...business, flowType, paymentReady: gateway.gateway !== null };
}

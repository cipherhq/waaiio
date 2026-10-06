import type { SupabaseClient } from '@supabase/supabase-js';
import type { CountryCode } from '@/lib/constants';
import { validateBusinessAuthorityInputs } from '@/lib/onboarding/validation';
import { provisionPendingBusiness } from '@/lib/onboarding/provision-business';
import { CAPABILITY_IDS, CAPABILITY_TIER_REQUIREMENTS, tierMeetsRequirement, type CapabilityId, type SubscriptionTier } from '@/shared/capabilities';

export interface AdminOnboardingInput {
  request_key: string;
  owner_first_name: string;
  owner_last_name: string;
  owner_email: string;
  owner_phone?: string;
  business_name: string;
  country: string;
  category: string;
  city: string;
  state?: string;
  postcode?: string;
  address: string;
  business_phone: string;
  bot_code?: string;
  intended_plan: SubscriptionTier;
  capabilities: CapabilityId[];
  whatsapp_method: 'shared' | 'dedicated' | 'coexistence';
}

function required(value: unknown, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

export async function validateAdminOnboardingInput(service: SupabaseClient, raw: Partial<AdminOnboardingInput>) {
  const input: AdminOnboardingInput = {
    request_key: required(raw.request_key, 'Request key'),
    owner_first_name: required(raw.owner_first_name, 'Owner first name'),
    owner_last_name: required(raw.owner_last_name, 'Owner last name'),
    owner_email: required(raw.owner_email, 'Owner email').toLowerCase(),
    owner_phone: String(raw.owner_phone || '').trim() || undefined,
    business_name: required(raw.business_name, 'Business name'),
    country: required(raw.country, 'Country').toUpperCase(),
    category: required(raw.category, 'Category'),
    city: required(raw.city, 'City'),
    state: String(raw.state || '').trim() || undefined,
    postcode: String(raw.postcode || '').trim() || undefined,
    address: required(raw.address, 'Address'),
    business_phone: required(raw.business_phone, 'Business phone'),
    bot_code: String(raw.bot_code || '').trim() || undefined,
    intended_plan: raw.intended_plan || 'free',
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities : [],
    whatsapp_method: raw.whatsapp_method || 'shared',
  };

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.owner_email)) throw new Error('Owner email is invalid');
  if (!['free', 'growth', 'business'].includes(input.intended_plan)) throw new Error('Starting plan is invalid');
  if (!['shared', 'dedicated', 'coexistence'].includes(input.whatsapp_method)) throw new Error('WhatsApp method is invalid');
  if (input.capabilities.some(capability => !CAPABILITY_IDS.includes(capability))) throw new Error('A capability is invalid');
  if (input.capabilities.some(capability => !tierMeetsRequirement(input.intended_plan, CAPABILITY_TIER_REQUIREMENTS[capability]))) {
    throw new Error('Selected capabilities exceed the intended plan');
  }

  await validateBusinessAuthorityInputs(service, { country: input.country, category: input.category, phone: input.business_phone });
  if (input.owner_phone) await validateBusinessAuthorityInputs(service, { country: input.country, category: input.category, phone: input.owner_phone });
  return input;
}

export async function provisionAdminBusiness(service: SupabaseClient, input: AdminOnboardingInput, userId: string, onboardingId: string) {
  // Admin plan selection is intent, never entitlement. Only free-tier capabilities
  // are materialized before the customer completes canonical paid activation.
  const provisionedCapabilities = input.capabilities.filter(capability => tierMeetsRequirement('free', CAPABILITY_TIER_REQUIREMENTS[capability]));
  const business = await provisionPendingBusiness(service, {
    ownerId: userId, name: input.business_name, city: input.city, state: input.state,
    zipCode: input.postcode, address: input.address, phone: input.business_phone,
    category: input.category, countryCode: input.country as CountryCode,
    customBotCode: input.bot_code, capabilities: provisionedCapabilities,
    firstName: input.owner_first_name, lastName: input.owner_last_name,
    metadata: { admin_onboarding_id: onboardingId, intended_plan: input.intended_plan, requested_capabilities: input.capabilities, requested_whatsapp_method: input.whatsapp_method },
  });
  if (input.owner_phone) {
    const { error: profileError } = await service.from('profiles').update({ phone: input.owner_phone }).eq('id', userId);
    if (profileError) throw new Error(`Owner profile failed: ${profileError.message}`);
  }
  return business;
}

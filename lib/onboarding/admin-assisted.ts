import type { SupabaseClient } from '@supabase/supabase-js';
import type { CountryCode } from '@/lib/constants';
import { validateBusinessAuthorityInputs } from '@/lib/onboarding/validation';
import { OnboardingProvisionError, provisionPendingBusiness } from '@/lib/onboarding/provision-business';
import { CAPABILITY_IDS, type CapabilityId, type SubscriptionTier } from '@/shared/capabilities';
import { FEATURES_REQUIRED, WHATSAPP_NAME_TOO_SHORT, fullPhoneNumberMessage, normalizeFullPhoneNumber, normalizeWhatsAppName } from '@/shared/onboarding-fields';

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

/**
 * `newRequest` applies the Get Started required fields (Owner request 2026-11-18):
 * WhatsApp Name, at least one feature and the full business phone number. It is
 * set by create only. Retry re-validates the stored input of an earlier request,
 * which may predate these rules, so retry keeps the original checks.
 */
export async function validateAdminOnboardingInput(service: SupabaseClient, raw: Partial<AdminOnboardingInput>, { newRequest = false }: { newRequest?: boolean } = {}) {
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
    // De-duplicated: one capability row each (a repeated id would fail the upsert).
    capabilities: Array.isArray(raw.capabilities) ? [...new Set(raw.capabilities)] : [],
    whatsapp_method: raw.whatsapp_method || 'shared',
  };

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.owner_email)) throw new Error('Owner email is invalid');
  if (!['free', 'growth', 'business'].includes(input.intended_plan)) throw new Error('Starting plan is invalid');
  if (!['shared', 'dedicated', 'coexistence'].includes(input.whatsapp_method)) throw new Error('WhatsApp method is invalid');
  if (input.capabilities.some(capability => !CAPABILITY_IDS.includes(capability))) throw new Error('A capability is invalid');

  if (newRequest) await applyGetStartedRequiredFields(service, input, raw);

  await validateBusinessAuthorityInputs(service, { country: input.country, category: input.category, phone: input.business_phone });
  if (input.owner_phone) await validateBusinessAuthorityInputs(service, { country: input.country, category: input.category, phone: input.owner_phone });
  return input;
}

async function applyGetStartedRequiredFields(service: SupabaseClient, input: AdminOnboardingInput, raw: Partial<AdminOnboardingInput>) {
  required(raw.bot_code, 'WhatsApp Name');
  const botCode = normalizeWhatsAppName(raw.bot_code);
  if (botCode.length < 2) throw new Error(WHATSAPP_NAME_TOO_SHORT);
  input.bot_code = botCode;
  if (!input.capabilities.length) throw new Error(FEATURES_REQUIRED);

  const { data: country, error } = await service.from('countries').select('dialing_code, phone_digits')
    .eq('code', input.country).eq('is_active', true).maybeSingle();
  if (error) throw new Error('Country configuration unavailable. Please try again later.');
  if (!country) throw new Error('Invalid or unsupported country. Please select a valid country.');
  const dialingCode = String(country.dialing_code || '');
  const phoneDigits = Number(country.phone_digits) || 10;
  const phone = normalizeFullPhoneNumber(input.business_phone, dialingCode, phoneDigits);
  if (!phone) throw new Error(fullPhoneNumberMessage(dialingCode, phoneDigits));
  input.business_phone = phone;
}

/**
 * Create calls this after its repeated-request lookup and before the invite is
 * created, so a taken name never leaves a failed record and a repeat of a
 * request that already succeeded still returns that record.
 */
export async function assertWhatsAppNameAvailable(service: SupabaseClient, botCode: string) {
  const { data: taken, error } = await service.from('businesses').select('id').eq('bot_code', botCode).maybeSingle();
  if (error) throw new Error('Unable to check the WhatsApp Name. Please try again.');
  if (taken) throw new Error('Bot code is already taken. Please choose a different one.');
}

export async function provisionAdminBusiness(service: SupabaseClient, input: AdminOnboardingInput, userId: string, onboardingId: string) {
  // Admin plan selection is intent, never entitlement: the business is created
  // on Free exactly like Get Started. Every selected capability is saved, as
  // Get Started does; higher-plan ones run under the 14-day Pro/Premium trial
  // (feature_trial_ends_at, set at insert); access is decided by
  // getEffectiveCapabilities in lib/capabilities/policy.ts (dashboard, bot menu,
  // API guards, bot pre-creation checks). Some older paths still read the raw
  // rows, as they already do for Get Started businesses.
  // An empty selection falls back to the category defaults.
  const provisionedCapabilities = input.capabilities.length ? input.capabilities : undefined;
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
    if (profileError) {
      throw new OnboardingProvisionError(`Owner profile failed: ${profileError.message}`, 500, business.id);
    }
  }
  return business;
}

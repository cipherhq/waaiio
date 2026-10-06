import type { SupabaseClient } from '@supabase/supabase-js';
import { loadCategories, getAllCategoryKeys } from '@/lib/categoryConfig';
import type { CountryCode } from '@/lib/constants';

export class OnboardingValidationError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

export async function validateBusinessAuthorityInputs(
  service: SupabaseClient,
  input: { country: unknown; category: unknown; phone?: unknown },
) {
  await loadCategories();
  const country = String(input.country || '').trim().toUpperCase();
  const category = String(input.category || '').trim();
  const phone = String(input.phone || '').trim();
  const { data: activeCountries, error } = await service.from('countries').select('code, dialing_code').eq('is_active', true);
  if (error || !activeCountries?.length) throw new OnboardingValidationError('Country configuration unavailable. Please try again later.', 503);
  if (!activeCountries.some(row => row.code === country)) throw new OnboardingValidationError('Invalid or unsupported country. Please select a valid country.');
  if (!getAllCategoryKeys().includes(category)) throw new OnboardingValidationError('Invalid category');

  if (phone) {
    const matches = activeCountries.filter(row => row.dialing_code && phone.startsWith(String(row.dialing_code)));
    if (matches.length > 0 && !matches.some(row => row.code === country)) {
      throw new OnboardingValidationError(`Phone number doesn't match selected country. A ${phone.slice(0, 4)} number should use ${matches.map(row => row.code).join(' or ')}.`);
    }
  }
  return { countryCode: country as CountryCode, category, activeCountries };
}

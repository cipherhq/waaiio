import { getCategoryList } from '@/lib/categoryConfig';
import { CATEGORY_DEFAULT_CAPABILITIES, CAPABILITY_MAP } from '@/lib/capabilities/types';
import { newPasswordProblem } from '@/lib/password-policy';

function categoryAndCountryLists() {
  const categories = getCategoryList()
    .filter(c => c.key !== 'other')
    .map(c => ({ id: c.key, title: c.label }));

  const countries = [
    { id: 'NG', title: '🇳🇬 Nigeria' },
    { id: 'US', title: '🇺🇸 United States' },
    { id: 'CA', title: '🇨🇦 Canada' },
    { id: 'GB', title: '🇬🇧 United Kingdom' },
    { id: 'GH', title: '🇬🇭 Ghana' },
  ];
  return { categories, countries };
}

/**
 * Handle data_exchange requests for the WhatsApp Flows onboarding flow.
 *
 * INIT → returns category and country lists for the BUSINESS_DETAILS screen.
 * OWNER_DETAILS → checks the password length (#1175 Q13 A): too short stays
 *   on the screen with W3; otherwise moves on to BUSINESS_DETAILS.
 * BUSINESS_DETAILS → returns capabilities for the selected category.
 */
export function handleOnboardingDataExchange(
  action: string,
  screen: string | null,
  data: Record<string, unknown>,
): Record<string, unknown> {
  // INIT — return category and country lists
  if (action === 'INIT' || !screen) {
    return {
      screen: 'WELCOME',
      data: categoryAndCountryLists(),
    };
  }

  // OWNER_DETAILS → BUSINESS_DETAILS, unless the password is too short.
  // Only the length is checked here; a password known from breach lists is
  // refused by Supabase when the account is created at the end.
  if (screen === 'OWNER_DETAILS') {
    const password = typeof data.password === 'string' ? data.password : '';
    const problem = newPasswordProblem(password);
    if (problem) {
      return { screen: 'OWNER_DETAILS', data: { password_error: problem } };
    }
    return { screen: 'BUSINESS_DETAILS', data: categoryAndCountryLists() };
  }

  // BUSINESS_DETAILS → FEATURES: return capabilities for selected category
  if (screen === 'BUSINESS_DETAILS' || screen === 'FEATURES') {
    const category = (data.category as string) || 'other';
    const defaults = CATEGORY_DEFAULT_CAPABILITIES[category] || ['scheduling'];

    // Filter out background/system capabilities that shouldn't be user-facing toggles
    const systemCaps = [
      'reminders', 'feedback', 'loyalty', 'referral', 'reports', 'staff',
      'whatsapp_sign', 'survey', 'poll', 'broadcast', 'recurring', 'auto_reply', 'membership',
    ];
    const capOptions = defaults
      .filter(c => !systemCaps.includes(c))
      .map(c => ({
        id: c,
        // Tables & Sections uses its product name; other options keep their generated title.
        title: c === 'table_reservation'
          ? CAPABILITY_MAP.table_reservation.label
          : c.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      }));

    return {
      screen: 'FEATURES',
      data: { capabilities: capOptions, category },
    };
  }

  // Default
  return { screen: screen || 'WELCOME', data: {} };
}

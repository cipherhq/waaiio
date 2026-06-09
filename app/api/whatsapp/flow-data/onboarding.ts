import { getCategoryList } from '@/lib/categoryConfig';
import { CATEGORY_DEFAULT_CAPABILITIES } from '@/lib/capabilities/types';

/**
 * Handle data_exchange requests for the WhatsApp Flows onboarding flow.
 *
 * INIT → returns category and country lists for the BUSINESS_DETAILS screen.
 * BUSINESS_DETAILS → returns capabilities for the selected category.
 */
export function handleOnboardingDataExchange(
  action: string,
  screen: string | null,
  data: Record<string, unknown>,
): Record<string, unknown> {
  // INIT — return category and country lists
  if (action === 'INIT' || !screen) {
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

    return {
      screen: 'WELCOME',
      data: { categories, countries },
    };
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
        title: c.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      }));

    return {
      screen: 'FEATURES',
      data: { capabilities: capOptions, category },
    };
  }

  // Default
  return { screen: screen || 'WELCOME', data: {} };
}

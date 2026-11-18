/**
 * Get Started field rules shared by the admin "Onboard Customer" page and its
 * server route (Owner request 2026-11-18: same required fields as Get Started).
 * Consumed by both the root Next.js app and the Admin Vite app.
 */

/** Same clean-up Get Started applies as the WhatsApp Name is typed (OnboardingWizard handleBotCodeChange). */
export function normalizeWhatsAppName(value: unknown): string {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '-').replace(/[^A-Z0-9-]/g, '').replace(/-+/g, '-').slice(0, 30);
}

export const WHATSAPP_NAME_REQUIRED = 'WhatsApp Name is required';
export const WHATSAPP_NAME_TOO_SHORT = 'WhatsApp Name must be at least 2 letters or numbers';
export const FEATURES_REQUIRED = 'Please select at least one feature to continue';

export function fullPhoneNumberMessage(dialingCode: string, phoneDigits: number): string {
  return `Business phone must be the full number: ${dialingCode} followed by ${phoneDigits} digits`;
}

/**
 * Get Started's phone field (PhoneInput) only produces the country dialing code
 * followed by exactly that country's phone_digits digits. Spaces, dots, dashes
 * and brackets are ignored. Returns the normalized number, or null when it does
 * not have that shape.
 */
export function normalizeFullPhoneNumber(value: unknown, dialingCode: string, phoneDigits: number): string | null {
  const phone = String(value || '').replace(/[\s().-]/g, '');
  const localDigits = phone.slice(dialingCode.length);
  if (!dialingCode || !phone.startsWith(dialingCode) || localDigits.length !== phoneDigits || !/^\d+$/.test(localDigits)) return null;
  return phone;
}

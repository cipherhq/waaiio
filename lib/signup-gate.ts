/**
 * Public signup gate — admin-controlled via platform_settings.signup_open.
 *
 * When signup is closed:
 * - New public account creation is blocked at every server-side boundary
 * - Existing users can still log in and operate
 * - Staging/UAT bypasses via explicit isStagingTestMode() check
 *
 * When signup is open:
 * - Normal signup/onboarding flows work as designed
 *
 * Missing/invalid signup_open defaults to CLOSED (fail-closed for production).
 */
import { createServiceClient } from '@/lib/supabase/service';
import { isStagingTestMode } from '@/lib/staging-test-mode';

// ── Cache ──
let signupOpenCache: { value: boolean; expiresAt: number } | null = null;
const CACHE_TTL = 30_000; // 30 seconds

/**
 * Check whether public signup is currently open.
 *
 * Uses a 30-second cache to avoid DB hits on every request.
 * Staging environments always return true (bypass via isStagingTestMode).
 * Missing/invalid setting → false (fail-closed).
 */
export async function isSignupOpen(): Promise<boolean> {
  // Staging bypass — explicit trusted environment check, not hostname
  if (isStagingTestMode()) return true;

  if (signupOpenCache && Date.now() < signupOpenCache.expiresAt) {
    return signupOpenCache.value;
  }

  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from('platform_settings')
      .select('value')
      .eq('key', 'signup_open')
      .single();

    if (error || data === null) {
      // Missing setting → fail closed
      signupOpenCache = { value: false, expiresAt: Date.now() + CACHE_TTL };
      return false;
    }

    const isOpen = data.value === true;
    signupOpenCache = { value: isOpen, expiresAt: Date.now() + CACHE_TTL };
    return isOpen;
  } catch {
    // DB error → fail closed
    signupOpenCache = { value: false, expiresAt: Date.now() + CACHE_TTL };
    return false;
  }
}

/** Clear the signup gate cache — call after admin changes signup_open */
export function invalidateSignupGateCache(): void {
  signupOpenCache = null;
}

/** Sync check for client-side: is signup_open available from a preloaded value */
export function isSignupOpenSync(preloaded?: boolean): boolean {
  if (isStagingTestMode()) return true;
  if (typeof preloaded === 'boolean') return preloaded;
  return signupOpenCache?.value ?? false;
}

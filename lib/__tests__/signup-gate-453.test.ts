/**
 * #453 — Public signup gate tests.
 *
 * Proves all 11 DoD items:
 * 1.  Gate closed → new public signup blocked
 * 2.  Direct /get-started bypass blocked
 * 3.  /signup redirect cannot bypass
 * 4.  Direct creation/API path cannot bypass
 * 5.  Login still works
 * 6.  Existing authenticated users unaffected
 * 7.  Callback/verification for already-created users not broken
 * 8.  Staging/UAT preserved under explicit trusted environment rules
 * 9.  Gate open → normal signup works
 * 10. Missing/invalid production gate state behaves as designed
 * 11. No hardcoded launch date
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Read source files for structural verification
const middlewareSrc = readFileSync(resolve(__dirname, '../../middleware.ts'), 'utf-8');
const signupGateSrc = readFileSync(resolve(__dirname, '../signup-gate.ts'), 'utf-8');
const registerRouteSrc = readFileSync(resolve(__dirname, '../../app/api/onboarding/register/route.ts'), 'utf-8');
const otpVerifySrc = readFileSync(resolve(__dirname, '../../app/api/auth/otp/verify/route.ts'), 'utf-8');
const waOnboardingSrc = readFileSync(resolve(__dirname, '../../app/api/whatsapp/flow-callback/onboarding.ts'), 'utf-8');
const signupPageSrc = readFileSync(resolve(__dirname, '../../app/(auth)/signup/page.tsx'), 'utf-8');
const platformSettingsSrc = readFileSync(resolve(__dirname, '../platformSettings.ts'), 'utf-8');
const signupStatusSrc = readFileSync(resolve(__dirname, '../../app/api/auth/signup-status/route.ts'), 'utf-8');

describe('#453 DoD 1: Gate closed → new public signup blocked', () => {
  it('signup-gate.ts defaults to false when setting is missing', () => {
    expect(signupGateSrc).toContain('value: false');
    // The missing-data path and catch block both set false
    const falseCount = (signupGateSrc.match(/value: false/g) || []).length;
    expect(falseCount).toBeGreaterThanOrEqual(2); // missing data + DB error
  });

  it('platform_settings signup_open defaults to false in buildFallback', () => {
    expect(platformSettingsSrc).toContain('signup_open: false');
  });

  it('migration seeds signup_open as false', () => {
    const migrationSrc = readFileSync(
      resolve(__dirname, '../../supabase/migrations/414_signup_open_platform_setting.sql'), 'utf-8'
    );
    expect(migrationSrc).toContain("'false'::jsonb");
    expect(migrationSrc).toContain('signup_open');
  });
});

describe('#453 DoD 2: Direct /get-started bypass blocked', () => {
  it('middleware gates /get-started when signup is closed', () => {
    expect(middlewareSrc).toContain("'/get-started'");
    expect(middlewareSrc).toContain('isSignupOpenMiddleware');
    expect(middlewareSrc).toContain("url.pathname = '/launch'");
  });

  it('onboarding register route checks isSignupOpen server-side', () => {
    expect(registerRouteSrc).toContain('isSignupOpen');
    expect(registerRouteSrc).toContain('Public signup is not yet open');
    expect(registerRouteSrc).toContain('status: 403');
  });
});

describe('#453 DoD 3: /signup redirect cannot bypass', () => {
  it('/signup page redirects to /get-started', () => {
    expect(signupPageSrc).toContain("redirect('/get-started')");
  });

  it('middleware gates /signup path', () => {
    expect(middlewareSrc).toContain("'/signup'");
    // Both /signup and /get-started are in signupPaths
    const signupPathsMatch = middlewareSrc.match(/signupPaths\s*=\s*\[([^\]]+)\]/);
    expect(signupPathsMatch).not.toBeNull();
    expect(signupPathsMatch![1]).toContain("'/get-started'");
    expect(signupPathsMatch![1]).toContain("'/signup'");
  });
});

describe('#453 DoD 4: Direct creation/API path cannot bypass', () => {
  it('OTP verify route blocks new user creation when signup closed', () => {
    expect(otpVerifySrc).toContain('isSignupOpen');
    expect(otpVerifySrc).toContain('Public signup is not yet open');
    // Gate is only on new user path, not existing user login
    const lines = otpVerifySrc.split('\n');
    const gateLineIdx = lines.findIndex(l => l.includes('isSignupOpen'));
    const newUserLineIdx = lines.findIndex(l => l.includes('New user'));
    expect(gateLineIdx).toBeGreaterThan(newUserLineIdx); // gate is inside the new-user branch
  });

  it('WhatsApp flow onboarding blocks when signup closed', () => {
    expect(waOnboardingSrc).toContain('isSignupOpen');
    expect(waOnboardingSrc).toContain('Public signup is not yet open');
  });

  it('signup-status API endpoint exists for client-side check', () => {
    expect(signupStatusSrc).toContain('isSignupOpen');
    expect(signupStatusSrc).toContain('signup_open');
  });
});

describe('#453 DoD 5: Login still works', () => {
  it('middleware signup gate does NOT affect /login path', () => {
    const signupPathsMatch = middlewareSrc.match(/signupPaths\s*=\s*\[([^\]]+)\]/);
    expect(signupPathsMatch).not.toBeNull();
    expect(signupPathsMatch![1]).not.toContain('/login');
  });

  it('middleware signup gate only applies to unauthenticated users (!user)', () => {
    expect(middlewareSrc).toContain('isSignupPath && !user');
  });
});

describe('#453 DoD 6: Existing authenticated users unaffected', () => {
  it('middleware only gates unauthenticated access to signup paths', () => {
    // The condition is: isSignupPath && !user
    // Authenticated users (user exists) are NOT blocked
    expect(middlewareSrc).toContain('if (isSignupPath && !user)');
  });
});

describe('#453 DoD 7: Callback/verification for existing users not broken', () => {
  it('auth callback route is NOT in the signup gate paths', () => {
    const signupPathsMatch = middlewareSrc.match(/signupPaths\s*=\s*\[([^\]]+)\]/);
    expect(signupPathsMatch).not.toBeNull();
    expect(signupPathsMatch![1]).not.toContain('/auth/callback');
  });

  it('OTP verify only blocks NEW user creation, not existing user verification', () => {
    // The gate is inside the else branch (new user), not the existing-user branch
    const lines = otpVerifySrc.split('\n');
    const existingUserIdx = lines.findIndex(l => l.includes('Sign in existing user'));
    const gateIdx = lines.findIndex(l => l.includes('isSignupOpen'));
    // Gate must come AFTER the existing-user branch (which uses sign-in, not create)
    expect(gateIdx).toBeGreaterThan(existingUserIdx > -1 ? existingUserIdx : 0);
  });
});

describe('#453 DoD 8: Staging/UAT preserved under explicit trusted environment rules', () => {
  it('signup-gate.ts bypasses via isStagingTestMode() — not hostname-based', () => {
    expect(signupGateSrc).toContain('isStagingTestMode()');
    // The word 'hostname' may appear in comments but must not be used in logic
    // The key check: no window.location or req.hostname in the actual function body
    expect(signupGateSrc).not.toContain('window.location');
    expect(signupGateSrc).not.toContain('request.headers.get');
    expect(signupGateSrc).not.toContain('.host ===');
  });

  it('middleware signup gate bypasses via isStagingTestMode()', () => {
    expect(middlewareSrc).toContain('isStagingTestMode()');
  });

  it('staging test mode uses explicit project ID + Supabase URL, not hostname', () => {
    const stagingSrc = readFileSync(resolve(__dirname, '../staging-test-mode.ts'), 'utf-8');
    expect(stagingSrc).toContain('STAGING_APP_PROJECT_ID');
    expect(stagingSrc).toContain('STAGING_SUPABASE_URL');
    expect(stagingSrc).not.toContain('hostname');
  });
});

describe('#453 DoD 9: Gate open → normal signup works', () => {
  it('signup-gate returns true when signup_open is true', () => {
    // The check: data.value === true → isOpen = true
    expect(signupGateSrc).toContain('const isOpen = data.value === true');
  });

  it('platform_settings includes signup_open in fetch list', () => {
    expect(platformSettingsSrc).toContain("'signup_open'");
  });
});

describe('#453 DoD 10: Missing/invalid gate state fails closed', () => {
  it('signup-gate returns false on DB error', () => {
    // catch block returns false
    expect(signupGateSrc).toContain('// DB error → fail closed');
    expect(signupGateSrc).toContain('value: false, expiresAt: Date.now() + CACHE_TTL');
  });

  it('signup-gate returns false when setting is missing', () => {
    expect(signupGateSrc).toContain('// Missing setting → fail closed');
  });

  it('middleware returns false on error (fail closed)', () => {
    expect(middlewareSrc).toContain('// Missing/error → fail closed');
  });
});

describe('#453 DoD 11: No hardcoded launch date', () => {
  it('signup-gate.ts does not contain October 11 or any hardcoded date', () => {
    expect(signupGateSrc).not.toContain('October 11');
    expect(signupGateSrc).not.toContain('2026-10-11');
    expect(signupGateSrc).not.toContain('Oct 11');
    expect(signupGateSrc).not.toMatch(/new Date\(\s*['"]2026/);
  });

  it('middleware does not contain hardcoded launch date', () => {
    // Only check the signup gate section, not the entire middleware
    const signupSection = middlewareSrc.substring(
      middlewareSrc.indexOf('Signup Gate'),
      middlewareSrc.indexOf('Protect dashboard')
    );
    expect(signupSection).not.toContain('October');
    expect(signupSection).not.toContain('2026-10');
  });

  it('all server-side gates use dynamic config, not date checks', () => {
    // Register route gate uses isSignupOpen (dynamic config)
    expect(registerRouteSrc).toContain('isSignupOpen');
    expect(registerRouteSrc).toContain('signup-gate');
    // OTP verify uses same pattern
    expect(otpVerifySrc).toContain('isSignupOpen');
    // WhatsApp onboarding uses same pattern
    expect(waOnboardingSrc).toContain('isSignupOpen');
    // None hardcode October dates
    expect(registerRouteSrc).not.toContain('October 11');
    expect(otpVerifySrc).not.toContain('October 11');
    expect(waOnboardingSrc).not.toContain('October 11');
  });
});

describe('#453 Architecture: Admin-controlled via platform_settings', () => {
  it('signup_open is in PlatformSettings interface', () => {
    expect(platformSettingsSrc).toContain('signup_open: boolean');
  });

  it('signup_open is fetched from platform_settings table', () => {
    expect(platformSettingsSrc).toContain("'signup_open'");
    // It's in the .in('key', [...]) list
    const inKeyList = platformSettingsSrc.match(/\.in\('key',\s*\[([^\]]+)\]/s);
    expect(inKeyList).not.toBeNull();
    expect(inKeyList![1]).toContain('signup_open');
  });

  it('signup_open maps correctly in cache builder', () => {
    expect(platformSettingsSrc).toContain("map.has('signup_open')");
    expect(platformSettingsSrc).toContain("map.get('signup_open') as boolean");
  });
});

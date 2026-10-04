import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const cookieConsentSource = readFileSync(
  resolve(__dirname, '../../components/marketing/CookieConsent.tsx'),
  'utf-8'
);

describe('#535 mobile cookie consent sizing', () => {
  it('uses compact mobile container spacing while preserving desktop spacing', () => {
    expect(cookieConsentSource).toContain('px-3 py-3 shadow-lg sm:px-6 sm:py-4');
    expect(cookieConsentSource).toContain('gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4');
  });

  it('uses smaller mobile copy and action buttons while preserving desktop sizes', () => {
    expect(cookieConsentSource).toContain('text-xs leading-relaxed text-gray-300 sm:text-sm');
    expect(cookieConsentSource).toContain('gap-2 sm:gap-3');
    expect(cookieConsentSource).toContain('px-3 py-1.5 text-xs');
    expect(cookieConsentSource).toContain('sm:px-4 sm:py-2 sm:text-sm');
  });

  it('keeps all consent actions and behavior available', () => {
    expect(cookieConsentSource).toContain('Customize');
    expect(cookieConsentSource).toContain('Reject Non-Essential');
    expect(cookieConsentSource).toContain('Accept All');
    expect(cookieConsentSource).toContain('Save Preferences');
    expect(cookieConsentSource).toContain('onClick={acceptAll}');
    expect(cookieConsentSource).toContain('onClick={rejectNonEssential}');
  });
});

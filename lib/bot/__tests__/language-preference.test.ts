import { describe, expect, it, vi } from 'vitest';
import type { LanguageEntitlement } from '../language-policy';
import {
  parseLanguagePreferenceIntent,
  readPreferredResponseLanguage,
  resolveEffectiveResponseLanguage,
  writePreferredResponseLanguage,
} from '../language-preference';

const CERTIFIED = ['en', 'fr', 'yo'] as const;

function entitlement(
  allowedLanguages: string[] = ['en', 'fr', 'yo'],
  translationAllowed = true,
): LanguageEntitlement {
  return { allowedLanguages, llmAllowed: translationAllowed, translationAllowed };
}

describe('language preference intent boundaries', () => {
  it.each([
    ['use English', 'en'],
    ['use Nigerian Pidgin', 'pcm'],
    ['use Naijá', 'pcm'],
    ['use Naija', 'pcm'],
    ['use Yorùbá', 'yo'],
    ['use Yoruba', 'yo'],
    ['use Igbo', 'ig'],
    ['use Hausa', 'ha'],
    ['use Akan', 'tw'],
    ['use Français', 'fr'],
    ['use Español', 'es'],
    ['use Francais', 'fr'],
    ['use Espanol', 'es'],
  ])('accepts an explicit preference using catalog alias: %s', (text, language) => {
    expect(parseLanguagePreferenceIntent(text)).toEqual({
      language,
      persistence: 'session',
    });
  });

  it.each([
    ['always use French', 'fr'],
    ['reply to me in Yoruba from now on', 'yo'],
  ])('classifies an explicit durable choice: %s', (text, language) => {
    expect(parseLanguagePreferenceIntent(text)).toEqual({
      language,
      persistence: 'persistent',
    });
  });

  it.each([
    ['speak French', 'fr'],
    ['switch to Yoruba', 'yo'],
    ['use French for now', 'fr'],
  ])('keeps an ordinary language switch session-only: %s', (text, language) => {
    expect(parseLanguagePreferenceIntent(text)).toEqual({
      language,
      persistence: 'session',
    });
  });

  it.each([
    'bonjour, I want to book',
    'je veux commander',
    'mo fe book appointment',
    'English please',
    'use English please',
    'please switch to French',
  ])
    ('does not turn passive language evidence into a preference: %s', text => {
      expect(parseLanguagePreferenceIntent(text)).toBeNull();
    });
});

describe('effective response-language authority', () => {
  it('gives a valid session override precedence over a remembered preference', () => {
    expect(resolveEffectiveResponseLanguage({
      sessionLanguage: 'yo',
      rememberedLanguage: 'fr',
      entitlement: entitlement(),
      certifiedLanguages: CERTIFIED,
    })).toEqual({ language: 'yo', source: 'session', shouldOfferRemembered: false });
  });

  it('uses a remembered preference only as a default after authoritative business entitlement is supplied', () => {
    expect(resolveEffectiveResponseLanguage({
      rememberedLanguage: 'fr',
      entitlement: entitlement(),
      certifiedLanguages: CERTIFIED,
    })).toEqual({ language: 'fr', source: 'remembered', shouldOfferRemembered: true });
  });

  it.each([
    ['malformed', 'not-a-language', entitlement()],
    ['unsupported', 'de', entitlement(['en', 'de'])],
    ['unentitled', 'fr', entitlement(['en'])],
    ['uncertified', 'fr', entitlement(['en', 'fr'])],
  ])('fails closed to English for a %s remembered preference', (_case, rememberedLanguage, policy) => {
    expect(resolveEffectiveResponseLanguage({
      rememberedLanguage,
      entitlement: policy,
      certifiedLanguages: ['en'],
    })).toEqual({ language: 'en', source: 'fallback', shouldOfferRemembered: false });
  });

  it.each([
    { allowedLanguages: ['en'], llmAllowed: false, translationAllowed: false },
    { allowedLanguages: ['en', 'fr'], llmAllowed: false, translationAllowed: false },
  ] satisfies LanguageEntitlement[])('cannot activate paid output for Free or fail-closed tier policy', policy => {
    expect(resolveEffectiveResponseLanguage({
      explicitLanguage: 'fr',
      sessionLanguage: 'fr',
      rememberedLanguage: 'fr',
      entitlement: policy,
      certifiedLanguages: CERTIFIED,
    })).toEqual({ language: 'en', source: 'fallback', shouldOfferRemembered: false });
  });

  it('keeps inbound message language separate from the chosen response language', () => {
    const result = resolveEffectiveResponseLanguage({
      strongSignalLanguage: 'yo',
      rememberedLanguage: 'fr',
      entitlement: entitlement(),
      certifiedLanguages: CERTIFIED,
    });

    expect(result).toEqual({ language: 'fr', source: 'remembered', shouldOfferRemembered: true });
  });

  it('does not select or mutate business identity or capabilities', () => {
    const authority = {
      businessId: 'business-authoritatively-routed',
      capabilities: Object.freeze({ payments: false, bookings: true }),
    };
    const before = structuredClone(authority);

    resolveEffectiveResponseLanguage({
      rememberedLanguage: 'fr',
      entitlement: entitlement(),
      certifiedLanguages: CERTIFIED,
      ...authority,
    } as Parameters<typeof resolveEffectiveResponseLanguage>[0]);

    expect(authority).toEqual(before);
  });
});

describe('server-only profile preference persistence', () => {
  it('reads only the preference from the already-resolved canonical profile', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: { preferred_response_language: 'fr' },
      error: null,
    });
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));

    await expect(readPreferredResponseLanguage({ from } as never, 'profile-123'))
      .resolves.toBe('fr');
    expect(from).toHaveBeenCalledWith('profiles');
    expect(select).toHaveBeenCalledWith('preferred_response_language');
    expect(eq).toHaveBeenCalledWith('id', 'profile-123');
    expect(from).not.toHaveBeenCalledWith('businesses');
  });

  it.each([
    ['query rejection', () => {
      const maybeSingle = vi.fn().mockRejectedValue(new Error('database unavailable'));
      return { from: vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) })) })) };
    }],
    ['synchronous client failure', () => ({
      from: vi.fn(() => { throw new Error('client unavailable'); }),
    })],
  ])('fails closed to no preference on %s', async (_case, makeClient) => {
    await expect(readPreferredResponseLanguage(makeClient() as never, 'profile-123'))
      .resolves.toBeNull();
  });

  it('writes only a supported explicit persistent choice to the canonical profile', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ update }));

    await expect(writePreferredResponseLanguage({ from } as never, 'profile-123', 'fr'))
      .resolves.toBeUndefined();
    expect(from).toHaveBeenCalledWith('profiles');
    expect(update).toHaveBeenCalledWith({ preferred_response_language: 'fr' });
    expect(eq).toHaveBeenCalledWith('id', 'profile-123');
    expect(from).not.toHaveBeenCalledWith('businesses');
  });

  it.each([
    ['', 'fr'],
    ['profile-123', 'de'],
    ['profile-123', 'not-a-language'],
  ])('rejects a missing identity or unsupported language without issuing a write', async (profileId, language) => {
    const update = vi.fn();
    const from = vi.fn(() => ({ update }));

    await expect(writePreferredResponseLanguage({ from } as never, profileId, language))
      .rejects.toThrow();
    expect(from).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

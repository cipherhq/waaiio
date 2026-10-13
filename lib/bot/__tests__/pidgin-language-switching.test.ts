/**
 * Pidgin language switching — detection, persistence, and switch-back
 *
 * Tests the fix for bare language names, "talk" verb, and session-scoped
 * language preference handling end-to-end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ════════════════════════════════════════════════════════════
// 1. Detection — parseLanguagePreferenceIntent
// ════════════════════════════════════════════════════════════

describe('Pidgin detection phrases', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([
    ['switch to Pidgin',        'pcm', 'session',    false],
    ['Pidgin',                  'pcm', 'session',    true],
    ['speak pidgin',            'pcm', 'session',    false],
    ['abeg talk pidgin',        'pcm', 'session',    false],
    ['talk pidgin',             'pcm', 'session',    false],
    ['use pidgin',              'pcm', 'session',    false],
    ['naija',                   'pcm', 'session',    true],
    ['always speak pidgin',     'pcm', 'persistent', false],
    ['speak pidgin from now on','pcm', 'persistent', false],
  ] as const)('"%s" → language=%s, persistence=%s, isBare=%s', async (input, lang, persistence, isBare) => {
    const { parseLanguagePreferenceIntent } = await import('../language-preference');
    const result = parseLanguagePreferenceIntent(input);
    expect(result).not.toBeNull();
    expect(result!.language).toBe(lang);
    expect(result!.persistence).toBe(persistence);
    expect(result!.isBare).toBe(isBare);
  });

  // Switch-back to English
  it.each([
    ['English',                 'en', 'session',    true],
    ['switch to English',       'en', 'session',    false],
    ['speak English',           'en', 'session',    false],
    ['always use English',      'en', 'persistent', false],
  ] as const)('switch-back: "%s" → language=%s, persistence=%s, isBare=%s', async (input, lang, persistence, isBare) => {
    const { parseLanguagePreferenceIntent } = await import('../language-preference');
    const result = parseLanguagePreferenceIntent(input);
    expect(result).not.toBeNull();
    expect(result!.language).toBe(lang);
    expect(result!.persistence).toBe(persistence);
    expect(result!.isBare).toBe(isBare);
  });

  // Non-language inputs must NOT be detected as language switches
  it.each([
    'hello', 'I want to order food', 'book me a table', '1',
    'yes', 'no', 'cancel', 'help', 'menu',
  ])('"%s" is not a language switch', async (input) => {
    const { parseLanguagePreferenceIntent } = await import('../language-preference');
    expect(parseLanguagePreferenceIntent(input)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════
// 2. Persistence — session_data._detected_language
// ════════════════════════════════════════════════════════════

describe('Pidgin language persistence', () => {
  it('normalizeLanguageAlias maps pidgin variants to pcm', async () => {
    const { normalizeLanguageAlias } = await import('../languages');
    expect(normalizeLanguageAlias('pidgin')).toBe('pcm');
    expect(normalizeLanguageAlias('Pidgin')).toBe('pcm');
    expect(normalizeLanguageAlias('naija')).toBe('pcm');
    expect(normalizeLanguageAlias('nigerian pidgin')).toBe('pcm');
    expect(normalizeLanguageAlias('pcm')).toBe('pcm');
  });

  it('pcm is a supported and certified language', async () => {
    const { isSupportedLanguage, CERTIFIED_LANGUAGES } = await import('../languages');
    expect(isSupportedLanguage('pcm')).toBe(true);
    expect(CERTIFIED_LANGUAGES).toContain('pcm');
  });

  it('resolveEffectiveResponseLanguage activates pcm when entitled', async () => {
    const { resolveEffectiveResponseLanguage } = await import('../language-preference');
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: 'pcm',
      entitlement: { allowedLanguages: ['en', 'pcm'], llmAllowed: true, translationAllowed: true },
      certifiedLanguages: ['en', 'pcm'],
    });
    expect(result.language).toBe('pcm');
    expect(result.source).toBe('explicit');
  });

  it('session language pcm is preserved across resolution', async () => {
    const { resolveEffectiveResponseLanguage } = await import('../language-preference');
    const result = resolveEffectiveResponseLanguage({
      sessionLanguage: 'pcm',
      entitlement: { allowedLanguages: ['en', 'pcm'], llmAllowed: true, translationAllowed: true },
      certifiedLanguages: ['en', 'pcm'],
    });
    expect(result.language).toBe('pcm');
    expect(result.source).toBe('session');
  });
});

// ════════════════════════════════════════════════════════════
// 3. Pidgin-mode reply generation (flow copy)
// ════════════════════════════════════════════════════════════

describe('Pidgin-mode reply generation', () => {
  it('flow copy exists for pcm language switch confirmation', async () => {
    const { getFlowCopy, fillFlowCopy } = await import('../flows/flow-localization');
    const switched = fillFlowCopy('pcm', 'lang.switched', { langName: 'Nigerian Pidgin' });
    expect(switched).toBeTruthy();
    expect(switched.length).toBeGreaterThan(0);
    const english = getFlowCopy('en', 'lang.switched_english');
    expect(english).toBeTruthy();
  });

  it('format-date maps pcm to en for calendar formatting', async () => {
    const { formatDisplayDate } = await import('../format-date');
    const result = formatDisplayDate(new Date('2026-01-15'), 'pcm');
    expect(result).toBeTruthy();
  });
});

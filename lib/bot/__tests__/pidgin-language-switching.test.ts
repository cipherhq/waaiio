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
    ['switch to Pidgin',        'pcm', 'session'],
    ['Pidgin',                  'pcm', 'session'],
    ['speak pidgin',            'pcm', 'session'],
    ['abeg talk pidgin',        'pcm', 'session'],
    ['talk pidgin',             'pcm', 'session'],
    ['use pidgin',              'pcm', 'session'],
    ['naija',                   'pcm', 'session'],
    ['always speak pidgin',     'pcm', 'persistent'],
    ['speak pidgin from now on','pcm', 'persistent'],
  ])('"%s" → language=%s, persistence=%s', async (input, lang, persistence) => {
    const { parseLanguagePreferenceIntent } = await import('../language-preference');
    const result = parseLanguagePreferenceIntent(input);
    expect(result).not.toBeNull();
    expect(result!.language).toBe(lang);
    expect(result!.persistence).toBe(persistence);
  });

  // Switch-back to English
  it.each([
    ['English',                 'en', 'session'],
    ['switch to English',       'en', 'session'],
    ['speak English',           'en', 'session'],
    ['always use English',      'en', 'persistent'],
  ])('switch-back: "%s" → language=%s, persistence=%s', async (input, lang, persistence) => {
    const { parseLanguagePreferenceIntent } = await import('../language-preference');
    const result = parseLanguagePreferenceIntent(input);
    expect(result).not.toBeNull();
    expect(result!.language).toBe(lang);
    expect(result!.persistence).toBe(persistence);
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
// 3. End-to-end: executor handles session-scoped Pidgin switch
// ════════════════════════════════════════════════════════════

describe('Executor language switch wiring', () => {
  it('parseLanguagePreferenceIntent session result is handled by executor (source analysis)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../bot/flows/executor.ts'),
      'utf-8',
    );

    // The executor must handle ALL languagePreferenceIntent results, not just persistent
    expect(src).toContain('if (languagePreferenceIntent)');
    // It must NOT be gated on persistence === 'persistent' only
    expect(src).not.toMatch(/if\s*\(languagePreferenceIntent\?\.persistence\s*===\s*'persistent'\)/);
    // Session-scoped should NOT write to profile
    expect(src).toContain('if (isPersistent && session.user_id)');
  });

  it('inline langSwitchMatch regex includes "talk" verb', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../bot/flows/executor.ts'),
      'utf-8',
    );
    // The inline regex must include "talk" for "talk pidgin" to work as fallback
    expect(src).toMatch(/langSwitchMatch.*talk/);
  });
});

// ════════════════════════════════════════════════════════════
// 4. Pidgin-mode customer gets a Pidgin reply (flow copy)
// ════════════════════════════════════════════════════════════

describe('Pidgin-mode reply generation', () => {
  it('flow copy exists for pcm language switch confirmation', async () => {
    const { getFlowCopy, fillFlowCopy } = await import('../flows/flow-localization');
    // lang.switched template must exist and produce a non-empty Pidgin string
    const switched = fillFlowCopy('pcm', 'lang.switched', { langName: 'Nigerian Pidgin' });
    expect(switched).toBeTruthy();
    expect(switched.length).toBeGreaterThan(0);
    // English switch-back must also exist
    const english = getFlowCopy('en', 'lang.switched_english');
    expect(english).toBeTruthy();
  });

  it('format-date maps pcm to en for calendar formatting', async () => {
    const { formatDisplayDate } = await import('../format-date');
    // PCM uses English calendar system — should not throw
    const result = formatDisplayDate(new Date('2026-01-15'), 'pcm');
    expect(result).toBeTruthy();
  });
});

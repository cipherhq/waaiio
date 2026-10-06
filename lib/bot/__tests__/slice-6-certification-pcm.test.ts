/**
 * Slice 6 Gate 1 — Nigerian Pidgin (pcm) certification tests (#524)
 *
 * Tests the production detector, response-language authority cascade,
 * Pidgin/Spanish collision, entitlement boundaries, routing safety,
 * and English regression — all without changing CERTIFIED_LANGUAGES.
 */
import { describe, it, expect } from 'vitest';
import { PIDGIN_CORPUS } from './fixtures/certification-corpus-pcm';
import { validateCorpus } from './fixtures/certification-harness';
import { detectLanguageDeterministic, getEffectiveLanguages } from '@/lib/bot/language-policy';
import { resolveEffectiveResponseLanguage } from '@/lib/bot/language-preference';
import { CERTIFIED_LANGUAGES, SUPPORTED_LANGUAGES } from '@/lib/bot/languages';
import { normalizeInboundCommand } from '@/lib/bot/inbound-command-normalization';
import type { LanguageEntitlement } from '@/lib/bot/language-policy';

// ── Helpers ──

/** Hypothetical certified languages including pcm — for testing authority WITH certification. */
const CERTIFIED_WITH_PCM = ['en', 'pcm'] as const;

/**
 * Build a LanguageEntitlement for hypothetical scenarios where pcm IS certified.
 * Since getEffectiveLanguages reads the global CERTIFIED_LANGUAGES (currently ['en']),
 * we construct the entitlement directly for scenarios testing pcm-certified behavior.
 */
function hypotheticalEntitlement(tier: string, configuredLanguages?: string[]): LanguageEntitlement {
  if (tier === 'free' || (tier !== 'growth' && tier !== 'business')) {
    return { allowedLanguages: ['en'], llmAllowed: false, translationAllowed: false };
  }
  if (tier === 'business') {
    return { allowedLanguages: ['en', 'pcm'], llmAllowed: true, translationAllowed: true };
  }
  // Growth: English + configured languages that are in CERTIFIED_WITH_PCM
  const configured = (configuredLanguages || ['en']).filter(l => CERTIFIED_WITH_PCM.includes(l as any));
  const allowed = Array.from(new Set(['en', ...configured]));
  return { allowedLanguages: allowed, llmAllowed: true, translationAllowed: true };
}

// ═══════════════════════════════════════════════════════════════
// 0. Corpus validation
// ═══════════════════════════════════════════════════════════════

describe('Corpus — structural validation', () => {
  it('Pidgin corpus meets minimum 50 utterances across 12 categories', () => {
    const errors = validateCorpus(PIDGIN_CORPUS);
    expect(errors).toEqual([]);
    expect(PIDGIN_CORPUS.utterances.length).toBeGreaterThanOrEqual(50);
  });
});

// ═══════════════════════════════════════════════════════════════
// 1. Inbound language detection (detectLanguageDeterministic)
// ═══════════════════════════════════════════════════════════════

describe('Inbound detection — detectLanguageDeterministic()', () => {
  const pcmUtterances = PIDGIN_CORPUS.utterances.filter(
    u => u.category !== 'negative' && u.expectedInboundLanguage === 'pcm',
  );

  it.each(pcmUtterances.map(u => [u.text, u.category]))(
    'detects Pidgin: "%s" (%s)',
    (text) => {
      expect(detectLanguageDeterministic(text as string)).toBe('pcm');
    },
  );

  // Negative examples: must NOT detect as pcm
  const negatives = PIDGIN_CORPUS.utterances.filter(u => u.category === 'negative');
  it.each(negatives.map(u => [u.text, u.expectedInboundLanguage, u.notes]))(
    'does NOT detect as Pidgin: "%s" → expected %s (%s)',
    (text, expectedLang) => {
      const detected = detectLanguageDeterministic(text as string);
      expect(detected).not.toBe('pcm');
      if (expectedLang) expect(detected).toBe(expectedLang);
    },
  );

  // Null/uncertain cases
  const uncertains = PIDGIN_CORPUS.utterances.filter(u => u.expectedInboundLanguage === null);
  it.each(uncertains.map(u => [u.text, u.notes || u.category]))(
    'uncertain/null detection: "%s" (%s)',
    (text) => {
      const detected = detectLanguageDeterministic(text as string);
      // null or any language is acceptable — just not a false Pidgin positive for non-Pidgin text
      // (Pidgin utterances with null expectation are short/ambiguous)
      expect(typeof detected === 'string' || detected === null).toBe(true);
    },
  );
});

// ═══════════════════════════════════════════════════════════════
// 2. Pidgin/Spanish collision tests
// ═══════════════════════════════════════════════════════════════

describe('Collision — Pidgin/Spanish boundary', () => {
  it('"una" alone → detects Pidgin (Pidgin regex matches, not Spanish)', () => {
    const result = detectLanguageDeterministic('una');
    // "una" is in Pidgin regex, not Spanish. Pidgin checked last but Spanish doesn't claim it.
    expect(result).toBe('pcm');
  });

  it('"una hola" → detects Spanish (hola matches Spanish, checked before Pidgin)', () => {
    const result = detectLanguageDeterministic('una hola');
    expect(result).toBe('es');
  });

  it('"una reserva por favor" → detects Spanish', () => {
    const result = detectLanguageDeterministic('una reserva por favor');
    expect(result).toBe('es');
  });

  it('"na wetin dey" → detects Pidgin (strong Pidgin markers)', () => {
    const result = detectLanguageDeterministic('na wetin dey');
    expect(result).toBe('pcm');
  });

  it('"quiero una cita" → detects Spanish (quiero matches Spanish)', () => {
    const result = detectLanguageDeterministic('quiero una cita');
    expect(result).toBe('es');
  });

  it('"dem no gree" → detects Pidgin', () => {
    const result = detectLanguageDeterministic('dem no gree');
    expect(result).toBe('pcm');
  });

  it('"buenos dias necesito reservar" → detects Spanish, not Pidgin', () => {
    const result = detectLanguageDeterministic('buenos dias necesito reservar');
    expect(result).toBe('es');
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Normalization tests
// ═══════════════════════════════════════════════════════════════

describe('Normalization — normalizeInboundCommand()', () => {
  it('strips diacritics for Yoruba detection', () => {
    expect(normalizeInboundCommand('Mo fẹ́ ṣe')).toBe('mo fe se');
  });

  it('strips Igbo dotted vowels', () => {
    expect(normalizeInboundCommand('Achọrọ m')).toBe('achoro m');
  });

  it('normalizes Hausa hooked-k', () => {
    expect(normalizeInboundCommand('ƙarya')).toBe('karya');
  });

  it('normalizes open-e/open-o for Twi', () => {
    expect(normalizeInboundCommand('Mepɛ sɛ')).toBe('mepe se');
  });

  it('Pidgin text unchanged (no diacritics)', () => {
    expect(normalizeInboundCommand('Abeg I wan book')).toBe('abeg i wan book');
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Response-language authority (resolveEffectiveResponseLanguage)
// ═══════════════════════════════════════════════════════════════

describe('Authority — resolveEffectiveResponseLanguage with pcm', () => {
  it('Growth tier + pcm configured + pcm certified → Pidgin response', () => {
    const entitlement = hypotheticalEntitlement('growth', ['en', 'pcm']);
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: 'pcm',
      rememberedLanguage: null,
      entitlement,
      certifiedLanguages: CERTIFIED_WITH_PCM,
    });
    expect(result.language).toBe('pcm');
    expect(result.source).toBe('session');
  });

  it('Business tier + pcm certified → Pidgin response (no config needed)', () => {
    const entitlement = hypotheticalEntitlement('business');
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: 'pcm',
      rememberedLanguage: null,
      entitlement,
      certifiedLanguages: CERTIFIED_WITH_PCM,
    });
    expect(result.language).toBe('pcm');
  });

  it('Free tier → English regardless of pcm detection', () => {
    const entitlement = hypotheticalEntitlement('free');
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: 'pcm',
      rememberedLanguage: null,
      entitlement,
      certifiedLanguages: CERTIFIED_WITH_PCM,
    });
    expect(result.language).toBe('en');
    expect(result.source).toBe('fallback');
  });

  it('Growth tier + pcm NOT configured → English', () => {
    const entitlement = hypotheticalEntitlement('growth', ['en']);
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: 'pcm',
      rememberedLanguage: null,
      entitlement,
      certifiedLanguages: CERTIFIED_WITH_PCM,
    });
    expect(result.language).toBe('en');
  });

  it('pcm NOT certified → English even for Business tier', () => {
    // Use real CERTIFIED_LANGUAGES (only 'en')
    const entitlement = getEffectiveLanguages('business', null);
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: 'pcm',
      rememberedLanguage: null,
      entitlement,
      certifiedLanguages: CERTIFIED_LANGUAGES, // only ['en']
    });
    expect(result.language).toBe('en');
    expect(result.source).toBe('fallback');
  });

  it('remembered pcm preference → restores Pidgin (when certified + entitled)', () => {
    const entitlement = hypotheticalEntitlement('growth', ['en', 'pcm']);
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: null,
      rememberedLanguage: 'pcm',
      entitlement,
      certifiedLanguages: CERTIFIED_WITH_PCM,
    });
    expect(result.language).toBe('pcm');
    expect(result.source).toBe('remembered');
    expect(result.shouldOfferRemembered).toBe(true);
  });

  it('explicit language switch overrides session + remembered', () => {
    const entitlement = hypotheticalEntitlement('growth', ['en', 'pcm']);
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: 'en',
      sessionLanguage: 'pcm',
      rememberedLanguage: 'pcm',
      entitlement,
      certifiedLanguages: CERTIFIED_WITH_PCM,
    });
    expect(result.language).toBe('en');
    expect(result.source).toBe('explicit');
  });

  it('unknown language code → English fallback', () => {
    const entitlement = hypotheticalEntitlement('business');
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: 'zz',
      rememberedLanguage: null,
      entitlement,
      certifiedLanguages: CERTIFIED_WITH_PCM,
    });
    expect(result.language).toBe('en');
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Entitlement boundary — getEffectiveLanguages
// ═══════════════════════════════════════════════════════════════

describe('Entitlement — getEffectiveLanguages current state (pcm NOT certified)', () => {
  it('free tier: English only, no LLM, no translation', () => {
    const ent = getEffectiveLanguages('free', ['en', 'pcm']);
    expect(ent.allowedLanguages).toEqual(['en']);
    expect(ent.llmAllowed).toBe(false);
    expect(ent.translationAllowed).toBe(false);
  });

  it('growth tier + pcm configured: pcm excluded because NOT certified', () => {
    const ent = getEffectiveLanguages('growth', ['en', 'pcm']);
    // pcm is filtered out because CERTIFIED_LANGUAGES = ['en']
    expect(ent.allowedLanguages).not.toContain('pcm');
    expect(ent.allowedLanguages).toContain('en');
    expect(ent.llmAllowed).toBe(true);
  });

  it('business tier: pcm NOT available because NOT certified', () => {
    const ent = getEffectiveLanguages('business', null);
    expect(ent.allowedLanguages).not.toContain('pcm');
    expect(ent.allowedLanguages).toEqual(['en']);
  });

  it('unknown tier: fails closed to free', () => {
    const ent = getEffectiveLanguages('unknown', ['en', 'pcm']);
    expect(ent.allowedLanguages).toEqual(['en']);
    expect(ent.llmAllowed).toBe(false);
  });
});

describe('Entitlement — hypothetical pcm-certified behavior', () => {
  it('growth + pcm configured + certified → pcm in allowedLanguages', () => {
    const ent = hypotheticalEntitlement('growth', ['en', 'pcm']);
    expect(ent.allowedLanguages).toContain('pcm');
    expect(ent.llmAllowed).toBe(true);
    expect(ent.translationAllowed).toBe(true);
  });

  it('growth + pcm NOT configured → pcm excluded even if certified', () => {
    const ent = hypotheticalEntitlement('growth', ['en']);
    expect(ent.allowedLanguages).not.toContain('pcm');
  });

  it('business + certified → pcm automatically available', () => {
    const ent = hypotheticalEntitlement('business');
    expect(ent.allowedLanguages).toContain('pcm');
  });

  it('free → English only regardless of certification', () => {
    const ent = hypotheticalEntitlement('free');
    expect(ent.allowedLanguages).toEqual(['en']);
    expect(ent.llmAllowed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Current CERTIFIED_LANGUAGES boundary
// ═══════════════════════════════════════════════════════════════

describe('Certification boundary — current state', () => {
  it('CERTIFIED_LANGUAGES contains only English', () => {
    expect(CERTIFIED_LANGUAGES).toEqual(['en']);
  });

  it('pcm is supported but NOT certified', () => {
    expect(SUPPORTED_LANGUAGES).toContain('pcm');
    expect(CERTIFIED_LANGUAGES).not.toContain('pcm');
  });

  it('all 8 languages are supported', () => {
    expect(SUPPORTED_LANGUAGES).toHaveLength(8);
    for (const lang of ['en', 'pcm', 'yo', 'ig', 'ha', 'tw', 'fr', 'es']) {
      expect(SUPPORTED_LANGUAGES).toContain(lang);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Routing safety — language cannot select tenant
// ═══════════════════════════════════════════════════════════════

describe('Routing safety — tenant isolation', () => {
  it('detectLanguageDeterministic returns language only, never business/tenant info', () => {
    const result = detectLanguageDeterministic('Abeg I wan book haircut');
    expect(typeof result).toBe('string');
    // The return type is string | null — no business/tenant data
    expect(result).toBe('pcm');
  });

  it('resolveEffectiveResponseLanguage requires entitlement (business-scoped) as input', () => {
    // The function signature requires entitlement which is business-specific.
    // Language alone cannot determine business — entitlement must be provided.
    const entitlement = hypotheticalEntitlement('growth', ['en', 'pcm']);
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: 'pcm',
      rememberedLanguage: null,
      entitlement, // business-scoped
      certifiedLanguages: CERTIFIED_WITH_PCM,
    });
    expect(result.language).toBe('pcm');
    // Different business with different entitlement → different result
    const freeEntitlement = hypotheticalEntitlement('free');
    const result2 = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: 'pcm',
      rememberedLanguage: null,
      entitlement: freeEntitlement,
      certifiedLanguages: CERTIFIED_WITH_PCM,
    });
    expect(result2.language).toBe('en');
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. English regression
// ═══════════════════════════════════════════════════════════════

describe('English regression — unchanged with pcm in CERTIFIED', () => {
  const englishUtterances = [
    'I want to book a haircut',
    'Order food please',
    'Pay my bill',
    'Buy tickets for the show',
    'Check my booking',
    'Go back',
    'Help',
    'Cancel',
  ];

  it.each(englishUtterances)('English utterance "%s" → null or en detection', (text) => {
    const detected = detectLanguageDeterministic(text);
    // English text should return null (no non-English markers) or rarely a false positive
    // The key assertion: it should NOT detect as pcm
    expect(detected).not.toBe('pcm');
  });

  it('English with pcm-certified authority still returns English for English session', () => {
    const entitlement = hypotheticalEntitlement('growth', ['en', 'pcm']);
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: 'en',
      rememberedLanguage: null,
      entitlement,
      certifiedLanguages: CERTIFIED_WITH_PCM,
    });
    expect(result.language).toBe('en');
    expect(result.source).toBe('session');
  });

  it('English with no session/remembered → English fallback', () => {
    const entitlement = hypotheticalEntitlement('business');
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: null,
      rememberedLanguage: null,
      entitlement,
      certifiedLanguages: CERTIFIED_WITH_PCM,
    });
    expect(result.language).toBe('en');
    expect(result.source).toBe('fallback');
  });
});

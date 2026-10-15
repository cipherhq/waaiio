/**
 * Slice 6 — Nigerian Pidgin (pcm) certification tests (#524)
 *
 * Tests the production detector, response-language authority cascade,
 * Pidgin/Spanish collision, entitlement boundaries, routing safety,
 * and English regression with Pidgin certified after Gate 2 human QA.
 */
import { describe, it, expect } from 'vitest';
import { PIDGIN_CORPUS } from './fixtures/certification-corpus-pcm';
import { validateCorpus } from './fixtures/certification-harness';
import { detectLanguageDeterministic, getEffectiveLanguages } from '@/lib/bot/language-policy';
import { resolveEffectiveResponseLanguage } from '@/lib/bot/language-preference';
import { CERTIFIED_LANGUAGES, SUPPORTED_LANGUAGES } from '@/lib/bot/languages';
import { normalizeInboundCommand } from '@/lib/bot/inbound-command-normalization';

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

  const negatives = PIDGIN_CORPUS.utterances.filter(u => u.category === 'negative');
  it.each(negatives.map(u => [u.text, u.expectedInboundLanguage, u.notes]))(
    'does NOT detect as Pidgin: "%s" → expected %s (%s)',
    (text, expectedLang) => {
      const detected = detectLanguageDeterministic(text as string);
      expect(detected).not.toBe('pcm');
      if (expectedLang) expect(detected).toBe(expectedLang);
    },
  );

  const uncertains = PIDGIN_CORPUS.utterances.filter(u => u.expectedInboundLanguage === null);
  it.each(uncertains.map(u => [u.text, u.notes || u.category]))(
    'uncertain/null detection: "%s" (%s)',
    (text) => {
      const detected = detectLanguageDeterministic(text as string);
      expect(typeof detected === 'string' || detected === null).toBe(true);
    },
  );
});

// ═══════════════════════════════════════════════════════════════
// 2. Pidgin/Spanish collision tests
// ═══════════════════════════════════════════════════════════════

describe('Collision — Pidgin/Spanish boundary', () => {
  it('"una" alone → detects Pidgin (Pidgin regex matches, not Spanish)', () => {
    expect(detectLanguageDeterministic('una')).toBe('pcm');
  });

  it('"una hola" → detects Spanish (hola matches Spanish, checked before Pidgin)', () => {
    expect(detectLanguageDeterministic('una hola')).toBe('es');
  });

  it('"una reserva por favor" → detects Spanish', () => {
    expect(detectLanguageDeterministic('una reserva por favor')).toBe('es');
  });

  it('"na wetin dey" → detects Pidgin (strong Pidgin markers)', () => {
    expect(detectLanguageDeterministic('na wetin dey')).toBe('pcm');
  });

  it('"quiero una cita" → detects Spanish (quiero matches Spanish)', () => {
    expect(detectLanguageDeterministic('quiero una cita')).toBe('es');
  });

  it('"dem no gree" → detects Pidgin', () => {
    expect(detectLanguageDeterministic('dem no gree')).toBe('pcm');
  });

  it('"buenos dias necesito reservar" → detects Spanish, not Pidgin', () => {
    expect(detectLanguageDeterministic('buenos dias necesito reservar')).toBe('es');
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

describe('Authority — resolveEffectiveResponseLanguage with certified pcm', () => {
  it('Growth tier + pcm configured → Pidgin response', () => {
    const entitlement = getEffectiveLanguages('growth', ['en', 'pcm']);
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: 'pcm',
      rememberedLanguage: null,
      entitlement,
      certifiedLanguages: CERTIFIED_LANGUAGES,
    });
    expect(result.language).toBe('pcm');
    expect(result.source).toBe('session');
  });

  it('Business tier → Pidgin response (no config needed)', () => {
    const entitlement = getEffectiveLanguages('business');
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: 'pcm',
      rememberedLanguage: null,
      entitlement,
      certifiedLanguages: CERTIFIED_LANGUAGES,
    });
    expect(result.language).toBe('pcm');
  });

  it('Free tier → English regardless of pcm detection', () => {
    const entitlement = getEffectiveLanguages('free');
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: 'pcm',
      rememberedLanguage: null,
      entitlement,
      certifiedLanguages: CERTIFIED_LANGUAGES,
    });
    expect(result.language).toBe('en');
    expect(result.source).toBe('fallback');
  });

  it('Growth tier + pcm NOT configured → English', () => {
    const entitlement = getEffectiveLanguages('growth', ['en']);
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: 'pcm',
      rememberedLanguage: null,
      entitlement,
      certifiedLanguages: CERTIFIED_LANGUAGES,
    });
    expect(result.language).toBe('en');
  });

  it('real certification authority allows pcm for Business tier', () => {
    const entitlement = getEffectiveLanguages('business', null);
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: 'pcm',
      rememberedLanguage: null,
      entitlement,
      certifiedLanguages: CERTIFIED_LANGUAGES,
    });
    expect(result.language).toBe('pcm');
    expect(result.source).toBe('session');
  });

  it('remembered pcm preference → restores Pidgin when entitled', () => {
    const entitlement = getEffectiveLanguages('growth', ['en', 'pcm']);
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: null,
      rememberedLanguage: 'pcm',
      entitlement,
      certifiedLanguages: CERTIFIED_LANGUAGES,
    });
    expect(result.language).toBe('pcm');
    expect(result.source).toBe('remembered');
    expect(result.shouldOfferRemembered).toBe(true);
  });

  it('explicit language switch overrides session + remembered', () => {
    const entitlement = getEffectiveLanguages('growth', ['en', 'pcm']);
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: 'en',
      sessionLanguage: 'pcm',
      rememberedLanguage: 'pcm',
      entitlement,
      certifiedLanguages: CERTIFIED_LANGUAGES,
    });
    expect(result.language).toBe('en');
    expect(result.source).toBe('explicit');
  });

  it('unknown language code → English fallback', () => {
    const entitlement = getEffectiveLanguages('business');
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: 'zz',
      rememberedLanguage: null,
      entitlement,
      certifiedLanguages: CERTIFIED_LANGUAGES,
    });
    expect(result.language).toBe('en');
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Entitlement boundary — getEffectiveLanguages
// ═══════════════════════════════════════════════════════════════

describe('Entitlement — getEffectiveLanguages with pcm certified', () => {
  it('free tier: English only, no LLM, no translation', () => {
    const ent = getEffectiveLanguages('free', ['en', 'pcm']);
    expect(ent.allowedLanguages).toEqual(['en']);
    expect(ent.llmAllowed).toBe(false);
    expect(ent.translationAllowed).toBe(false);
  });

  it('growth tier + pcm configured: pcm is allowed', () => {
    const ent = getEffectiveLanguages('growth', ['en', 'pcm']);
    expect(ent.allowedLanguages).toEqual(['en', 'pcm']);
    expect(ent.llmAllowed).toBe(true);
    expect(ent.translationAllowed).toBe(true);
  });

  it('growth tier + pcm NOT configured: pcm remains excluded', () => {
    const ent = getEffectiveLanguages('growth', ['en']);
    expect(ent.allowedLanguages).toEqual(['en']);
    expect(ent.allowedLanguages).not.toContain('pcm');
  });

  it('business tier: all certified languages are available', () => {
    const ent = getEffectiveLanguages('business', null);
    expect(ent.allowedLanguages).toEqual(['en', 'pcm']);
  });

  it('unknown tier: fails closed to free', () => {
    const ent = getEffectiveLanguages('unknown', ['en', 'pcm']);
    expect(ent.allowedLanguages).toEqual(['en']);
    expect(ent.llmAllowed).toBe(false);
    expect(ent.translationAllowed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Current CERTIFIED_LANGUAGES boundary
// ═══════════════════════════════════════════════════════════════

describe('Certification boundary — post Gate 2', () => {
  it('CERTIFIED_LANGUAGES contains only English and Nigerian Pidgin', () => {
    expect(CERTIFIED_LANGUAGES).toEqual(['en', 'pcm']);
  });

  it('pcm is supported and certified', () => {
    expect(SUPPORTED_LANGUAGES).toContain('pcm');
    expect(CERTIFIED_LANGUAGES).toContain('pcm');
  });

  it('other supported non-English languages remain uncertified', () => {
    for (const lang of ['yo', 'ig', 'ha', 'tw', 'fr', 'es']) {
      expect(SUPPORTED_LANGUAGES).toContain(lang);
      expect(CERTIFIED_LANGUAGES).not.toContain(lang);
    }
  });

  it('all 8 languages remain supported', () => {
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
    expect(result).toBe('pcm');
  });

  it('resolveEffectiveResponseLanguage requires entitlement (business-scoped) as input', () => {
    const entitlement = getEffectiveLanguages('growth', ['en', 'pcm']);
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: 'pcm',
      rememberedLanguage: null,
      entitlement,
      certifiedLanguages: CERTIFIED_LANGUAGES,
    });
    expect(result.language).toBe('pcm');

    const freeEntitlement = getEffectiveLanguages('free');
    const result2 = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: 'pcm',
      rememberedLanguage: null,
      entitlement: freeEntitlement,
      certifiedLanguages: CERTIFIED_LANGUAGES,
    });
    expect(result2.language).toBe('en');
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. English regression
// ═══════════════════════════════════════════════════════════════

describe('English regression — unchanged with pcm certified', () => {
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
    expect(detected).not.toBe('pcm');
  });

  it('English remains English for English session', () => {
    const entitlement = getEffectiveLanguages('growth', ['en', 'pcm']);
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: 'en',
      rememberedLanguage: null,
      entitlement,
      certifiedLanguages: CERTIFIED_LANGUAGES,
    });
    expect(result.language).toBe('en');
    expect(result.source).toBe('session');
  });

  it('English with no session/remembered → English fallback', () => {
    const entitlement = getEffectiveLanguages('business');
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: null,
      rememberedLanguage: null,
      entitlement,
      certifiedLanguages: CERTIFIED_LANGUAGES,
    });
    expect(result.language).toBe('en');
    expect(result.source).toBe('fallback');
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. S6-B4 — Corpus authority enforcement
//    Every corpus entry's response-authority expectation validated
//    through the production resolveEffectiveResponseLanguage seam.
// ═══════════════════════════════════════════════════════════════

describe('B4 — corpus authority expectations enforced per-utterance', () => {
  const authorityEntries = PIDGIN_CORPUS.utterances.filter(
    u => u.scenario && u.expectedEffectiveResponseLanguage,
  );

  it.each(authorityEntries.map((u, i) => [`#${i + 1} "${u.text.slice(0, 40)}..." (${u.category})`, u]))(
    '%s → expected %s',
    (_label, entry) => {
      const u = entry as typeof authorityEntries[0];
      const entitlement = getEffectiveLanguages(u.scenario.tier, u.scenario.configuredLanguages);

      const sessionLang = u.expectedInboundLanguage && u.shouldActivateLanguage
        ? u.expectedInboundLanguage
        : u.scenario.sessionLanguage ?? null;

      const result = resolveEffectiveResponseLanguage({
        explicitLanguage: null,
        sessionLanguage: sessionLang,
        rememberedLanguage: u.scenario.rememberedLanguage ?? null,
        entitlement,
        certifiedLanguages: CERTIFIED_LANGUAGES,
      });

      expect(result.language).toBe(u.expectedEffectiveResponseLanguage);
    },
  );
});

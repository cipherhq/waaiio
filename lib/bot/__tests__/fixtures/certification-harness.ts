/**
 * Slice 6 — Reusable language certification harness (#524)
 *
 * Types and helpers shared by all per-language certification test suites.
 * Separates inbound language detection (comprehension) from effective
 * response-language authority (entitlement/certification/tier-gated).
 */

// ── Corpus types ──

export interface EntitlementScenario {
  tier: 'free' | 'growth' | 'business';
  /** Languages the business has configured (Growth tier). Ignored for free/business. */
  configuredLanguages?: string[];
  /** Existing session._detected_language, if any. */
  sessionLanguage?: string | null;
  /** Existing profile.preferred_response_language, if any. */
  rememberedLanguage?: string | null;
}

export interface CorpusUtterance {
  /** The raw WhatsApp message text. */
  text: string;
  /** One of the 12 corpus categories. */
  category:
    | 'greeting' | 'native-intent' | 'ascii' | 'code-switch'
    | 'typo-slang' | 'create' | 'manage' | 'history-info'
    | 'navigation' | 'lang-switch' | 'correction' | 'negative';
  // ── Inbound detection layer ──
  /** What detectLanguageDeterministic() should return for this text. null = uncertain. */
  expectedInboundLanguage: string | null;
  /** Expected smart-intent semantic family, if applicable. */
  expectedIntent?: string | null;
  // ── Response-language authority layer ──
  /** Entitlement scenario under which expectedEffectiveResponseLanguage is evaluated. */
  scenario: EntitlementScenario;
  /** What resolveEffectiveResponseLanguage should return given this scenario + detection. */
  expectedEffectiveResponseLanguage: string;
  /** Whether the system should write _detected_language for this utterance. */
  shouldActivateLanguage: boolean;
  /** Notes for human reviewers. */
  notes?: string;
}

export interface LanguageCorpus {
  language: string;
  displayName: string;
  nativeName: string;
  utterances: CorpusUtterance[];
}

// ── Journey types ──

export interface JourneyTest {
  id: string;
  name: string;
  /** Which number topology this journey exercises. */
  topology: 'shared' | 'dedicated' | 'both';
  /** Domain: booking, ordering, ticketing, payment, navigation, lang-switch, proactive, email, pdf */
  domain: string;
}

// ── Helpers ──

/** Count utterances by category in a corpus. */
export function countByCategory(corpus: LanguageCorpus): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const u of corpus.utterances) {
    counts[u.category] = (counts[u.category] || 0) + 1;
  }
  return counts;
}

/** Validate corpus meets minimum requirements. */
export function validateCorpus(corpus: LanguageCorpus): string[] {
  const errors: string[] = [];
  if (corpus.utterances.length < 50) {
    errors.push(`Corpus has ${corpus.utterances.length} utterances, minimum is 50`);
  }
  const counts = countByCategory(corpus);
  const required: Record<string, number> = {
    greeting: 5, 'native-intent': 6, ascii: 5, 'code-switch': 5,
    'typo-slang': 4, create: 4, manage: 3, 'history-info': 3,
    navigation: 4, 'lang-switch': 3, correction: 3, negative: 5,
  };
  for (const [cat, min] of Object.entries(required)) {
    if ((counts[cat] || 0) < min) {
      errors.push(`Category '${cat}' has ${counts[cat] || 0} utterances, minimum is ${min}`);
    }
  }
  return errors;
}

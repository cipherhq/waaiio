/**
 * Deterministic static flow copy for certified languages (#559).
 *
 * Framework-level messages (validation errors, navigation hints, reroute prompts)
 * that do not contain merchant/transaction data. These bypass LLM translation
 * for reliability — the LLM path remains available for dynamic content.
 *
 * A language's copy may be used ONLY when it is both certified AND effective/entitled
 * for the session's business. Otherwise, falls back to English.
 */
import { CERTIFIED_LANGUAGES } from '@/lib/bot/languages';

const FLOW_COPY: Record<string, Record<string, string>> = {
  en: {
    invalidSelection: 'That option is not available. Tap one of the choices above.',
    cancelHint: 'Type *back* to go back, *menu* to restart, or *exit* to leave.',
    rerouteBooking: 'It looks like you want to book something. Would you like to switch?',
    rerouteOrdering: 'It looks like you want to order something. Would you like to switch?',
    rerouteTicketing: 'It looks like you want to get tickets. Would you like to switch?',
    reroutePayment: 'It looks like you want to make a payment. Would you like to switch?',
    rerouteGeneric: 'It looks like you want to do something else. Would you like to switch?',
    yes: 'Yes, switch',
    stayHere: 'No, continue here',
  },
  pcm: {
    invalidSelection: 'That option no dey. Tap one of the choices wey dey above.',
    cancelHint: 'Type *back* to go back, *menu* to start over, or *exit* to comot.',
    rerouteBooking: 'E be like say you wan book something. You wan switch?',
    rerouteOrdering: 'E be like say you wan order something. You wan switch?',
    rerouteTicketing: 'E be like say you wan get ticket. You wan switch?',
    reroutePayment: 'E be like say you wan pay. You wan switch?',
    rerouteGeneric: 'E be like say you wan do another thing. You wan switch?',
    yes: 'Yes, switch',
    stayHere: 'No, I wan continue here',
  },
};

/**
 * Get deterministic flow copy for a framework message.
 * Uses static Pidgin only when pcm is certified AND the language is effective for the session.
 * Falls back to English for uncertified/unentitled languages.
 */
export function getFlowCopy(effectiveLang: string | undefined, key: string): string {
  const lang = effectiveLang && CERTIFIED_LANGUAGES.includes(effectiveLang) ? effectiveLang : 'en';
  return FLOW_COPY[lang]?.[key] ?? FLOW_COPY.en[key] ?? key;
}

/**
 * Get the reroute prompt key for a broad intent.
 */
export function getRerouteKey(intent: string | null): string {
  switch (intent) {
    case 'booking': return 'rerouteBooking';
    case 'ordering': return 'rerouteOrdering';
    case 'ticketing': return 'rerouteTicketing';
    case 'payment': return 'reroutePayment';
    default: return 'rerouteGeneric';
  }
}

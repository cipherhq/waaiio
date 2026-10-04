/**
 * Slice 2 — shared, non-destructive inbound command normalization.
 *
 * This module is intentionally recognition-only. It never rewrites the raw
 * customer message, selects a business/capability, mutates session state, or
 * confirms a financial action. Callers must keep the original message for
 * merchant/entity matching and all authoritative flow execution.
 */

export type NavigationConcept =
  | 'back'
  | 'cancel'
  | 'menu'
  | 'home'
  | 'restart'
  | 'exit'
  | 'help'
  | 'language';

/**
 * Normalize a COPY of inbound text for deterministic command recognition.
 * The caller must preserve and continue to use the original text for entity,
 * merchant, product/service/event, note, address, promo, URL and reference
 * values.
 */
export function normalizeInboundCommandText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // NFD does not decompose a few common Hausa/Twi letters.
    .replace(/[ƙƘ]/g, 'k')
    .replace(/[ɛƐ]/g, 'e')
    .replace(/[ɔƆ]/g, 'o')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Exact/anchored navigation aliases only. Keeping recognition exact prevents
 * merchant or free-text values such as "Back Street Cafe" or "STOP & SHOP"
 * from being intercepted as commands.
 *
 * English loanwords are intentionally accepted across language contexts; this
 * mirrors normal WhatsApp code-switching without translating the message.
 */
const NAVIGATION_ALIASES: Readonly<Record<NavigationConcept, ReadonlySet<string>>> = {
  back: new Set([
    // English / code-switching
    'back', 'go back', 'previous',
    // Nigerian Pidgin
    'go back abeg', 'take me back',
    // Yoruba (native folds to the same ASCII representation)
    'pada', 'lo pada',
    // Igbo
    'laghachi', 'gaa azu',
    // Hausa
    'koma', 'koma baya',
    // Twi
    'san akyi',
    // French
    'retour', 'revenir',
    // Spanish
    'atras', 'volver',
  ]),
  cancel: new Set([
    'cancel',
    'cancel abeg',
    'fagile',
    'kagbuo',
    'soke',
    'annuler',
    'cancelar',
  ]),
  menu: new Set([
    'menu',
    'show menu',
    'akojo',
    'menu principal',
    'menu principal',
  ]),
  home: new Set([
    'home',
    'ile',
    'gida',
    'accueil',
    'inicio',
  ]),
  restart: new Set([
    'restart', 'start over', 'start again',
    'begin again',
    'tun bere',
    'malite ozo',
    'sake farawa',
    'san hye ase',
    'recommencer', 'recommence',
    'reiniciar', 'empezar de nuevo',
  ]),
  exit: new Set([
    'exit', 'quit', 'stop', 'end',
    'comot',
    'dawo',
    'kwusi',
    'dake',
    'gyae',
    'arreter', 'quitter',
    'salir',
  ]),
  help: new Set([
    'help', 'help me', 'abeg help',
    'iranlowo',
    'enyemaka',
    'taimako',
    'mmoa',
    'aide',
    'ayuda',
  ]),
  language: new Set([
    'language', 'change language', 'switch language',
    'ede', 'yi ede pada',
    'asusu', 'gbanwee asusu',
    'harshe', 'canza harshe',
    'kasa',
    'langue', 'changer de langue',
    'idioma', 'cambiar idioma',
  ]),
};

/** Return a navigation concept only; side effects remain with existing owners. */
export function detectNavigationConcept(text: string): NavigationConcept | null {
  const normalized = normalizeInboundCommandText(text);
  if (!normalized) return null;

  for (const concept of Object.keys(NAVIGATION_ALIASES) as NavigationConcept[]) {
    if (NAVIGATION_ALIASES[concept].has(normalized)) return concept;
  }
  return null;
}

export function isNavigationConcept(
  text: string,
  ...concepts: NavigationConcept[]
): boolean {
  const detected = detectNavigationConcept(text);
  return detected !== null && concepts.includes(detected);
}

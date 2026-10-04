// Slice 2 (#524): shared, non-destructive inbound command normalization.
// Keep original customer text for merchant names, addresses, notes, promo codes,
// references, and other free-text values. This helper is recognition-only.

export type NavigationCommand = 'back' | 'cancel' | 'menu' | 'home' | 'restart' | 'exit' | 'help';

export function normalizeInboundCommand(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ƙƘ]/g, 'k')
    .replace(/[ɛƐ]/g, 'e')
    .replace(/[ɔƆ]/g, 'o')
    .replace(/[’‘]/g, "'")
    .replace(/[‐‑‒–—-]/g, ' ')
    .toLowerCase()
    .trim()
    .replace(/[.!?,;:]+$/g, '')
    .replace(/\s+/g, ' ');
}

function aliasSet(values: readonly string[]): ReadonlySet<string> {
  return new Set(values.map(normalizeInboundCommand));
}

const NAVIGATION_ALIASES: Record<NavigationCommand, ReadonlySet<string>> = {
  back: aliasSet([
    'back', 'go back', 'previous', 'abeg go back', 'go back abeg',
    'padà', 'pada', 'padà sẹ́yìn', 'pada seyin', 'jọ̀wọ́ padà', 'jowo pada',
    'laghachi', 'laghachi azụ', 'laghachi azu', 'biko laghachi',
    'koma baya', 'koma', 'don Allah koma baya',
    'san kɔ akyi', 'san ko akyi', 'kɔ akyi', 'ko akyi',
    'retour', 'revenir', 'en arrière', 'en arriere', 'précédent', 'precedent',
    'atrás', 'atras', 'volver', 'regresar', 'anterior',
  ]),
  cancel: aliasSet([
    'cancel', 'cancel it', 'cancel am', 'abeg cancel am',
    'fagilé', 'fagile', 'fagilé e', 'fagile e',
    'kagbuo', 'kagbuo ya', 'soke', 'soke shi', 'twa mu',
    'annuler', 'annule', 'cancelar', 'cancela',
  ]),
  menu: aliasSet([
    'menu', 'show menu', 'main menu', 'menu abeg', 'abeg show menu',
    'fi menu hàn', 'fi menu han', 'jọ̀wọ́ fi menu hàn', 'jowo fi menu han',
    'gosi menu', 'biko gosi menu', 'nuna menu', 'don Allah nuna menu',
    'kyerɛ menu', 'kyere menu', 'mesrɛ wo kyerɛ menu', 'mesre wo kyere menu',
    'afficher le menu', 'montre le menu', 'mostrar menu', 'muestra el menu',
  ]),
  home: aliasSet([
    'home', 'go home', 'padà sí ilé', 'pada si ile', 'laghachi ụlọ', 'laghachi ulo',
    'koma gida', 'kɔ fie', 'ko fie', 'accueil', 'retour accueil', 'inicio', 'volver al inicio',
  ]),
  restart: aliasSet([
    'restart', 'start over', 'start again', 'begin again', 'start again abeg', 'abeg start again',
    'bẹ̀rẹ̀ padà', 'bere pada', 'tún bẹ̀rẹ̀', 'tun bere', 'malite ọzọ', 'malite ozo',
    'fara daga farko', 'fi ase bio', 'recommencer', 'recommence', 'empezar de nuevo', 'reiniciar',
  ]),
  exit: aliasSet([
    'exit', 'quit', 'stop', 'end', 'leave', 'comot', 'commot', 'comot here', 'stop am',
    'jáde', 'jade', 'pụ̀ọ́', 'puo', 'fita', 'fi ha', 'quitter', 'sortir', 'salir', 'salir de aqui',
  ]),
  help: aliasSet([
    'help', 'help me', 'abeg help me', 'help abeg', 'ìrànlọ́wọ́', 'iranlowo',
    'jọ̀wọ́ ràn mí lọ́wọ́', 'jowo ran mi lowo', 'nyere m aka', 'biko nyere m aka',
    'taimako', 'don Allah taimaka', 'boa me', 'mesrɛ wo boa me', 'mesre wo boa me',
    'aide', 'aidez moi', "besoin d'aide", 'ayuda', 'ayúdame', 'ayudame', 'necesito ayuda',
  ]),
};

export function recognizeNavigationCommand(text: string): NavigationCommand | null {
  const normalized = normalizeInboundCommand(text);
  if (!normalized) return null;
  const order: readonly NavigationCommand[] = ['back', 'cancel', 'menu', 'home', 'restart', 'exit', 'help'];
  for (const command of order) {
    if (NAVIGATION_ALIASES[command].has(normalized)) return command;
  }
  return null;
}

export function isNavigationCommand(text: string, command: NavigationCommand): boolean {
  return recognizeNavigationCommand(text) === command;
}

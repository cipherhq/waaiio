export type NavigationCommand = 'back' | 'cancel' | 'menu' | 'home' | 'restart' | 'exit' | 'help';

export function normalizeInboundCommand(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ƙƘ]/g, 'k')
    .replace(/[ɛƐ]/g, 'e')
    .replace(/[ɔƆ]/g, 'o')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

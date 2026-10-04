import { describe, expect, it } from 'vitest';
import {
  detectNavigationConcept,
  normalizeInboundCommandText,
} from '../inbound-command-normalization';

describe('normalizeInboundCommandText', () => {
  it('normalizes a copy without mutating the raw inbound value', () => {
    const raw = '  Réserver   STOP & Shop  ';
    const before = raw;

    expect(normalizeInboundCommandText(raw)).toBe('reserver stop & shop');
    expect(raw).toBe(before);
  });

  it.each([
    ['en', '  Go   Back ', 'go back'],
    ['pcm', 'Abeg   HELP', 'abeg help'],
    ['yo', 'padà', 'pada'],
    ['ig', 'ụlọ', 'ulo'],
    ['ha', 'ƙOMA', 'koma'],
    ['tw', 'mɛpɛ ɔno', 'mepe ono'],
    ['fr', 'réserver', 'reserver'],
    ['es', 'atrás', 'atras'],
  ])('normalizes native/ASCII command forms for %s', (_language, input, expected) => {
    expect(normalizeInboundCommandText(input)).toBe(expected);
  });
});

describe('detectNavigationConcept', () => {
  it.each([
    ['en', 'back', 'back'],
    ['pcm', 'abeg help', 'help'],
    ['yo', 'padà', 'back'],
    ['ig', 'laghachi', 'back'],
    ['ha', 'koma baya', 'back'],
    ['tw', 'san akyi', 'back'],
    ['fr', 'retour', 'back'],
    ['es', 'atrás', 'back'],
  ] as const)('recognizes bounded navigation for %s', (_language, input, expected) => {
    expect(detectNavigationConcept(input)).toBe(expected);
  });

  it.each([
    ['dawó', 'cancel'],
    ['dákẹ́', 'cancel'],
    ['gyae', 'cancel'],
    ['annuler', 'cancel'],
    ['comot', 'exit'],
    ['quitter', 'exit'],
    ['salir', 'exit'],
  ] as const)('preserves cancel vs exit authority for %s', (input, expected) => {
    expect(detectNavigationConcept(input)).toBe(expected);
  });

  it.each([
    'Back Street Cafe',
    'STOP & SHOP',
    'Menu House',
    'Cancel Culture Salon',
    'Help Me Grow Store',
    'Retourtique',
  ])('does not intercept navigation words embedded in merchant/free text: %s', input => {
    expect(detectNavigationConcept(input)).toBeNull();
  });

  it('does not interpret an arbitrary sentence containing a command word as navigation', () => {
    expect(detectNavigationConcept('please add the menu item called Back Home')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  normalizeInboundCommand,
  recognizeNavigationCommand,
} from '../inbound-command-normalization';
import {
  BACK_PATTERNS,
  CANCEL_PATTERN,
  EXIT_PATTERNS,
  HOME_PATTERN,
  MENU_PATTERNS,
} from '../handlers/escape-hatches';
import { parseSmartIntent } from '../smart-intent';
import { detectCorrection } from '../correction-parser';
import { parseLanguagePreferenceIntent } from '../language-preference';
import { CERTIFIED_LANGUAGES, detectLanguageDeterministic } from '../language-policy';
import type { BotSession } from '../bot-types';

function session(step: string, data: Record<string, unknown> = {}): BotSession {
  return {
    id: 'slice2-session',
    whatsapp_number: '2348000000000',
    user_id: 'profile-1',
    business_id: 'business-1',
    current_step: step,
    session_data: {
      active_capability: 'scheduling',
      date: 'today',
      time: '2pm',
      party_size: 1,
      service_id: 'service-1',
      ...data,
    },
    is_active: true,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    version: 1,
  };
}

describe('Slice 2 shared inbound normalization', () => {
  it.each([
    ['Yoruba', 'Jọ̀wọ́ padà', 'jowo pada'],
    ['Igbo', 'Laghachi azụ', 'laghachi azu'],
    ['Hausa', 'Don Allah koma baya', 'don allah koma baya'],
    ['Twi', 'San kɔ akyi', 'san ko akyi'],
    ['French', 'Précédent', 'precedent'],
    ['Spanish', 'Atrás', 'atras'],
    ['Pidgin', 'Abeg   go back', 'abeg go back'],
    ['English', 'Go Back', 'go back'],
  ])('normalizes %s native/WhatsApp forms without mutating caller text', (_language, input, expected) => {
    const original = input;
    expect(normalizeInboundCommand(input)).toBe(expected);
    expect(input).toBe(original);
  });

  it.each([
    ['en', 'go back', 'back'],
    ['pcm', 'abeg show menu', 'menu'],
    ['yo', 'padà sí ilé', 'home'],
    ['ig', 'malite ọzọ', 'restart'],
    ['ha', 'soke shi', 'cancel'],
    ['tw', 'mesrɛ wo boa me', 'help'],
    ['fr', 'quitter', 'exit'],
    ['es', 'volver al inicio', 'home'],
  ])('recognizes %s navigation exactly', (_language, input, expected) => {
    expect(recognizeNavigationCommand(input)).toBe(expected);
  });

  it('preserves the legacy .test navigation surface consumed by BotService/escape handlers', () => {
    expect(HOME_PATTERN.test('volver al inicio')).toBe(true);
    expect(BACK_PATTERNS.some(pattern => pattern.test('Jọ̀wọ́ padà'))).toBe(true);
    expect(CANCEL_PATTERN.test('annuler')).toBe(true);
    expect(MENU_PATTERNS.some(pattern => pattern.test('abeg show menu'))).toBe(true);
    expect(EXIT_PATTERNS.some(pattern => pattern.test('pụ̀ọ́'))).toBe(true);
  });

  it.each([
    'Back Street Burger',
    'Stop & Shop',
    'Menu Special Combo',
    'Ayuda Foundation',
    'Home Cleaning Service',
    'Please deliver to Previous Street',
  ])('does not intercept merchant/free text by substring: %s', input => {
    expect(recognizeNavigationCommand(input)).toBeNull();
  });
});

describe('Slice 2 deterministic commerce continuity', () => {
  it.each([
    ['en', 'I want to book an appointment', 'booking'],
    ['pcm', 'Abeg I wan pay school fee', 'payment'],
    ['yo', 'Mo fẹ́ san owó', 'payment'],
    ['ig', 'Achoro m order', 'ordering'],
    ['ha', 'Ina son in saya', 'ordering'],
    ['tw', 'Mepe se metua', 'payment'],
    ['fr', 'Je veux réserver', 'booking'],
    ['es', 'Quiero comprar', 'ordering'],
  ])('keeps %s common commerce intent deterministic', (_language, text, intent) => {
    const result = parseSmartIntent(text);
    expect(result.intent).toBe(intent);
    expect(result.understood).toBe(true);
  });

  it('keeps native and ASCII language detection equivalent', () => {
    expect(detectLanguageDeterministic('Mo fẹ́ san owó jọwọ')).toBe('yo');
    expect(detectLanguageDeterministic('Mo fe san owo jowo')).toBe('yo');
    expect(detectLanguageDeterministic('Je veux régler merci')).toBe('fr');
    expect(detectLanguageDeterministic('Quiero reservar por favor')).toBe('es');
  });

  it('does not expand production certification', () => {
    expect(CERTIFIED_LANGUAGES).toEqual(['en']);
  });
});

describe('Slice 2 multilingual explicit language commands', () => {
  it.each([
    ['switch to English', 'en'],
    ['Jọwọ sọ ede Yoruba fun mi', 'yo'],
    ['Biko kwuo Igbo', 'ig'],
    ['Don Allah yi magana da ni da Hausa', 'ha'],
    ['Mesrɛ wo ka Twi kyerɛ me', 'tw'],
    ['Parlez-moi en Français', 'fr'],
    ['Respóndeme en Español', 'es'],
    ['Abeg use Pidgin', 'pcm'],
  ])('recognizes explicit session language choice: %s', (text, language) => {
    expect(parseLanguagePreferenceIntent(text)).toEqual({ language, persistence: 'session' });
  });

  it('keeps durable preference persistence explicit', () => {
    expect(parseLanguagePreferenceIntent('always use English')).toEqual({ language: 'en', persistence: 'persistent' });
    expect(parseLanguagePreferenceIntent('Parlez moi en Francais toujours')).toEqual({ language: 'fr', persistence: 'persistent' });
  });

  it.each([
    'Bonjour, je veux acheter ceci',
    'Mo fe san owo',
    'Abeg I wan order food',
    'Quiero reservar una cita',
  ])('does not turn passive multilingual input into a preference: %s', text => {
    expect(parseLanguagePreferenceIntent(text)).toBeNull();
  });
});

describe('Slice 2 multilingual corrections preserve authority boundaries', () => {
  it.each([
    ['pcm', 'abeg change am to tomorrow', 'select_date', 'date', 'tomorrow', 'select_date'],
    ['yo', 'yi date pada si ọla', 'select_date', 'date', 'tomorrow', 'select_date'],
    ['ig', 'gbanwee oge ka o buru 4pm', 'select_time', 'time', '4pm', 'select_time'],
    ['ha', 'canza adadi zuwa 3', 'select_quantity', 'quantity', 3, 'select_quantity'],
    ['tw', 'sesa dodow no ko 2', 'select_quantity', 'quantity', 2, 'select_quantity'],
    ['fr', 'changer la date a demain', 'select_date', 'date', 'tomorrow', 'select_date'],
    ['es', 'cambia la fecha a mañana', 'select_date', 'date', 'tomorrow', 'select_date'],
    ['en', 'change to Friday', 'select_date', 'date', 'friday', 'select_date'],
  ] as const)('recognizes safe %s correction without LLM', (_language, text, step, field, newValue, targetStep) => {
    const result = detectCorrection(text, session(step));
    expect(result).toMatchObject({ field, newValue, targetStep });
  });

  it('recognizes variant reselection only at an existing variant authority step', () => {
    const result = detectCorrection('cambiar la talla', session('select_variant', { active_capability: 'ordering' }));
    expect(result).toMatchObject({ field: 'variant', newValue: null, targetStep: 'select_variant' });
  });

  it('allows scheduling confirmation edits by routing back to existing authority', () => {
    expect(detectCorrection('changer la date a demain', session('confirmation'))).toMatchObject({
      field: 'date', targetStep: 'select_date',
    });
    expect(detectCorrection('canza adadi zuwa 3', session('confirmation'))).toMatchObject({
      field: 'quantity', targetStep: 'select_quantity',
    });
  });

  it('keeps payment and ordering review edits fail closed', () => {
    expect(detectCorrection('change to Friday', session('confirm_payment', { active_capability: 'payment' }))).toBeNull();
    expect(detectCorrection('canza adadi zuwa 3', session('review_order_summary', { active_capability: 'ordering' }))).toBeNull();
    expect(detectCorrection('cambiar la talla', session('review_order_summary', { active_capability: 'ordering' }))).toBeNull();
  });
});

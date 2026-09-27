import { describe, expect, it } from 'vitest';
import {
  buildWhatsAppLink,
  isWhatsAppClickToChatUrl,
  normalizeWhatsAppPhone,
} from '@/lib/whatsappLink';

describe('#426 WhatsApp click-to-chat link authority', () => {
  it('normalizes a + international number into wa.me digits', () => {
    expect(normalizeWhatsAppPhone('+1 (301) 555-0123')).toBe('13015550123');
  });

  it('normalizes 00 international prefix', () => {
    expect(normalizeWhatsAppPhone('0044 20 7946 0958')).toBe('442079460958');
  });

  it('encodes an optional prefilled message safely', () => {
    const result = buildWhatsAppLink({
      phone: '+234 803 123 4567',
      message: 'Hi Waaiio — launch updates & pricing?',
    });

    expect(result.url).toBe(
      'https://wa.me/2348031234567?text=Hi%20Waaiio%20%E2%80%94%20launch%20updates%20%26%20pricing%3F',
    );
  });

  it('omits the text query when message is blank', () => {
    expect(buildWhatsAppLink({ phone: '+1 301 555 0123', message: '   ' }).url)
      .toBe('https://wa.me/13015550123');
  });

  it('rejects a domestic-looking number without explicit international prefix', () => {
    expect(() => normalizeWhatsAppPhone('3015550123'))
      .toThrow(/starting with \+ or 00/i);
  });

  it('rejects URLs, letters, extensions, and unsupported characters', () => {
    expect(() => normalizeWhatsAppPhone('https://wa.me/13015550123')).toThrow();
    expect(() => normalizeWhatsAppPhone('+1 301 555 CALL')).toThrow();
    expect(() => normalizeWhatsAppPhone('+1 301 555 0123 x4')).toThrow();
    expect(() => normalizeWhatsAppPhone('+1 301 555 0123#')).toThrow();
    expect(() => normalizeWhatsAppPhone('+1+3015550123')).toThrow(/only allowed at the beginning/i);
  });

  it('rejects impossible international lengths and leading-zero country code', () => {
    expect(() => normalizeWhatsAppPhone('+123')).toThrow(/between 7 and 15/i);
    expect(() => normalizeWhatsAppPhone('+0123456789')).toThrow(/non-zero country code/i);
    expect(() => normalizeWhatsAppPhone('+1234567890123456')).toThrow(/between 7 and 15/i);
  });

  it('rejects an oversized prefilled message', () => {
    expect(() => buildWhatsAppLink({
      phone: '+1 301 555 0123',
      message: 'x'.repeat(1001),
    })).toThrow(/1000 characters or fewer/i);
  });

  it('recognizes only canonical HTTPS wa.me phone URLs', () => {
    expect(isWhatsAppClickToChatUrl('https://wa.me/13015550123')).toBe(true);
    expect(isWhatsAppClickToChatUrl('https://wa.me/13015550123?text=Hi')).toBe(true);
    expect(isWhatsAppClickToChatUrl('http://wa.me/13015550123')).toBe(false);
    expect(isWhatsAppClickToChatUrl('https://example.com/13015550123')).toBe(false);
  });
});

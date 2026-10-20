import { describe, expect, it } from 'vitest';
import { resolveRecipientCountry } from '@/lib/channels/phone-country';

describe('WhatsApp recipient country billing context', () => {
  it('resolves the same US recipient with or without a + prefix', () => {
    expect(resolveRecipientCountry('+15712746425')).toBe('US');
    expect(resolveRecipientCountry('15712746425')).toBe('US');
  });
  it('does not substitute the business or WhatsApp sender country for unknown recipients', () => {
    expect(resolveRecipientCountry('not-a-phone')).toBeNull();
  });
});

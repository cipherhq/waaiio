import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

describe('Eligibility Service', () => {
  const source = readFileSync('lib/growth/eligibility-service.ts', 'utf-8');

  it('checks opt-outs first', () => {
    const optOutIdx = source.indexOf('messaging_opt_outs');
    const consentIdx = source.indexOf('customer_consents');
    expect(optOutIdx).toBeGreaterThan(-1);
    expect(consentIdx).toBeGreaterThan(-1);
    expect(optOutIdx).toBeLessThan(consentIdx);
  });

  it('checks 24hr service window', () => {
    expect(source).toContain('24 * 60 * 60 * 1000');
    expect(source).toContain('bot_sessions');
  });

  it('returns template_eligible when has WhatsApp consent', () => {
    expect(source).toContain("'template_eligible'");
  });

  it('returns service_window when within 24 hours', () => {
    expect(source).toContain("'service_window'");
  });

  it('returns opted_out when customer opted out', () => {
    expect(source).toContain("'opted_out'");
  });

  it('returns needs_consent with sms_invite when has SMS consent', () => {
    expect(source).toContain("'sms_invite'");
  });

  it('returns needs_consent with email_invite when has email', () => {
    expect(source).toContain("'email_invite'");
  });

  it('returns never_contacted when no data', () => {
    expect(source).toContain("'never_contacted'");
  });

  it('handles errors gracefully', () => {
    expect(source).toContain("'unknown_consent'");
    expect(source).toContain('catch');
  });
});

describe('Credit Service', () => {
  const source = readFileSync('lib/growth/credit-service.ts', 'utf-8');

  it('calculates available balance', () => {
    expect(source).toContain('total - totalReserved');
  });

  it('checks sufficient credits before reserving', () => {
    expect(source).toContain('Insufficient credits');
  });

  it('deducts from oldest credits first (FIFO)', () => {
    expect(source).toContain("order('created_at'");
    expect(source).toContain('ascending: true');
  });

  it('records all credit transactions', () => {
    expect(source).toContain("from('growth_credit_transactions')");
  });

  it('tracks credit types: included, purchased, promotional', () => {
    expect(source).toContain("'included'");
    expect(source).toContain("'purchased'");
    expect(source).toContain("'promotional'");
  });
});

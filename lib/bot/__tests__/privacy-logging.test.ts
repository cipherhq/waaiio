import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

describe('Privacy and logging', () => {
  const metaWebhook = readFileSync('app/api/webhook/meta-cloud/route.ts', 'utf-8');
  const gupshupWebhook = readFileSync('app/api/webhook/whatsapp/route.ts', 'utf-8');
  const botService = readFileSync('lib/bot/bot.service.ts', 'utf-8');

  describe('Log redaction', () => {
    it('Gupshup webhook does not log raw body', () => {
      expect(gupshupWebhook).not.toContain('rawBody.slice(0, 2000)');
      expect(gupshupWebhook).toContain('bodyLength');
    });

    it('webhooks do not log full phone numbers', () => {
      // Should use slice(-4) for phone logging
      expect(metaWebhook).toContain('slice(-4)');
    });

    it('bot service does not log message text', () => {
      expect(botService).toContain('textLen');
    });
  });

  describe('Media privacy', () => {
    it('Meta webhook uses signed URLs for audio', () => {
      expect(metaWebhook).toContain('createSignedUrl');
      expect(metaWebhook).not.toMatch(/getPublicUrl.*audio/);
    });

    it('Gupshup webhook uses signed URLs for audio', () => {
      expect(gupshupWebhook).toContain('createSignedUrl');
    });
  });

  describe('Timezone', () => {
    const smartIntent = readFileSync('lib/bot/smart-intent.ts', 'utf-8');

    it('date parser accepts timezone parameter', () => {
      expect(smartIntent).toContain('timezone');
      expect(smartIntent).toContain('getBusinessLocalDate');
    });

    it('uses Intl.DateTimeFormat for timezone conversion', () => {
      expect(smartIntent).toContain('Intl.DateTimeFormat');
      expect(smartIntent).toContain('timeZone');
    });
  });
});

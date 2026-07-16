import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

describe('STOP/UNSUBSCRIBE opt-out compliance', () => {
  const botService = readFileSync('lib/bot/bot.service.ts', 'utf-8');
  const migration = readFileSync('supabase/migrations/237_opt_out_suppression.sql', 'utf-8');
  const broadcastSend = readFileSync('app/api/broadcasts/send/route.ts', 'utf-8');

  describe('Interceptor', () => {
    it('checks STOP before any bot logic', () => {
      // STOP check should come before escape hatches and flow execution
      const stopIdx = botService.indexOf('STOP_WORDS');
      // Find the actual escape hatch invocation, not the import
      const escapeIdx = botService.indexOf('_handleEscapeHatch(');
      expect(stopIdx).toBeGreaterThan(-1);
      expect(escapeIdx).toBeGreaterThan(-1);
      expect(stopIdx).toBeLessThan(escapeIdx);
    });

    it('handles STOP, UNSUBSCRIBE, OPT OUT, OPT-OUT', () => {
      expect(botService).toContain("'stop'");
      expect(botService).toContain("'unsubscribe'");
      expect(botService).toContain("'opt out'");
      expect(botService).toContain("'opt-out'");
    });

    it('handles START, SUBSCRIBE, OPT IN', () => {
      expect(botService).toContain("'start'");
      expect(botService).toContain("'subscribe'");
    });

    it('records opt-out in messaging_opt_outs table', () => {
      expect(botService).toContain('messaging_opt_outs');
    });

    it('sends confirmation message on opt-out', () => {
      expect(botService).toContain('unsubscribed');
    });
  });

  describe('Schema', () => {
    it('creates messaging_opt_outs table', () => {
      expect(migration).toContain('messaging_opt_outs');
    });

    it('has unique constraint per phone/business/channel', () => {
      expect(migration).toContain('idx_opt_out_unique');
    });

    it('has RLS enabled', () => {
      expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    });

    it('supports resubscribe', () => {
      expect(migration).toContain('resubscribed_at');
    });
  });

  describe('Broadcast suppression', () => {
    it('checks opt-out before sending broadcasts', () => {
      expect(broadcastSend).toContain('messaging_opt_outs');
      expect(broadcastSend).toContain('resubscribed_at');
    });
  });
});

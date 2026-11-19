/**
 * Slice 0C — Admin Broadcasts misleading-channel cleanup (#439)
 *
 * Proves:
 * - SMS is disabled / not selectable
 * - WhatsApp: was disabled here; turned on by #1104
 * - Email remains selectable and functional
 * - Existing broadcast history display is untouched
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const BROADCASTS_SRC = fs.readFileSync(
  path.resolve(__dirname, '../pages/Broadcasts.tsx'),
  'utf-8',
);

describe('Slice 0C — Admin Broadcasts channel cleanup (#439)', () => {
  // #1131 (Owner decision 2026-11-18): SMS is on. Its behaviour is proved on
  // the rendered page in broadcasts-sms-1131.test.tsx.
  it('SMS option is enabled (#1131)', () => {
    const smsLine = BROADCASTS_SRC.match(/\{[^}]*value:\s*'sms'[^}]*\}/);
    expect(smsLine).not.toBeNull();
    expect(smsLine![0]).not.toContain('disabled');
    expect(smsLine![0]).not.toMatch(/coming soon/i);
  });

  // #1104 (Owner request 2026-11-17): WhatsApp is on. Its behaviour is proved
  // on the rendered page in broadcasts-whatsapp-1104.test.tsx.
  it('WhatsApp option is enabled (#1104)', () => {
    const whatsappLine = BROADCASTS_SRC.match(/\{[^}]*value:\s*'whatsapp'[^}]*\}/);
    expect(whatsappLine).not.toBeNull();
    expect(whatsappLine![0]).not.toContain('disabled');
    expect(whatsappLine![0]).not.toMatch(/coming soon/i);
  });

  it('Email option is NOT disabled', () => {
    // Email entry should not have disabled: true
    const emailLine = BROADCASTS_SRC.match(/\{[^}]*value:\s*'email'[^}]*\}/);
    expect(emailLine).not.toBeNull();
    expect(emailLine![0]).not.toContain('disabled');
  });

  it('disabled buttons cannot be clicked (disabled attribute present)', () => {
    // The button rendering should use opt.disabled
    expect(BROADCASTS_SRC).toContain('disabled={opt.disabled}');
  });

  it('disabled buttons have cursor-not-allowed styling', () => {
    expect(BROADCASTS_SRC).toContain('cursor-not-allowed');
  });

  it('broadcast history table still renders (no removal of history section)', () => {
    // The page should still have the history table rendering broadcasts
    expect(BROADCASTS_SRC).toContain('pageItems');
    expect(BROADCASTS_SRC).toContain('broadcasts');
    expect(BROADCASTS_SRC).toContain('admin_broadcasts');
  });

  it('email delivery logic is preserved', () => {
    // The email sending fetch to /api/email/send should still exist
    expect(BROADCASTS_SRC).toContain('/api/email/send');
  });
});

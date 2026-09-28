/**
 * Slice 0C — Admin Broadcasts misleading-channel cleanup (#439)
 *
 * Proves:
 * - SMS is disabled / not selectable
 * - WhatsApp is disabled / not selectable ("Coming soon")
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
  it('SMS option is marked disabled', () => {
    // The sms entry should have disabled: true
    expect(BROADCASTS_SRC).toMatch(/value:\s*'sms'.*disabled:\s*true/s);
  });

  it('SMS label indicates coming soon', () => {
    expect(BROADCASTS_SRC).toMatch(/sms.*coming soon/i);
  });

  it('WhatsApp option is marked disabled', () => {
    expect(BROADCASTS_SRC).toMatch(/value:\s*'whatsapp'.*disabled:\s*true/s);
  });

  it('WhatsApp label indicates coming soon', () => {
    expect(BROADCASTS_SRC).toMatch(/whatsapp.*coming soon/i);
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

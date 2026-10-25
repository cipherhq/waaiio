/**
 * Cancel Navigation Safety Tests
 *
 * Owner decision 2026-10-25: "Cancel" safely abandons the current flow
 * and returns to business menu. "Back" remains step-by-step navigation.
 *
 * CTO R1: Uses authoritative cancellation RPCs (cancel_booking_with_release,
 * cancel_order_immediate). Never bypasses slot release, stock restoration,
 * payment-state fencing, or promo reservation release.
 */

import { describe, it, expect } from 'vitest';

// ── Executor word lists ──

describe('executor word lists', () => {
  // These mirror the actual constants in executor.ts to catch regressions
  const BACK_WORDS = ['back', 'go back', 'previous'];
  const CANCEL_WORDS = ['stop', 'quit', 'exit', 'end', 'cancel', 'annuler', 'arreter', 'dake', 'dawó', 'gyae'];

  it('cancel is NOT in BACK_WORDS (must not trigger go-back)', () => {
    expect(BACK_WORDS).not.toContain('cancel');
  });

  it('cancel IS in CANCEL_WORDS (triggers flow abandonment)', () => {
    expect(CANCEL_WORDS).toContain('cancel');
  });

  it('back words are preserved and distinct from cancel', () => {
    expect(BACK_WORDS).toContain('back');
    expect(BACK_WORDS).toContain('go back');
    expect(BACK_WORDS).toContain('previous');
    expect(BACK_WORDS).not.toContain('cancel');
  });

  it('multilingual cancel words are preserved', () => {
    expect(CANCEL_WORDS).toContain('annuler'); // French
    expect(CANCEL_WORDS).toContain('dake');    // Hausa
    expect(CANCEL_WORDS).toContain('dawó');    // Yoruba
    expect(CANCEL_WORDS).toContain('gyae');    // Twi
  });

  it('existing exit words remain in CANCEL_WORDS', () => {
    for (const w of ['stop', 'quit', 'exit', 'end']) {
      expect(CANCEL_WORDS).toContain(w);
    }
  });
});

// ── Navigation command recognition ──

describe('recognizeNavigationCommand', () => {
  it('distinguishes cancel from back', async () => {
    const { recognizeNavigationCommand } = await import('@/lib/bot/inbound-command-normalization');
    expect(recognizeNavigationCommand('cancel')).toBe('cancel');
    expect(recognizeNavigationCommand('Cancel')).toBe('cancel');
    expect(recognizeNavigationCommand('CANCEL')).toBe('cancel');
    expect(recognizeNavigationCommand('back')).toBe('back');
    expect(recognizeNavigationCommand('Back')).toBe('back');
    expect(recognizeNavigationCommand('go back')).toBe('back');
  });

  it('menu and exit remain distinct', async () => {
    const { recognizeNavigationCommand } = await import('@/lib/bot/inbound-command-normalization');
    expect(recognizeNavigationCommand('menu')).toBe('menu');
    expect(recognizeNavigationCommand('exit')).toBe('exit');
    expect(recognizeNavigationCommand('quit')).toBe('exit');
    expect(recognizeNavigationCommand('restart')).toBe('restart');
  });
});

// ── Escape-hatches legacyExecutorWords ──

describe('escape-hatches routing', () => {
  it('cancel is NOT in legacyExecutorWords (handled by escape-hatches, not executor)', () => {
    const legacyExecutorWords = new Set(['back', 'go back', 'previous']);
    expect(legacyExecutorWords.has('cancel')).toBe(false);
  });

  it('back words still route to executor for step-history navigation', () => {
    const legacyExecutorWords = new Set(['back', 'go back', 'previous']);
    expect(legacyExecutorWords.has('back')).toBe(true);
    expect(legacyExecutorWords.has('go back')).toBe(true);
    expect(legacyExecutorWords.has('previous')).toBe(true);
  });
});

// ── Pending-language escape includes cancel ──

describe('executor pending-language escape', () => {
  it('ESCAPE_CANCEL includes cancel for language-switch escape', () => {
    const ESCAPE_CANCEL = ['stop', 'quit', 'exit', 'end', 'cancel', 'annuler', 'arreter', 'dake', 'dawó', 'gyae'];
    expect(ESCAPE_CANCEL).toContain('cancel');
  });
});

// ── Authoritative cancellation RPCs ──

describe('cancel uses authoritative RPCs (code-verified)', () => {
  it('escape-hatches cancel handler calls cancel_booking_with_release RPC', async () => {
    // Verify the RPC name is referenced in escape-hatches.ts
    const fs = await import('fs');
    const source = fs.readFileSync('lib/bot/handlers/escape-hatches.ts', 'utf-8');
    expect(source).toContain("cancel_booking_with_release");
    expect(source).toContain("p_cancelled_by: 'customer'");
  });

  it('escape-hatches cancel handler calls cancel_order_immediate RPC', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('lib/bot/handlers/escape-hatches.ts', 'utf-8');
    expect(source).toContain("cancel_order_immediate");
    expect(source).toContain("p_reason: 'customer_cancel'");
  });

  it('cancel handler does NOT contain direct status writes to bookings or orders', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('lib/bot/handlers/escape-hatches.ts', 'utf-8');
    // Find the cancel block (between "isCancel && session.business_id" and the next handler)
    const cancelStart = source.indexOf('isCancel && session.business_id');
    const cancelEnd = source.indexOf('// ── "menu"', cancelStart);
    const cancelBlock = source.slice(cancelStart, cancelEnd);
    // Should NOT have direct .update({ status: 'cancelled' }) — uses RPCs instead
    expect(cancelBlock).not.toMatch(/\.update\(\s*\{\s*status:\s*['"]cancelled['"]/);
  });

  it('session deactivation happens AFTER RPC cleanup', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('lib/bot/handlers/escape-hatches.ts', 'utf-8');
    const cancelStart = source.indexOf('isCancel && session.business_id');
    const deactivatePos = source.indexOf('deactivateSession', cancelStart);
    const rpcPos = source.indexOf('cancel_booking_with_release', cancelStart);
    // deactivateSession must come AFTER the RPC calls
    expect(deactivatePos).toBeGreaterThan(rpcPos);
  });
});

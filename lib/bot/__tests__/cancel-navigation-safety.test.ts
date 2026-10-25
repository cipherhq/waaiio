/**
 * Cancel Navigation Safety — Comprehensive Behavioral Tests
 *
 * Owner decision 2026-10-25: "Cancel" safely abandons the current flow
 * and returns to business menu. "Back" remains step-by-step navigation.
 *
 * All navigation commands (Cancel, Menu, Exit, Restart) use the shared
 * safeFlowCleanup function which calls authoritative cancellation RPCs.
 */

import { describe, it, expect } from 'vitest';

// ── 1. Word list correctness ──

describe('executor BACK_WORDS and CANCEL_WORDS', () => {
  it('cancel is in CANCEL_WORDS, not BACK_WORDS', async () => {
    const src = (await import('fs')).readFileSync('lib/bot/flows/executor.ts', 'utf-8');
    const backMatch = src.match(/const BACK_WORDS = \[([^\]]+)\]/);
    expect(backMatch).toBeTruthy();
    expect(backMatch![1]).not.toContain("'cancel'");
    const cancelMatch = src.match(/const CANCEL_WORDS = \[([^\]]+)\]/);
    expect(cancelMatch).toBeTruthy();
    expect(cancelMatch![1]).toContain("'cancel'");
  });
});

// ── 2. Navigation command recognition ──

describe('recognizeNavigationCommand', () => {
  it('cancel and back are distinct commands', async () => {
    const { recognizeNavigationCommand } = await import('@/lib/bot/inbound-command-normalization');
    expect(recognizeNavigationCommand('cancel')).toBe('cancel');
    expect(recognizeNavigationCommand('back')).toBe('back');
    expect(recognizeNavigationCommand('Cancel')).toBe('cancel');
    expect(recognizeNavigationCommand('BACK')).toBe('back');
  });
});

// ── 3. safeFlowCleanup uses authoritative RPCs ──

describe('safeFlowCleanup — authoritative cancellation', () => {
  it('calls cancel_booking_with_release for bookings', async () => {
    const src = (await import('fs')).readFileSync('lib/bot/handlers/escape-hatches.ts', 'utf-8');
    // Find the safeFlowCleanup function
    const fnStart = src.indexOf('export async function safeFlowCleanup');
    const fnEnd = src.indexOf('\ntype TestableCommandPattern', fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    expect(fnBody).toContain("cancel_booking_with_release");
    expect(fnBody).toContain("p_cancelled_by: 'customer'");
    // No direct status writes in safeFlowCleanup
    expect(fnBody).not.toMatch(/\.from\(['"]bookings['"]\)[\s\S]*?\.update\(\s*\{[\s\S]*?status/);
    expect(fnBody).not.toMatch(/\.from\(['"]orders['"]\)[\s\S]*?\.update\(\s*\{[\s\S]*?status/);
  });

  it('calls cancel_order_immediate for orders', async () => {
    const src = (await import('fs')).readFileSync('lib/bot/handlers/escape-hatches.ts', 'utf-8');
    const fnStart = src.indexOf('export async function safeFlowCleanup');
    const fnEnd = src.indexOf('\ntype TestableCommandPattern', fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    expect(fnBody).toContain("cancel_order_immediate");
    expect(fnBody).toContain("p_reason: 'customer_cancel'");
  });

  it('handles RPC errors and returns false on failure', async () => {
    const src = (await import('fs')).readFileSync('lib/bot/handlers/escape-hatches.ts', 'utf-8');
    const fnStart = src.indexOf('export async function safeFlowCleanup');
    const fnEnd = src.indexOf('\ntype TestableCommandPattern', fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    expect(fnBody).toContain('ok = false');
    expect(fnBody).toContain('return ok');
  });

  it('preserves non-cancellable bookings and orders', async () => {
    const src = (await import('fs')).readFileSync('lib/bot/handlers/escape-hatches.ts', 'utf-8');
    const fnStart = src.indexOf('export async function safeFlowCleanup');
    const fnEnd = src.indexOf('\ntype TestableCommandPattern', fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    expect(fnBody).toContain('!result.cancelled');
    expect(fnBody).toContain('not cancellable, preserving');
  });
});

// ── 4. All navigation commands use safeFlowCleanup ──

describe('navigation commands share safeFlowCleanup', () => {
  it('cancel handler uses safeFlowCleanup', async () => {
    const src = (await import('fs')).readFileSync('lib/bot/handlers/escape-hatches.ts', 'utf-8');
    const cancelStart = src.indexOf('isCancel && session.business_id');
    const cancelEnd = src.indexOf("// ── \"menu\"", cancelStart);
    expect(src.slice(cancelStart, cancelEnd)).toContain('safeFlowCleanup');
  });

  it('menu handler uses safeFlowCleanup', async () => {
    const src = (await import('fs')).readFileSync('lib/bot/handlers/escape-hatches.ts', 'utf-8');
    const menuStart = src.indexOf('isMenuWord && session.business_id');
    const menuEnd = src.indexOf("// ── \"back\"", menuStart);
    const menuBlock = src.slice(menuStart, menuEnd);
    expect(menuBlock).toContain('safeFlowCleanup');
    // No direct status writes
    expect(menuBlock).not.toMatch(/\.update\(\s*\{\s*status:\s*['"]cancelled/);
  });

  it('exit handler uses safeFlowCleanup', async () => {
    const src = (await import('fs')).readFileSync('lib/bot/handlers/escape-hatches.ts', 'utf-8');
    const exitStart = src.indexOf('"exit" / "quit" / "stop"');
    const exitEnd = src.indexOf('// Find the business', exitStart);
    const exitBlock = src.slice(exitStart, exitEnd);
    expect(exitBlock).toContain('safeFlowCleanup');
    // No direct status writes
    expect(exitBlock).not.toMatch(/\.update\(\s*\{\s*status:\s*['"]cancelled/);
  });

  it('executor cancel uses safeFlowCleanup', async () => {
    const src = (await import('fs')).readFileSync('lib/bot/flows/executor.ts', 'utf-8');
    const cancelStart = src.indexOf("CANCEL_WORDS.includes(lowerInput)");
    const cancelEnd = src.indexOf("RESTART_WORDS.includes(lowerInput)");
    const cancelBlock = src.slice(cancelStart, cancelEnd);
    expect(cancelBlock).toContain('safeFlowCleanup');
  });

  it('executor restart uses safeFlowCleanup', async () => {
    const src = (await import('fs')).readFileSync('lib/bot/flows/executor.ts', 'utf-8');
    const restartStart = src.indexOf("RESTART_WORDS.includes(lowerInput)");
    const restartEnd = src.indexOf("const restartLang", restartStart);
    const restartBlock = src.slice(restartStart, restartEnd);
    expect(restartBlock).toContain('safeFlowCleanup');
  });
});

// ── 5. No direct booking/order status writes remain ──

describe('no direct cancellation status writes in navigation', () => {
  it('escape-hatches has no direct booking/order cancel writes outside safeFlowCleanup', async () => {
    const src = (await import('fs')).readFileSync('lib/bot/handlers/escape-hatches.ts', 'utf-8');
    // Exclude safeFlowCleanup function itself — only check the handler code
    const fnEnd = src.indexOf('\ntype TestableCommandPattern');
    const handlerCode = src.slice(fnEnd);
    // No .from('bookings').update({status:'cancelled'}) or .from('orders').update({status:'cancelled'})
    expect(handlerCode).not.toMatch(/\.from\(['"]bookings['"]\)[\s\S]{0,100}\.update\(\s*\{[\s\S]{0,50}cancelled/);
    expect(handlerCode).not.toMatch(/\.from\(['"]orders['"]\)[\s\S]{0,100}\.update\(\s*\{[\s\S]{0,50}cancelled/);
  });

  it('executor has zero direct booking/order cancel writes', async () => {
    const src = (await import('fs')).readFileSync('lib/bot/flows/executor.ts', 'utf-8');
    // Find all .from('bookings').update({status:'cancelled'}) and .from('orders').update({status:'cancelled'})
    const bookingWrites = (src.match(/\.from\(['"]bookings['"]\)[\s\S]*?\.update\(\s*\{[\s\S]*?status.*cancelled/g) || []);
    const orderWrites = (src.match(/\.from\(['"]orders['"]\)[\s\S]*?\.update\(\s*\{[\s\S]*?status.*cancelled/g) || []);
    expect(bookingWrites.length).toBe(0);
    expect(orderWrites.length).toBe(0);
  });
});

// ── 6. Cancel handler keeps session active on cleanup failure ──

describe('cancel recovery on cleanup failure', () => {
  it('cancel handler checks cleanupOk before deactivating', async () => {
    const src = (await import('fs')).readFileSync('lib/bot/handlers/escape-hatches.ts', 'utf-8');
    const cancelStart = src.indexOf('isCancel && session.business_id');
    const cancelEnd = src.indexOf("// ── \"menu\"", cancelStart);
    const cancelBlock = src.slice(cancelStart, cancelEnd);
    expect(cancelBlock).toContain('cleanupOk');
    expect(cancelBlock).toContain('cancel_retry');
    // deactivateSession only called when cleanup succeeds
    const deactivatePos = cancelBlock.indexOf('deactivateSession');
    const failCheckPos = cancelBlock.indexOf('!cleanupOk');
    expect(deactivatePos).toBeGreaterThan(failCheckPos);
  });
});

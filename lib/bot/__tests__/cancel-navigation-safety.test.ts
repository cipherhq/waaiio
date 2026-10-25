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
  it('calls cancel_pending_booking_for_navigation for bookings', async () => {
    const src = (await import('fs')).readFileSync('lib/bot/handlers/escape-hatches.ts', 'utf-8');
    // Find the safeFlowCleanup function
    const fnStart = src.indexOf('export async function safeFlowCleanup');
    const fnEnd = src.indexOf('\ntype TestableCommandPattern', fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    expect(fnBody).toContain("cancel_pending_booking_for_navigation");
    // No direct booking status writes in safeFlowCleanup (select is OK, update is not)
    expect(fnBody).not.toMatch(/\.from\(['"]bookings['"]\)[\s\S]{0,30}\.update\(\s*\{[\s\S]{0,50}status/);
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
    const deactivatePos = cancelBlock.indexOf('deactivateSession');
    const failCheckPos = cancelBlock.indexOf('!cleanupOk');
    expect(deactivatePos).toBeGreaterThan(failCheckPos);
  });
});

// ── 7. Executable safeFlowCleanup tests with mocked Supabase ──

describe('safeFlowCleanup — executable behavior', async () => {
  const { vi } = await import('vitest');
  const { safeFlowCleanup } = await import('@/lib/bot/handlers/escape-hatches');

  function mockSupabase(
    rpcResults: Record<string, { data: unknown; error: unknown }>,
    bookingStatus: string = 'pending',
  ) {
    return {
      rpc: vi.fn(async (fn: string, params: Record<string, unknown>) => {
        return rpcResults[fn] || { data: null, error: null };
      }),
      from: vi.fn((table: string) => {
        if (table === 'bookings') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({ data: { id: 'bk-mock', status: bookingStatus }, error: null })),
              })),
            })),
          };
        }
        return {
          update: vi.fn(() => ({
            eq: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) })),
          })),
        };
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;
  }

  it('calls cancel_pending_booking_for_navigation with correct params', async () => {
    const sb = mockSupabase({
      cancel_pending_booking_for_navigation: { data: { cancelled: true }, error: null },
    });
    const ok = await safeFlowCleanup(sb, { booking_id: 'bk-1' }, 'user-1');
    expect(ok).toBe(true);
    expect(sb.rpc).toHaveBeenCalledWith('cancel_pending_booking_for_navigation', {
      p_booking_id: 'bk-1',
      p_expected_user_id: 'user-1',
    });
  });

  it('calls cancel_order_immediate with p_reason=customer_cancel', async () => {
    const sb = mockSupabase({
      cancel_order_immediate: { data: { cancelled: true, stock_restored: true }, error: null },
    });
    const ok = await safeFlowCleanup(sb, { order_id: 'ord-1' }, 'user-1');
    expect(ok).toBe(true);
    expect(sb.rpc).toHaveBeenCalledWith('cancel_order_immediate', {
      p_order_id: 'ord-1',
      p_reason: 'customer_cancel',
    });
  });

  it('returns false when booking RPC fails (transport error)', async () => {
    const sb = mockSupabase({
      cancel_pending_booking_for_navigation: { data: null, error: { message: 'connection reset' } },
    });
    const ok = await safeFlowCleanup(sb, { booking_id: 'bk-fail' }, 'user-1');
    expect(ok).toBe(false);
  });

  it('returns false when order RPC fails (transport error)', async () => {
    const sb = mockSupabase({
      cancel_order_immediate: { data: null, error: { message: 'timeout' } },
    });
    const ok = await safeFlowCleanup(sb, { order_id: 'ord-fail' }, 'user-1');
    expect(ok).toBe(false);
  });

  it('preserves confirmed bookings atomically via RPC (not_pending response)', async () => {
    // The RPC itself checks status atomically with FOR UPDATE
    const sb = mockSupabase({
      cancel_pending_booking_for_navigation: { data: { cancelled: false, reason: 'not_pending', status: 'confirmed' }, error: null },
    });
    const ok = await safeFlowCleanup(sb, { booking_id: 'bk-confirmed' }, 'user-1');
    expect(ok).toBe(true); // Confirmed booking preserved — not a failure
    expect(sb.rpc).toHaveBeenCalledWith('cancel_pending_booking_for_navigation', expect.anything());
  });

  it('cancels pending bookings via atomic RPC', async () => {
    const sb = mockSupabase({
      cancel_pending_booking_for_navigation: { data: { cancelled: true, session_released: false }, error: null },
    });
    const ok = await safeFlowCleanup(sb, { booking_id: 'bk-pending' }, 'user-1');
    expect(ok).toBe(true);
    expect(sb.rpc).toHaveBeenCalledWith('cancel_pending_booking_for_navigation', {
      p_booking_id: 'bk-pending',
      p_expected_user_id: 'user-1',
    });
  });

  it('handles not_found booking from RPC gracefully', async () => {
    const sb = mockSupabase({
      cancel_pending_booking_for_navigation: { data: { cancelled: false, reason: 'not_found' }, error: null },
    });
    const ok = await safeFlowCleanup(sb, { booking_id: 'bk-gone' }, 'user-1');
    expect(ok).toBe(true); // Not found = booking preserved, not a cleanup failure
  });

  it('handles RPC not_owner response without false success', async () => {
    const sb = mockSupabase({
      cancel_pending_booking_for_navigation: { data: { cancelled: false, reason: 'not_owner' }, error: null },
    });
    const ok = await safeFlowCleanup(sb, { booking_id: 'bk-other' }, 'user-1');
    expect(ok).toBe(true); // not_owner = booking preserved, not a cleanup failure
  });

  it('handles null RPC response as failure', async () => {
    const sb = mockSupabase({
      cancel_pending_booking_for_navigation: { data: null, error: null },
    });
    const ok = await safeFlowCleanup(sb, { booking_id: 'bk-null' }, 'user-1');
    expect(ok).toBe(false); // Null response = treat as failure
  });

  it('returns true when order has successful payment (preserved)', async () => {
    const sb = mockSupabase({
      cancel_order_immediate: { data: { cancelled: false, reason: 'has_successful_payment' }, error: null },
    });
    const ok = await safeFlowCleanup(sb, { order_id: 'ord-paid' }, 'user-1');
    expect(ok).toBe(true); // Paid order preserved — not a cleanup failure
  });

  it('returns true when no booking or order exists (nothing to clean)', async () => {
    const sb = mockSupabase({});
    const ok = await safeFlowCleanup(sb, {}, 'user-1');
    expect(ok).toBe(true);
    expect(sb.rpc).not.toHaveBeenCalled();
  });

  it('handles both booking AND order in same session', async () => {
    const sb = mockSupabase({
      cancel_pending_booking_for_navigation: { data: { cancelled: true }, error: null },
      cancel_order_immediate: { data: { cancelled: true, stock_restored: true }, error: null },
    });
    const ok = await safeFlowCleanup(sb, { booking_id: 'bk-both', order_id: 'ord-both' }, 'user-1');
    expect(ok).toBe(true);
    expect(sb.rpc).toHaveBeenCalledTimes(2);
  });

  it('booking failure does not prevent order cleanup attempt', async () => {
    const sb = mockSupabase({
      cancel_pending_booking_for_navigation: { data: null, error: { message: 'db error' } },
      cancel_order_immediate: { data: { cancelled: true }, error: null },
    });
    const ok = await safeFlowCleanup(sb, { booking_id: 'bk-err', order_id: 'ord-ok' }, 'user-1');
    expect(ok).toBe(false); // Overall failed because booking cleanup failed
    expect(sb.rpc).toHaveBeenCalledTimes(2); // But order cleanup was still attempted
  });

  it('bank transfer update failure returns false', async () => {
    const sb = {
      rpc: vi.fn(async () => ({ data: null, error: null })),
      from: vi.fn(() => ({
        update: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => Promise.resolve({ error: { message: 'connection reset' } })),
          })),
        })),
      })),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;
    const ok = await safeFlowCleanup(sb, { bank_transfer_reference: 'WA-BT-001' }, 'user-1');
    expect(ok).toBe(false);
  });

  it('bank transfer success returns true', async () => {
    const sb = mockSupabase({});
    const ok = await safeFlowCleanup(sb, { bank_transfer_reference: 'WA-BT-002' }, 'user-1');
    expect(ok).toBe(true);
  });
});

// ── 8. All callers check cleanup result ──

describe('all navigation callers check safeFlowCleanup result', () => {
  it('cancel handler checks cleanupOk', async () => {
    const src = (await import('fs')).readFileSync('lib/bot/handlers/escape-hatches.ts', 'utf-8');
    const block = src.slice(src.indexOf('isCancel && session.business_id'), src.indexOf("// ── \"menu\""));
    expect(block).toContain('cleanupOk');
    expect(block).toContain('!cleanupOk');
  });

  it('menu handler checks menuCleanupOk', async () => {
    const src = (await import('fs')).readFileSync('lib/bot/handlers/escape-hatches.ts', 'utf-8');
    const block = src.slice(src.indexOf('isMenuWord && session.business_id'), src.indexOf("// ── \"back\""));
    expect(block).toContain('menuCleanupOk');
    expect(block).toContain('!menuCleanupOk');
  });

  it('exit handler checks exitCleanupOk', async () => {
    const src = (await import('fs')).readFileSync('lib/bot/handlers/escape-hatches.ts', 'utf-8');
    const block = src.slice(src.indexOf('"exit" / "quit" / "stop"'), src.indexOf('// Find the business'));
    expect(block).toContain('exitCleanupOk');
    expect(block).toContain('!exitCleanupOk');
  });

  it('executor cancel checks cancelCleanupOk', async () => {
    const src = (await import('fs')).readFileSync('lib/bot/flows/executor.ts', 'utf-8');
    const block = src.slice(src.indexOf('CANCEL_WORDS.includes(lowerInput)'), src.indexOf('RESTART_WORDS.includes(lowerInput)'));
    expect(block).toContain('cancelCleanupOk');
    expect(block).toContain('!cancelCleanupOk');
  });

  it('executor restart checks restartCleanupOk', async () => {
    const src = (await import('fs')).readFileSync('lib/bot/flows/executor.ts', 'utf-8');
    const restartStart = src.indexOf('RESTART_WORDS.includes(lowerInput)');
    const block = src.slice(restartStart, src.indexOf('const restartLang', restartStart));
    expect(block).toContain('restartCleanupOk');
    expect(block).toContain('!restartCleanupOk');
  });
});

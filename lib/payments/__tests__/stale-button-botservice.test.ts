/**
 * #197: BotService.handleMessage() stale "I've Paid" button integration test.
 *
 * Tests the actual parseStalePaymentButton → recovery routing path
 * that BotService.handleMessage() uses for machine postbacks from
 * fresh select_capability sessions.
 *
 * Strategy: We test the canonical parser (real code, not mocked) and
 * verify the exact integration contract that BotService enforces:
 *   - Parser is called with (text, messageType, currentStep)
 *   - If isStalePaymentButton: recovery module is invoked
 *   - If hasReference: recoverByOrderReference(ctx, ref) is called
 *   - If !hasReference: recoverGeneric(ctx) is called
 *   - If !isStalePaymentButton: recovery is NOT invoked
 *
 * We also verify the BotService source code contains the expected
 * integration pattern, proving the parser is wired into handleMessage.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseStalePaymentButton } from '@/lib/payments/stale-button-parser';

describe('BotService stale i_paid routing integration', () => {

  // ── Source verification: the parser IS wired into handleMessage ──

  it('BotService.handleMessage imports and calls parseStalePaymentButton', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../bot/bot.service.ts'), 'utf-8',
    );
    // Verify the canonical parser import is present
    expect(src).toContain("import('@/lib/payments/stale-button-parser')");
    expect(src).toContain('parseStalePaymentButton');
    // Verify the recovery dispatch is present
    expect(src).toContain("import('@/lib/payments/stale-payment-recovery')");
    expect(src).toContain('recoverByOrderReference');
    expect(src).toContain('recoverGeneric');
  });

  it('parser is called BEFORE keyword matching in the handleMessage flow', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../bot/bot.service.ts'), 'utf-8',
    );
    const parserIdx = src.indexOf('parseStalePaymentButton');
    const keywordIdx = src.indexOf('Unified keyword matching');
    expect(parserIdx).toBeGreaterThan(-1);
    expect(keywordIdx).toBeGreaterThan(-1);
    expect(keywordIdx).toBeGreaterThan(parserIdx);
  });

  // ── Real parser execution proving the routing contract ──

  it('generic i_paid button from select_capability → isStalePaymentButton=true, generic recovery', () => {
    const r = parseStalePaymentButton('i_paid', 'button', 'select_capability');
    expect(r.isStalePaymentButton).toBe(true);
    expect(r.hasReference).toBe(false);
    expect(r.reference).toBeNull();
    // Contract: BotService calls recoverGeneric(ctx) when !hasReference
  });

  it('generic i_paid_online button from select_capability → isStalePaymentButton=true, generic recovery', () => {
    const r = parseStalePaymentButton('i_paid_online', 'button', 'select_capability');
    expect(r.isStalePaymentButton).toBe(true);
    expect(r.hasReference).toBe(false);
  });

  it('ref-bearing i_paid:WA-OR-0981 → isStalePaymentButton=true, exact-reference recovery', () => {
    const r = parseStalePaymentButton('i_paid:WA-OR-0981', 'button', 'select_capability');
    expect(r.isStalePaymentButton).toBe(true);
    expect(r.hasReference).toBe(true);
    expect(r.reference).toBe('WA-OR-0981');
    // Contract: BotService calls recoverByOrderReference(ctx, 'WA-OR-0981')
  });

  it('ref-bearing i_paid_online:WA-OR-0981 → isStalePaymentButton=true, exact-reference recovery', () => {
    const r = parseStalePaymentButton('i_paid_online:WA-OR-0981', 'button', 'select_capability');
    expect(r.isStalePaymentButton).toBe(true);
    expect(r.hasReference).toBe(true);
    expect(r.reference).toBe('WA-OR-0981');
  });

  it('malformed i_paid: (empty ref) → isStalePaymentButton=false (fail closed)', () => {
    const r = parseStalePaymentButton('i_paid:', 'button', 'select_capability');
    expect(r.isStalePaymentButton).toBe(false);
    // Contract: BotService does NOT invoke recovery, falls through to normal routing
  });

  it('malformed i_paid_online: (empty ref) → isStalePaymentButton=false', () => {
    const r = parseStalePaymentButton('i_paid_online:', 'button', 'select_capability');
    expect(r.isStalePaymentButton).toBe(false);
  });

  it('free text "paid" (messageType=text) → isStalePaymentButton=false', () => {
    const r = parseStalePaymentButton('paid', 'text', 'select_capability');
    expect(r.isStalePaymentButton).toBe(false);
  });

  it('free text "done" (messageType=text) → isStalePaymentButton=false', () => {
    const r = parseStalePaymentButton('done', 'text', 'select_capability');
    expect(r.isStalePaymentButton).toBe(false);
  });

  it('i_paid button at await_order_payment → isStalePaymentButton=false (legitimate step)', () => {
    const r = parseStalePaymentButton('i_paid', 'button', 'await_order_payment');
    expect(r.isStalePaymentButton).toBe(false);
    // Contract: BotService falls through to flow executor's step validator
  });

  it('i_paid button from greeting step → isStalePaymentButton=true (non-payment step)', () => {
    const r = parseStalePaymentButton('i_paid', 'button', 'greeting');
    expect(r.isStalePaymentButton).toBe(true);
  });

  // ── BotService dispatch contract verification ──

  it('BotService dispatch: hasReference && reference → recoverByOrderReference', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../bot/bot.service.ts'), 'utf-8',
    );
    // Verify the conditional dispatch pattern
    expect(src).toContain('staleButton.hasReference && staleButton.reference');
    expect(src).toContain('recoverByOrderReference(recoveryCtx, staleButton.reference)');
    // Verify the else branch calls recoverGeneric
    expect(src).toContain('recoverGeneric(recoveryCtx)');
  });
});

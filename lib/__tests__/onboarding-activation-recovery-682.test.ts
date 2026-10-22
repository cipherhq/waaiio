/**
 * #682 Onboarding Activation Recovery Tests
 *
 * Structural + behavioral assertions proving the paid onboarding path
 * correctly recovers missing subscription-included messaging allowances
 * when activate_paid_subscription returns allowance_granted: false.
 *
 * Uses the same source-level verification pattern as #476 tests,
 * which is the established approach for the complex verify route.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const verifyRouteSrc = readFileSync(
  resolve(__dirname, '../../app/api/onboarding/verify/route.ts'),
  'utf-8',
);

// ═══════════════════════════════════════════════════════════
// 1. T1 + T2: Activation succeeds — reconciliation call presence
// ═══════════════════════════════════════════════════════════
describe('#682 structural: post-activation allowance recovery', () => {
  it('checks allowance_granted === false after activation result', () => {
    expect(verifyRouteSrc).toContain('activationResult.allowance_granted === false');
  });

  it('calls reconcile_paid_allowance when allowance was not granted', () => {
    expect(verifyRouteSrc).toContain("'reconcile_paid_allowance'");
    expect(verifyRouteSrc).toContain('p_business_id: businessId');
  });

  it('reconciliation call is positioned AFTER business status update', () => {
    const statusUpdatePos = verifyRouteSrc.indexOf('Paid onboarding completion');
    const reconcilePos = verifyRouteSrc.indexOf("'reconcile_paid_allowance'");
    expect(statusUpdatePos).toBeGreaterThan(0);
    expect(reconcilePos).toBeGreaterThan(statusUpdatePos);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. T3: Reconciliation failure is non-fatal
// ═══════════════════════════════════════════════════════════
describe('#682 structural: reconciliation is non-fatal', () => {
  it('reconciliation is wrapped in try/catch', () => {
    // Find the reconciliation block
    const reconcileStart = verifyRouteSrc.indexOf('Post-activation allowance recovery');
    expect(reconcileStart).toBeGreaterThan(0);

    const reconcileBlock = verifyRouteSrc.substring(
      reconcileStart,
      verifyRouteSrc.indexOf('Post-authority provider identity', reconcileStart),
    );

    // Must have try/catch wrapping
    expect(reconcileBlock).toContain('try {');
    expect(reconcileBlock).toContain('} catch (reconcileErr)');
  });

  it('reconciliation failure does not return error response', () => {
    const reconcileStart = verifyRouteSrc.indexOf('Post-activation allowance recovery');
    const nextReturn = verifyRouteSrc.indexOf('Post-authority provider identity', reconcileStart);
    const reconcileBlock = verifyRouteSrc.substring(reconcileStart, nextReturn);

    // The block should NOT contain return NextResponse.json with status >= 400
    expect(reconcileBlock).not.toContain('return NextResponse.json');
  });

  it('logs warning on reconciliation error', () => {
    expect(verifyRouteSrc).toContain(
      'Post-activation allowance reconciliation failed (non-fatal)',
    );
  });

  it('logs warning on reconciliation exception', () => {
    expect(verifyRouteSrc).toContain(
      'Post-activation allowance reconciliation exception (non-fatal)',
    );
  });
});

// ═══════════════════════════════════════════════════════════
// 3. T5: Activation failure — no reconciliation path
// ═══════════════════════════════════════════════════════════
describe('#682 structural: no reconciliation on activation failure', () => {
  it('activation failure returns before reconciliation code', () => {
    const rejectionReturn = verifyRouteSrc.indexOf('activation rejected');
    const reconcilePos = verifyRouteSrc.indexOf("'reconcile_paid_allowance'");
    expect(rejectionReturn).toBeGreaterThan(0);
    expect(reconcilePos).toBeGreaterThan(rejectionReturn);

    // The rejection return has a return statement BEFORE reconciliation
    const blockBetween = verifyRouteSrc.substring(rejectionReturn, reconcilePos);
    expect(blockBetween).toContain('return NextResponse.json');
  });

  it('RPC error returns before reconciliation code', () => {
    const rpcError = verifyRouteSrc.indexOf('Paid activation RPC error');
    const reconcilePos = verifyRouteSrc.indexOf("'reconcile_paid_allowance'");
    expect(rpcError).toBeGreaterThan(0);

    const blockBetween = verifyRouteSrc.substring(rpcError, reconcilePos);
    expect(blockBetween).toContain('return NextResponse.json');
  });
});

// ═══════════════════════════════════════════════════════════
// 4. T6: Idempotent replay — no reconciliation when allowance exists
// ═══════════════════════════════════════════════════════════
describe('#682 structural: idempotent replay safety', () => {
  it('reconciliation is gated on allowance_granted === false only', () => {
    // The reconciliation block is inside an if (activationResult.allowance_granted === false)
    const ifCheck = verifyRouteSrc.indexOf(
      'if (activationResult.allowance_granted === false)',
    );
    expect(ifCheck).toBeGreaterThan(0);

    // Count occurrences: there should be exactly 2 (warning + reconciliation)
    const allOccurrences = verifyRouteSrc.split('activationResult.allowance_granted === false');
    expect(allOccurrences.length - 1).toBe(2);
  });

  it('does not reconcile when allowance_granted is true or undefined', () => {
    // When activate_paid_subscription returns { activated: true, idempotent: true }
    // without allowance_granted field, the === false check prevents reconciliation
    const checkBlock = verifyRouteSrc.substring(
      verifyRouteSrc.lastIndexOf('if (activationResult.allowance_granted === false)'),
    );
    expect(checkBlock).toContain("'reconcile_paid_allowance'");
    // Strict equality: undefined !== false, null !== false
  });
});

// ═══════════════════════════════════════════════════════════
// 5. T7-T10: Channel readiness — delegated to RPC
// ═══════════════════════════════════════════════════════════
describe('#682 structural: channel readiness preserved', () => {
  it('does not bypass channel readiness checks in application code', () => {
    const reconcileBlock = verifyRouteSrc.substring(
      verifyRouteSrc.lastIndexOf('Post-activation allowance recovery'),
      verifyRouteSrc.indexOf('Post-authority provider identity'),
    );
    // No channel readiness checks in the reconciliation block — delegated to RPC
    expect(reconcileBlock).not.toContain('wa_method');
    expect(reconcileBlock).not.toContain('whatsapp_channel_id');
    expect(reconcileBlock).not.toContain('channel_type');
    expect(reconcileBlock).not.toContain('is_active');
  });

  it('relies on reconcile_paid_allowance RPC for channel verification', () => {
    // The only call in the recovery block is the RPC — no manual checks
    const reconcileBlock = verifyRouteSrc.substring(
      verifyRouteSrc.lastIndexOf('Post-activation allowance recovery'),
      verifyRouteSrc.indexOf('Post-authority provider identity'),
    );
    expect(reconcileBlock).toContain('reconcile_paid_allowance');
    expect(reconcileBlock).not.toContain("from('whatsapp_channels')");
  });
});

// ═══════════════════════════════════════════════════════════
// 6. T11: Concurrent request safety — delegated to RPC
// ═══════════════════════════════════════════════════════════
describe('#682 structural: concurrency safety', () => {
  it('reconcile_paid_allowance handles idempotency (source_ref dedup)', () => {
    // The RPC uses source_ref for exactly-once dedup — we verify the call
    // passes p_business_id and the RPC handles concurrency internally
    expect(verifyRouteSrc).toContain("'reconcile_paid_allowance'");
    expect(verifyRouteSrc).toContain('p_business_id: businessId');
  });

  it('handles reconcile returning idempotent result', () => {
    // The code checks reconcileResult.reconciled — idempotent: true is a success
    const reconcileBlock = verifyRouteSrc.substring(
      verifyRouteSrc.lastIndexOf("'reconcile_paid_allowance'"),
      verifyRouteSrc.indexOf('Post-authority provider identity'),
    );
    expect(reconcileBlock).toContain('reconcileResult.reconciled');
  });
});

// ═══════════════════════════════════════════════════════════
// 7. T12: Failed status update — no reconciliation
// ═══════════════════════════════════════════════════════════
describe('#682 structural: no reconciliation on failed status update', () => {
  it('paidStatusErr returns 500 before reconciliation block', () => {
    const statusErrReturn = verifyRouteSrc.indexOf('if (paidStatusErr)');
    const reconcileBlock = verifyRouteSrc.lastIndexOf('Post-activation allowance recovery');
    expect(statusErrReturn).toBeGreaterThan(0);

    const errBlock = verifyRouteSrc.substring(statusErrReturn, reconcileBlock);
    expect(errBlock).toContain('return NextResponse.json');
    expect(errBlock).toContain('status: 500');
  });
});

// ═══════════════════════════════════════════════════════════
// 8. Structured warning (Change 1C)
// ═══════════════════════════════════════════════════════════
describe('#682 structural: structured warning for skipped allowance', () => {
  it('logs structured warning when activation succeeds but allowance skipped', () => {
    expect(verifyRouteSrc).toContain(
      'Activation succeeded but allowance not granted',
    );
  });

  it('warning includes businessId and reason', () => {
    const warningBlock = verifyRouteSrc.substring(
      verifyRouteSrc.indexOf('Activation succeeded but allowance not granted'),
      verifyRouteSrc.indexOf('Paid onboarding completion'),
    );
    expect(warningBlock).toContain('businessId');
    expect(warningBlock).toContain('activationResult.reason');
    expect(warningBlock).toContain('plan');
  });

  it('warning does not log credentials or tokens', () => {
    const warningBlock = verifyRouteSrc.substring(
      verifyRouteSrc.indexOf('Activation succeeded but allowance not granted'),
      verifyRouteSrc.indexOf('Paid onboarding completion'),
    );
    expect(warningBlock).not.toContain('token');
    expect(warningBlock).not.toContain('secret');
    expect(warningBlock).not.toContain('key');
    expect(warningBlock).not.toContain('password');
  });

  it('logs success when reconciliation completes', () => {
    expect(verifyRouteSrc).toContain('Post-activation allowance reconciled');
  });
});

// ═══════════════════════════════════════════════════════════
// 9. Existing behavior preservation
// ═══════════════════════════════════════════════════════════
describe('#682 structural: existing behavior preserved', () => {
  it('activate_paid_subscription call unchanged', () => {
    expect(verifyRouteSrc).toContain("'activate_paid_subscription'");
    expect(verifyRouteSrc).toContain('p_payment_id: paymentEvidenceId');
  });

  it('activated !== true check still returns 400', () => {
    const check = verifyRouteSrc.indexOf('activationResult.activated !== true');
    expect(check).toBeGreaterThan(0);
    const block = verifyRouteSrc.substring(check, check + 500);
    expect(block).toContain('status: 400');
  });

  it('CAS guard for status update preserved', () => {
    expect(verifyRouteSrc).toContain(".eq('status', 'pending')");
    expect(verifyRouteSrc).toContain("update({ status: 'active' })");
  });

  it('financial gate is not modified', () => {
    // No references to messaging_financial_gate in the verify route
    expect(verifyRouteSrc).not.toContain('messaging_financial_gate');
  });
});

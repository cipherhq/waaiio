/**
 * #620 — Payout account auto-link on approve
 *
 * Source analysis tests that verify the approve route:
 * 1. Read-only candidate resolution before step-up (no writes)
 * 2. Write (auto-link) only after step-up succeeds
 * 3. Race detection: concurrent link to different account → 409
 * 4. Existing auto-link cases (none, one, inactive, multiple)
 * 5. Held status accepted by approve route
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROUTE_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../app/api/admin/payouts/[id]/approve/route.ts'),
  'utf-8',
);

describe('#620 — Read-only resolution before step-up', () => {
  it('resolves candidate read-only before consumeStepUp call', () => {
    // candidateAccountId is set in a read-only section before the step-up invocation
    const candidatePos = ROUTE_SRC.indexOf('candidateAccountId = candidates[0].id');
    // Find the actual invocation, not the import
    const stepUpPos = ROUTE_SRC.indexOf('await consumeStepUp(');
    expect(candidatePos).toBeGreaterThan(-1);
    expect(stepUpPos).toBeGreaterThan(candidatePos);
  });

  it('uses effectiveAccountId for all pre-step-up account checks', () => {
    // The payout account verification section uses effectiveAccountId, not payout.payout_account_id
    expect(ROUTE_SRC).toContain("const effectiveAccountId = payout.payout_account_id || candidateAccountId");
    expect(ROUTE_SRC).toMatch(/\.eq\('id',\s*effectiveAccountId!\)/);
  });

  it('no .update() on business_payouts between candidate resolution and consumeStepUp', () => {
    // Extract the section between candidate resolution and step-up
    const candidateSection = ROUTE_SRC.match(
      /Resolve effective payout account[\s\S]*?consumeStepUp/
    );
    expect(candidateSection).not.toBeNull();
    // This section must NOT contain any .update() calls on business_payouts
    // The only .update() should be in the "Auto-link write" section AFTER step-up
    expect(candidateSection![0]).not.toMatch(/\.update\(\s*\{[^}]*payout_account_id/);
  });
});

describe('#620 — Auto-link write after step-up', () => {
  it('write happens after consumeStepUp succeeds', () => {
    const stepUpPos = ROUTE_SRC.indexOf('consumeStepUp');
    const writePos = ROUTE_SRC.indexOf('Auto-link write (after step-up');
    expect(writePos).toBeGreaterThan(stepUpPos);
  });

  it('write uses conditional update where payout_account_id IS NULL', () => {
    const writeBlock = ROUTE_SRC.match(/Auto-link write[\s\S]*?Manual methods/);
    expect(writeBlock).not.toBeNull();
    expect(writeBlock![0]).toMatch(/\.is\('payout_account_id',\s*null\)/);
  });

  it('write uses .select("id") and checks linkResult.length', () => {
    const writeBlock = ROUTE_SRC.match(/Auto-link write[\s\S]*?Manual methods/);
    expect(writeBlock).not.toBeNull();
    expect(writeBlock![0]).toMatch(/\.select\('id'\)/);
    expect(writeBlock![0]).toMatch(/linkResult\.length\s*!==\s*1/);
  });

  it('sets payout.payout_account_id after successful link', () => {
    expect(ROUTE_SRC).toContain('payout.payout_account_id = candidateAccountId');
  });

  it('only writes when candidateAccountId is truthy (payout had no account)', () => {
    const writeBlock = ROUTE_SRC.match(/Auto-link write[\s\S]*?Manual methods/);
    expect(writeBlock).not.toBeNull();
    expect(writeBlock![0]).toMatch(/if\s*\(candidateAccountId\)/);
  });
});

describe('#620 — No DB write when step-up fails', () => {
  it('step-up failure returns 403 before any auto-link write', () => {
    // consumeStepUp is in a try/catch that returns 403
    const stepUpBlock = ROUTE_SRC.match(/consumeStepUp[\s\S]*?step_up_required/);
    expect(stepUpBlock).not.toBeNull();
    expect(stepUpBlock![0]).toContain('status: 403');
    // The auto-link write is AFTER this block
    const failReturn = ROUTE_SRC.indexOf("code: 'step_up_required'");
    const writeStart = ROUTE_SRC.indexOf('Auto-link write (after step-up');
    expect(writeStart).toBeGreaterThan(failReturn);
  });

  it('candidateAccountId is set but no write occurs in the read-only section', () => {
    // Between "Resolve effective" and "consumeStepUp", there should be no
    // business_payouts .update() call
    const readOnlySection = ROUTE_SRC.match(
      /let candidateAccountId[\s\S]*?consumeStepUp/
    );
    expect(readOnlySection).not.toBeNull();
    // Check that the update with payout_account_id does NOT appear in this section
    const updateMatches = readOnlySection![0].match(/\.update\(/g);
    expect(updateMatches).toBeNull();
  });
});

describe('#620 — Concurrent link race detection (409)', () => {
  it('re-reads payout when link update returns 0 rows', () => {
    const writeBlock = ROUTE_SRC.match(/Auto-link write[\s\S]*?Manual methods/);
    expect(writeBlock).not.toBeNull();
    // Must re-read business_payouts to check current payout_account_id
    expect(writeBlock![0]).toMatch(/\.select\('payout_account_id'\)/);
    expect(writeBlock![0]).toMatch(/\.eq\('id',\s*id\)/);
    expect(writeBlock![0]).toContain('.single()');
  });

  it('proceeds if re-read shows same candidate was linked concurrently', () => {
    const writeBlock = ROUTE_SRC.match(/Auto-link write[\s\S]*?Manual methods/);
    expect(writeBlock).not.toBeNull();
    expect(writeBlock![0]).toContain('reread?.payout_account_id === candidateAccountId');
    expect(writeBlock![0]).toContain('safe to proceed');
  });

  it('returns 409 if re-read shows a different account was linked', () => {
    const writeBlock = ROUTE_SRC.match(/Auto-link write[\s\S]*?Manual methods/);
    expect(writeBlock).not.toBeNull();
    expect(writeBlock![0]).toContain('payout account changed by a concurrent request');
    expect(writeBlock![0]).toContain('status: 409');
  });
});

describe('#620 — Existing auto-link cases', () => {
  it('queries payout_accounts filtered by is_active=true', () => {
    expect(ROUTE_SRC).toMatch(/from\('payout_accounts'\)\s*\n\s*\.select\('id'\)/);
    expect(ROUTE_SRC).toMatch(/\.eq\('is_active',\s*true\)/);
  });

  it('queries payout_accounts filtered by verified_at IS NOT NULL', () => {
    expect(ROUTE_SRC).toMatch(/\.not\('verified_at',\s*'is',\s*null\)/);
  });

  it('queries payout_accounts scoped to the payout business_id', () => {
    expect(ROUTE_SRC).toMatch(/\.eq\('business_id',\s*payout\.business_id\)/);
  });

  it('requires exactly one candidate (rejects 0 or 2+)', () => {
    expect(ROUTE_SRC).toMatch(/candidates\.length\s*!==\s*1/);
  });

  it('returns 400 when no single candidate found', () => {
    const resolveBlock = ROUTE_SRC.match(/Resolve effective payout account[\s\S]*?effectiveAccountId/);
    expect(resolveBlock).not.toBeNull();
    expect(resolveBlock![0]).toContain('no payout account configured');
    expect(resolveBlock![0]).toContain('status: 400');
  });

  it('only resolves candidate when payout_account_id is falsy', () => {
    expect(ROUTE_SRC).toMatch(/if\s*\(\s*!payout\.payout_account_id\s*\)\s*\{/);
  });
});

describe('#620 — Held status accepted by approve route', () => {
  it('accepts held status for approval', () => {
    expect(ROUTE_SRC).toMatch(/\['pending',\s*'approved',\s*'held'\]\.includes\(payout\.status\)/);
  });

  it('manual update also transitions from held', () => {
    expect(ROUTE_SRC).toMatch(/\.in\('status',\s*\['pending',\s*'approved',\s*'held'\]\)/);
  });
});

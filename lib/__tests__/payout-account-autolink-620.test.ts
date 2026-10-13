/**
 * #620 — Payout account auto-link on approve
 *
 * Source analysis tests that verify the approve route:
 * 1. Auto-links the business's single active, verified payout account when null
 * 2. Keeps 400 when no single candidate exists
 * 3. Uses conditional update (payout_account_id IS NULL) to prevent race conditions
 * 4. Only queries active + verified accounts
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROUTE_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../app/api/admin/payouts/[id]/approve/route.ts'),
  'utf-8',
);

describe('#620 — Payout account auto-link (source analysis)', () => {
  it('has an auto-link section before payout account verification', () => {
    const autoLinkPos = ROUTE_SRC.indexOf('Auto-link payout account');
    const verificationPos = ROUTE_SRC.indexOf('Payout account verification');
    expect(autoLinkPos).toBeGreaterThan(-1);
    expect(verificationPos).toBeGreaterThan(autoLinkPos);
  });

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
    // The error message should be the same as the original "no payout account" error
    const autoLinkBlock = ROUTE_SRC.match(/Auto-link payout account[\s\S]*?Payout account verification/);
    expect(autoLinkBlock).not.toBeNull();
    expect(autoLinkBlock![0]).toContain('no payout account configured');
    expect(autoLinkBlock![0]).toContain('status: 400');
  });

  it('uses conditional update where payout_account_id IS NULL (race-safe)', () => {
    const autoLinkBlock = ROUTE_SRC.match(/Auto-link payout account[\s\S]*?Payout account verification/);
    expect(autoLinkBlock).not.toBeNull();
    expect(autoLinkBlock![0]).toMatch(/\.is\('payout_account_id',\s*null\)/);
  });

  it('sets payout.payout_account_id after successful link', () => {
    expect(ROUTE_SRC).toContain('payout.payout_account_id = candidates[0].id');
  });

  it('returns 500 if the link update fails', () => {
    const autoLinkBlock = ROUTE_SRC.match(/Auto-link payout account[\s\S]*?Payout account verification/);
    expect(autoLinkBlock).not.toBeNull();
    expect(autoLinkBlock![0]).toContain('Failed to link payout account');
    expect(autoLinkBlock![0]).toContain('status: 500');
  });

  it('only runs auto-link when payout_account_id is falsy', () => {
    // The auto-link is inside if (!payout.payout_account_id)
    expect(ROUTE_SRC).toMatch(/if\s*\(\s*!payout\.payout_account_id\s*\)\s*\{/);
  });
});

describe('#620 — Held status accepted by approve route', () => {
  it('accepts held status for approval', () => {
    // The status check must include 'held'
    expect(ROUTE_SRC).toMatch(/\['pending',\s*'approved',\s*'held'\]\.includes\(payout\.status\)/);
  });

  it('manual update also transitions from held', () => {
    // The manual update's .in('status', [...]) must include 'held'
    expect(ROUTE_SRC).toMatch(/\.in\('status',\s*\['pending',\s*'approved',\s*'held'\]\)/);
  });
});

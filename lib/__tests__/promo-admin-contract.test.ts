/**
 * PROMO-1: Admin Promotions contract tests.
 *
 * Proves the Admin page uses server routes, not direct browser DB queries.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Admin Promotions page contract', () => {
  const filePath = join(process.cwd(), 'admin/src/pages/Promotions.tsx');
  let content: string;

  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    content = '';
  }

  it('uses /api/promotions/admin-list for data loading', () => {
    expect(content).toContain('/api/promotions/admin-list');
  });

  it('uses /api/promotions/admin-detail for campaign detail', () => {
    expect(content).toContain('/api/promotions/admin-detail');
  });

  it('uses /api/promotions/admin-action for governance mutations', () => {
    expect(content).toContain('/api/promotions/admin-action');
  });

  it('does NOT directly query adminDb.from(promo_campaigns)', () => {
    // Allow the import of adminDb but not direct table queries for promo data
    const promoQueries = content.match(/adminDb\.from\s*\(\s*['"]promo_campaigns['"]\s*\)/g);
    expect(promoQueries).toBeNull();
  });

  it('does NOT directly query adminDb.from(promo_campaign_codes)', () => {
    const codeQueries = content.match(/adminDb\.from\s*\(\s*['"]promo_campaign_codes['"]\s*\)/g);
    expect(codeQueries).toBeNull();
  });

  it('does NOT directly query adminDb.from(promo_verification_attempts)', () => {
    const attemptQueries = content.match(/adminDb\.from\s*\(\s*['"]promo_verification_attempts['"]\s*\)/g);
    expect(attemptQueries).toBeNull();
  });

  it('does NOT directly query adminDb.from(promo_redemptions)', () => {
    const redemptionQueries = content.match(/adminDb\.from\s*\(\s*['"]promo_redemptions['"]\s*\)/g);
    expect(redemptionQueries).toBeNull();
  });

  it('admin-list server route allows admin/support/operations', () => {
    const routePath = join(process.cwd(), 'app/api/promotions/admin-list/route.ts');
    const routeContent = readFileSync(routePath, 'utf-8');
    expect(routeContent).toContain("'admin'");
    expect(routeContent).toContain("'support'");
    expect(routeContent).toContain("'operations'");
  });

  it('admin-detail server route allows admin/support/operations', () => {
    const routePath = join(process.cwd(), 'app/api/promotions/admin-detail/route.ts');
    const routeContent = readFileSync(routePath, 'utf-8');
    expect(routeContent).toContain("'admin'");
    expect(routeContent).toContain("'support'");
    expect(routeContent).toContain("'operations'");
  });

  it('admin-action server route is admin-only', () => {
    const routePath = join(process.cwd(), 'app/api/promotions/admin-action/route.ts');
    const routeContent = readFileSync(routePath, 'utf-8');
    // Should have requiredRole: ['admin'] — NOT including operations/support
    expect(routeContent).toMatch(/requiredRole:\s*\[\s*['"]admin['"]\s*\]/);
  });

  it('admin permissions include support for promotions', () => {
    const permPath = join(process.cwd(), 'admin/src/lib/permissions.ts');
    const permContent = readFileSync(permPath, 'utf-8');
    // promotions should include support
    expect(permContent).toMatch(/promotions.*support/);
  });

  // ══════════ ROLE ACCESS CONTRACT ══════════

  it('admin can navigate promotions (permissions.ts includes admin)', () => {
    const permPath = join(process.cwd(), 'admin/src/lib/permissions.ts');
    const permContent = readFileSync(permPath, 'utf-8');
    expect(permContent).toMatch(/promotions.*admin/);
  });

  it('support can navigate promotions (permissions.ts includes support)', () => {
    const permPath = join(process.cwd(), 'admin/src/lib/permissions.ts');
    const permContent = readFileSync(permPath, 'utf-8');
    expect(permContent).toMatch(/promotions.*support/);
  });

  it('operations can navigate promotions (permissions.ts includes operations)', () => {
    const permPath = join(process.cwd(), 'admin/src/lib/permissions.ts');
    const permContent = readFileSync(permPath, 'utf-8');
    expect(permContent).toMatch(/promotions.*operations/);
  });

  it('finance CANNOT access promotions', () => {
    const permPath = join(process.cwd(), 'admin/src/lib/permissions.ts');
    const permContent = readFileSync(permPath, 'utf-8');
    // Extract the promotions permission line
    const promoLine = permContent.split('\n').find(l => l.includes("'promotions'"));
    expect(promoLine).toBeDefined();
    expect(promoLine).not.toContain('finance');
  });

  it('only admin can execute governance mutations (admin-action is admin-only)', () => {
    const routePath = join(process.cwd(), 'app/api/promotions/admin-action/route.ts');
    const routeContent = readFileSync(routePath, 'utf-8');
    // Must be admin-only — NOT include support/operations
    expect(routeContent).toMatch(/requiredRole:\s*\[\s*['"]admin['"]\s*\]/);
    // Verify support/operations are NOT in the requiredRole array
    const roleMatch = routeContent.match(/requiredRole:\s*\[([^\]]+)\]/);
    expect(roleMatch).toBeDefined();
    const roleString = roleMatch![1];
    expect(roleString).not.toContain('support');
    expect(roleString).not.toContain('operations');
  });

  it('admin-list read route allows all three authorized roles', () => {
    const routePath = join(process.cwd(), 'app/api/promotions/admin-list/route.ts');
    const routeContent = readFileSync(routePath, 'utf-8');
    expect(routeContent).toContain("'admin'");
    expect(routeContent).toContain("'support'");
    expect(routeContent).toContain("'operations'");
    // Finance not listed
    expect(routeContent).not.toMatch(/requiredRole.*finance/);
  });
});

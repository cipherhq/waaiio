import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import {
  REGRESSION_MANIFEST,
  getAffectedDomains,
  getRequiredTestSuites,
  getRelatedInvariants,
  validateManifestPaths,
  type DomainEntry,
} from '../release-gate/regression-manifest';

const REPO_ROOT = resolve(__dirname, '../..');

describe('Regression Manifest', () => {
  // ── Schema validation ──

  it('every domain has a unique ID', () => {
    const ids = REGRESSION_MANIFEST.map(d => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every domain has at least one path pattern', () => {
    for (const domain of REGRESSION_MANIFEST) {
      expect(domain.pathPatterns.length, `${domain.id} has no pathPatterns`).toBeGreaterThan(0);
    }
  });

  it('every domain has at least one test suite', () => {
    for (const domain of REGRESSION_MANIFEST) {
      expect(domain.testSuites.length, `${domain.id} has no testSuites`).toBeGreaterThan(0);
    }
  });

  it('cross-domain path overlaps are documented and intentional', () => {
    // Some paths intentionally map to multiple domains (e.g., Stripe webhook
    // paths map to both 'payments' and 'stripe-paystack'). This test documents
    // the known overlaps so unintentional duplicates are caught.
    const patternToDomains = new Map<string, string[]>();
    for (const domain of REGRESSION_MANIFEST) {
      for (const pattern of domain.pathPatterns) {
        const domains = patternToDomains.get(pattern) || [];
        domains.push(domain.id);
        patternToDomains.set(pattern, domains);
      }
    }

    const overlaps = [...patternToDomains.entries()]
      .filter(([, domains]) => domains.length > 1);

    // Known intentional overlaps — update this list when adding new ones
    const knownOverlaps = [
      'app/api/webhook/stripe/',
      'app/api/webhook/paystack/',
    ];

    for (const [pattern, domains] of overlaps) {
      expect(
        knownOverlaps,
        `Unexpected cross-domain overlap: "${pattern}" maps to [${domains.join(', ')}]. ` +
        `If intentional, add it to knownOverlaps in this test.`
      ).toContain(pattern);
    }
  });

  it('all test suite paths end with .test.ts', () => {
    for (const domain of REGRESSION_MANIFEST) {
      for (const suite of domain.testSuites) {
        expect(suite, `${domain.id}: ${suite}`).toMatch(/\.test\.ts$/);
      }
    }
  });

  it('all test suite paths exist on disk', () => {
    const missing = validateManifestPaths(REPO_ROOT);
    if (missing.length > 0) {
      const detail = missing.map(m => `  ${m.domain}: ${m.path}`).join('\n');
      expect.fail(
        `${missing.length} manifest test path(s) do not exist:\n${detail}\n` +
        `Fix: remove stale paths or correct typos in regression-manifest.ts`
      );
    }
  });

  it('contains all 10 required launch-critical domains', () => {
    const ids = REGRESSION_MANIFEST.map(d => d.id);
    expect(ids).toContain('payments');
    expect(ids).toContain('saved-cards');
    expect(ids).toContain('appointments');
    expect(ids).toContain('reservations');
    expect(ids).toContain('whatsapp-session');
    expect(ids).toContain('stripe-paystack');
    expect(ids).toContain('orders');
    expect(ids).toContain('tickets-events');
    expect(ids).toContain('invoice-giving');
    expect(ids).toContain('migrations-rls-acl');
  });

  // ── Domain resolution ──

  it('payment source change maps to payments domain', () => {
    const domains = getAffectedDomains(['lib/payments/process-success.ts']);
    const ids = domains.map(d => d.id);
    expect(ids).toContain('payments');
  });

  it('saved-card handler change maps to saved-cards domain', () => {
    const domains = getAffectedDomains(['lib/bot/handlers/saved-card-locator.ts']);
    const ids = domains.map(d => d.id);
    expect(ids).toContain('saved-cards');
  });

  it('scheduling flow change maps to appointments domain', () => {
    const domains = getAffectedDomains(['lib/bot/flows/scheduling.flow.ts']);
    const ids = domains.map(d => d.id);
    expect(ids).toContain('appointments');
  });

  it('reservation flow change maps to reservations domain', () => {
    const domains = getAffectedDomains(['lib/bot/flows/reservation.flow.ts']);
    const ids = domains.map(d => d.id);
    expect(ids).toContain('reservations');
  });

  it('bot service change maps to whatsapp-session domain', () => {
    const domains = getAffectedDomains(['lib/bot/bot.service.ts']);
    const ids = domains.map(d => d.id);
    expect(ids).toContain('whatsapp-session');
  });

  it('stripe webhook change maps to both payments and stripe-paystack', () => {
    const domains = getAffectedDomains(['app/api/webhook/stripe/route.ts']);
    const ids = domains.map(d => d.id);
    expect(ids).toContain('payments');
    expect(ids).toContain('stripe-paystack');
  });

  it('ordering flow change maps to orders domain', () => {
    const domains = getAffectedDomains(['lib/bot/flows/ordering.flow.ts']);
    const ids = domains.map(d => d.id);
    expect(ids).toContain('orders');
  });

  it('ticketing flow change maps to tickets-events domain', () => {
    const domains = getAffectedDomains(['lib/bot/flows/ticketing.flow.ts']);
    const ids = domains.map(d => d.id);
    expect(ids).toContain('tickets-events');
  });

  it('invoice flow change maps to invoice-giving domain', () => {
    const domains = getAffectedDomains(['lib/bot/flows/invoice.flow.ts']);
    const ids = domains.map(d => d.id);
    expect(ids).toContain('invoice-giving');
  });

  it('migration change maps to migrations-rls-acl domain', () => {
    const domains = getAffectedDomains(['supabase/migrations/408_new_feature.sql']);
    const ids = domains.map(d => d.id);
    expect(ids).toContain('migrations-rls-acl');
  });

  it('unrelated change (docs) maps to no domains', () => {
    const domains = getAffectedDomains(['README.md', 'docs/architecture.md']);
    expect(domains).toHaveLength(0);
  });

  it('CI workflow change maps to no domains', () => {
    const domains = getAffectedDomains(['.github/workflows/ci.yml']);
    expect(domains).toHaveLength(0);
  });

  // ── Deletion coverage ──

  it('deleted payment file still maps to payments domain', () => {
    // Simulates a deleted file appearing in the changed-files list
    const domains = getAffectedDomains(['lib/payments/process-success.ts']);
    const ids = domains.map(d => d.id);
    expect(ids).toContain('payments');
    const suites = getRequiredTestSuites(domains);
    expect(suites.length).toBeGreaterThan(0);
  });

  it('deleted saved-card file still maps to saved-cards domain', () => {
    const domains = getAffectedDomains(['lib/bot/handlers/saved-card-locator.ts']);
    expect(domains.map(d => d.id)).toContain('saved-cards');
  });

  it('deleted appointment file still maps to appointments domain', () => {
    const domains = getAffectedDomains(['lib/bot/flows/scheduling.flow.ts']);
    expect(domains.map(d => d.id)).toContain('appointments');
  });

  it('deleted reservation file still maps to reservations domain', () => {
    const domains = getAffectedDomains(['lib/bot/flows/reservation.flow.ts']);
    expect(domains.map(d => d.id)).toContain('reservations');
  });

  it('deleted whatsapp session file still maps to whatsapp-session domain', () => {
    const domains = getAffectedDomains(['lib/bot/bot.service.ts']);
    expect(domains.map(d => d.id)).toContain('whatsapp-session');
  });

  it('deleted migration file still maps to migrations-rls-acl domain', () => {
    const domains = getAffectedDomains(['supabase/migrations/999_removed.sql']);
    expect(domains.map(d => d.id)).toContain('migrations-rls-acl');
  });

  // ── Test suite collection ──

  it('collects deduplicated test suites across overlapping domains', () => {
    const domains = getAffectedDomains(['app/api/webhook/stripe/route.ts']);
    const suites = getRequiredTestSuites(domains);
    expect(suites.length).toBeGreaterThan(0);
    expect(new Set(suites).size).toBe(suites.length);
  });

  it('collects related invariants for affected domains', () => {
    const domains = getAffectedDomains(['lib/payments/saved-card-adapter.ts']);
    const invariants = getRelatedInvariants(domains);
    expect(invariants).toContain('DB-004');
    expect(invariants).toContain('PAY-001');
  });

  it('returns empty invariants for domains without invariants', () => {
    const domains = getAffectedDomains(['lib/bot/flows/ordering.flow.ts']);
    const invariants = getRelatedInvariants(domains);
    expect(invariants).toHaveLength(0);
  });

  // ── Edge cases ──

  it('handles empty changed files', () => {
    const domains = getAffectedDomains([]);
    expect(domains).toHaveLength(0);
    expect(getRequiredTestSuites(domains)).toHaveLength(0);
    expect(getRelatedInvariants(domains)).toHaveLength(0);
  });

  it('multiple files can trigger multiple domains', () => {
    const domains = getAffectedDomains([
      'lib/payments/process-success.ts',
      'lib/bot/flows/scheduling.flow.ts',
      'supabase/migrations/408_new.sql',
    ]);
    const ids = domains.map(d => d.id);
    expect(ids).toContain('payments');
    expect(ids).toContain('appointments');
    expect(ids).toContain('migrations-rls-acl');
  });

  // ── Manifest integrity ──

  it('validateManifestPaths detects a missing/stale path', () => {
    // Inject a fake domain with a nonexistent test path, validate, then remove
    const fakeDomain: DomainEntry = {
      id: 'test-fake',
      label: 'Fake',
      pathPatterns: ['fake/'],
      testSuites: ['lib/__tests__/DOES_NOT_EXIST_12345.test.ts'],
      invariants: [],
    };
    REGRESSION_MANIFEST.push(fakeDomain);
    try {
      const missing = validateManifestPaths(REPO_ROOT);
      expect(missing.some(m => m.path.includes('DOES_NOT_EXIST'))).toBe(true);
    } finally {
      REGRESSION_MANIFEST.pop();
    }
  });

  // ── B3a: Explicit manifest membership guards ──

  it('payments domain includes entity-balance.test.ts', () => {
    const payments = REGRESSION_MANIFEST.find(d => d.id === 'payments')!;
    expect(payments.testSuites).toContain('lib/payments/__tests__/entity-balance.test.ts');
  });

  it('saved-cards domain includes B3a regression tests', () => {
    const savedCards = REGRESSION_MANIFEST.find(d => d.id === 'saved-cards')!;
    expect(savedCards.testSuites).toContain('lib/__tests__/reg-saved-card-reuse-chain.test.ts');
    expect(savedCards.testSuites).toContain('lib/__tests__/reg-pin-lockout.test.ts');
    expect(savedCards.testSuites).toContain('lib/__tests__/reg-saved-card-invoice-giving-parity.test.ts');
  });

  it('invoice-giving domain includes saved-card parity test', () => {
    const invoiceGiving = REGRESSION_MANIFEST.find(d => d.id === 'invoice-giving')!;
    expect(invoiceGiving.testSuites).toContain('lib/__tests__/reg-saved-card-invoice-giving-parity.test.ts');
  });
});

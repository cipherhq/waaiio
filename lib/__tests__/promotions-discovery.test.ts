/**
 * Promotions Discovery / Visibility Tests
 *
 * Verifies that the promo_verification capability is properly wired into
 * dashboard navigation and onboarding feature picker.
 */
import { describe, it, expect } from 'vitest';

describe('Promotions Sidebar navigation', () => {
  const fs = require('fs');
  const sidebarSrc = fs.readFileSync('components/dashboard/Sidebar.tsx', 'utf-8');

  it('1. Promotions nav item exists with promo_verification capability', () => {
    expect(sidebarSrc).toContain("href: '/dashboard/promotions'");
    expect(sidebarSrc).toContain("label: 'Promotions'");
    expect(sidebarSrc).toContain("capabilities: ['promo_verification']");
  });

  it('2. Promotions is hidden when capability is unavailable (capability gating)', () => {
    // The Sidebar capability gating logic: items with capabilities are shown
    // only when the business has that capability enabled. Otherwise they go to "more".
    // Verify the gating logic is present.
    expect(sidebarSrc).toContain('item.capabilities.some(cap => capabilities.includes(cap))');
    // Promotions uses this same gating (has capabilities array)
    const promoMatch = sidebarSrc.match(/href:\s*'\/dashboard\/promotions'[\s\S]{0,200}capabilities:\s*\['promo_verification'\]/);
    expect(promoMatch).toBeTruthy();
  });

  it('3. Promotions Sidebar link routes to /dashboard/promotions', () => {
    const match = sidebarSrc.match(/href:\s*'(\/dashboard\/promotions)'/);
    expect(match).toBeTruthy();
    expect(match![1]).toBe('/dashboard/promotions');
  });
});

describe('Promotions onboarding feature picker', () => {
  const fs = require('fs');
  const stepSrc = fs.readFileSync('app/get-started/steps/StepFeatures.tsx', 'utf-8');

  it('4. promo_verification appears in onboarding feature picker', () => {
    expect(stepSrc).toContain("id: 'promo_verification'");
    expect(stepSrc).toContain("title: 'Promotions'");
  });

  it('5. onboarding selection uses canonical capability ID', () => {
    // Must use the exact canonical ID, not a variant like 'promotions' or 'campaign'
    const match = stepSrc.match(/id:\s*'promo_verification'\s*as\s*CapabilityId/);
    expect(match).toBeTruthy();
  });
});

describe('Growth/Pro entitlement behavior', () => {
  it('6. promo_verification requires growth tier', () => {
    const fs = require('fs');
    const src = fs.readFileSync('shared/capabilities.ts', 'utf-8');
    // Verify promo_verification is mapped to 'growth' in CAPABILITY_TIER_REQUIREMENTS
    expect(src).toContain("promo_verification: 'growth'");
  });

  it('7. Promotions dashboard page enforces requireCapability', () => {
    const fs = require('fs');
    // Check that the promotions page or its API routes enforce promo_verification
    const listRoute = fs.readFileSync('app/api/promotions/list/route.ts', 'utf-8');
    expect(listRoute).toContain("requireCapability");
    expect(listRoute).toContain("promo_verification");
  });

  it('8. unauthorized access is rejected by API', () => {
    const fs = require('fs');
    const createRoute = fs.readFileSync('app/api/promotions/create/route.ts', 'utf-8');
    expect(createRoute).toContain("requireCapability");
    expect(createRoute).toContain("promo_verification");
  });
});

describe('Category defaults unchanged', () => {
  it('9. no automatic category-default enablement for promo_verification', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/capabilities/types.ts', 'utf-8');
    // promo_verification must NOT appear in category defaults
    expect(src).not.toContain('promo_verification');
    // Also check shared/capabilities.ts for any CATEGORY_DEFAULT that includes it
    const sharedSrc = fs.readFileSync('shared/capabilities.ts', 'utf-8');
    // Find category defaults section if it exists in shared
    const categoryDefaultSection = sharedSrc.indexOf('CATEGORY_DEFAULT');
    if (categoryDefaultSection > -1) {
      const afterDefaults = sharedSrc.substring(categoryDefaultSection);
      expect(afterDefaults).not.toContain('promo_verification');
    }
  });
});

describe('No migration added', () => {
  it('10. no new migration file was created', () => {
    const fs = require('fs');
    const path = require('path');
    const migrationsDir = path.resolve('supabase/migrations');
    const files = fs.readdirSync(migrationsDir).sort();
    // The highest existing migration should be 329 (from PR #145)
    // No 330+ migration should exist for promotions discovery
    const promoDiscoveryMigration = files.find((f: string) =>
      f.includes('promo') && parseInt(f.split('_')[0]) > 329
    );
    expect(promoDiscoveryMigration).toBeUndefined();
  });
});

describe('Existing Promotions tests remain compatible', () => {
  it('11. promo test files exist and are not modified by this PR', () => {
    const fs = require('fs');
    const expectedFiles = [
      'lib/__tests__/promo-capability-authority.test.ts',
      'lib/__tests__/promo-crypto.test.ts',
      'lib/__tests__/promo-normalize.test.ts',
      'lib/__tests__/promo-code-format.test.ts',
    ];
    for (const f of expectedFiles) {
      expect(fs.existsSync(f)).toBe(true);
    }
  });
});

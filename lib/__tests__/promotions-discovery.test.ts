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

  it('exactly ONE Sidebar item routes to /dashboard/promotions', () => {
    const matches = sidebarSrc.match(/href:\s*'\/dashboard\/promotions'/g);
    expect(matches).toBeTruthy();
    expect(matches!.length).toBe(1);
  });

  it('the existing Promotions item uses promo_verification capability', () => {
    const promoMatch = sidebarSrc.match(/href:\s*'\/dashboard\/promotions'[\s\S]{0,200}capabilities:\s*\['promo_verification'\]/);
    expect(promoMatch).toBeTruthy();
  });

  it('the existing item remains capability-gated via Sidebar logic', () => {
    expect(sidebarSrc).toContain('item.capabilities.some(cap => capabilities.includes(cap))');
  });

  it('the single entry is in the engage section', () => {
    const blocks = sidebarSrc.match(/\{[^}]*href:\s*'\/dashboard\/promotions'[^}]*\}/g);
    expect(blocks).toBeTruthy();
    expect(blocks!.length).toBe(1);
    expect(blocks![0]).toContain("section: 'engage'");
  });
});

describe('Promotions onboarding feature picker', () => {
  const fs = require('fs');
  const stepSrc = fs.readFileSync('app/get-started/steps/StepFeatures.tsx', 'utf-8');

  it('promo_verification appears in onboarding feature picker', () => {
    expect(stepSrc).toContain("id: 'promo_verification'");
    expect(stepSrc).toContain("title: 'Promotions'");
  });

  it('onboarding selection uses canonical capability ID', () => {
    const match = stepSrc.match(/id:\s*'promo_verification'\s*as\s*CapabilityId/);
    expect(match).toBeTruthy();
  });
});

describe('Growth/Pro entitlement behavior', () => {
  it('promo_verification requires growth tier', () => {
    const fs = require('fs');
    const src = fs.readFileSync('shared/capabilities.ts', 'utf-8');
    expect(src).toContain("promo_verification: 'growth'");
  });

  it('Promotions API enforces requireCapability', () => {
    const fs = require('fs');
    const listRoute = fs.readFileSync('app/api/promotions/list/route.ts', 'utf-8');
    expect(listRoute).toContain('requireCapability');
    expect(listRoute).toContain('promo_verification');
  });

  it('create API enforces promo_verification capability', () => {
    const fs = require('fs');
    const createRoute = fs.readFileSync('app/api/promotions/create/route.ts', 'utf-8');
    expect(createRoute).toContain('requireCapability');
    expect(createRoute).toContain('promo_verification');
  });
});

describe('Category defaults unchanged', () => {
  it('no automatic category-default enablement for promo_verification', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/capabilities/types.ts', 'utf-8');
    expect(src).not.toContain('promo_verification');
    const sharedSrc = fs.readFileSync('shared/capabilities.ts', 'utf-8');
    const categoryDefaultSection = sharedSrc.indexOf('CATEGORY_DEFAULT');
    if (categoryDefaultSection > -1) {
      const afterDefaults = sharedSrc.substring(categoryDefaultSection);
      expect(afterDefaults).not.toContain('promo_verification');
    }
  });
});

describe('Existing Promotions tests remain compatible', () => {
  it('core promo test files exist', () => {
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

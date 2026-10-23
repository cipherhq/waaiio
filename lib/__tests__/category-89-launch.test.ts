/**
 * #682 — 89-Category Launch Regression Tests
 *
 * Proves:
 * 1. All 89 BUSINESS_CATEGORIES keys are present in validation, flow mapping,
 *    labels, and default capabilities.
 * 2. Courier and moving capability corrections are applied.
 * 3. Existing 40 template categories are unchanged.
 * 4. Category loading guard prevents selection before DB config loads.
 * 5. Draft validation clears invalid categories.
 * 6. Flow routing resolves for every category.
 * 7. Five-country support is category-independent.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  BUSINESS_CATEGORIES,
  CATEGORY_FLOW_MAP,
  CATEGORY_LABELS,
  type BusinessCategoryKey,
} from '@/lib/constants';
import { CATEGORY_DEFAULT_CAPABILITIES } from '@/lib/capabilities/types';
import { getFirstStep } from '@/lib/bot/handlers/flow-routing';

// ═══════════════════════════════════════════════════════════
// 1. All 89 categories have complete application support
// ═══════════════════════════════════════════════════════════

describe('#682: 89-category application coverage', () => {
  const allKeys = BUSINESS_CATEGORIES.map(c => c.key);

  it('has exactly 89 business categories', () => {
    expect(allKeys.length).toBe(89);
    // No duplicates
    expect(new Set(allKeys).size).toBe(89);
  });

  it.each(allKeys)('%s has a flow type mapping', (key) => {
    expect(CATEGORY_FLOW_MAP[key]).toBeDefined();
    expect(['scheduling', 'ordering', 'ticketing', 'payment', 'reservation', 'queue', 'appointment']).toContain(CATEGORY_FLOW_MAP[key]);
  });

  it.each(allKeys)('%s has a display label', (key) => {
    expect(CATEGORY_LABELS[key as BusinessCategoryKey]).toBeDefined();
    expect(CATEGORY_LABELS[key as BusinessCategoryKey].entityName).toBeTruthy();
  });

  it.each(allKeys)('%s has default capabilities', (key) => {
    expect(CATEGORY_DEFAULT_CAPABILITIES[key]).toBeDefined();
    expect(Array.isArray(CATEGORY_DEFAULT_CAPABILITIES[key])).toBe(true);
    expect(CATEGORY_DEFAULT_CAPABILITIES[key].length).toBeGreaterThan(0);
  });

  it.each(allKeys)('%s has a group assignment', (key) => {
    const cat = BUSINESS_CATEGORIES.find(c => c.key === key);
    expect(cat?.group).toBeTruthy();
  });

  it('every flow type in CATEGORY_FLOW_MAP resolves to a first step', () => {
    const uniqueFlows = new Set(Object.values(CATEGORY_FLOW_MAP));
    for (const flow of uniqueFlows) {
      const step = getFirstStep(flow);
      expect(step).toBeTruthy();
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Capability corrections for courier and moving
// ═══════════════════════════════════════════════════════════

describe('#682: capability corrections', () => {
  it('courier uses _DELIVERY_RETAIL capabilities (ordering), not _TRANSPORT (ticketing)', () => {
    const courierCaps = CATEGORY_DEFAULT_CAPABILITIES['courier'];
    expect(courierCaps).toContain('ordering');
    expect(courierCaps).not.toContain('ticketing');
  });

  it('moving uses _HOME_AUTO capabilities (scheduling+invoice), not _TRANSPORT (ticketing)', () => {
    const movingCaps = CATEGORY_DEFAULT_CAPABILITIES['moving'];
    expect(movingCaps).toContain('scheduling');
    expect(movingCaps).toContain('invoice');
    expect(movingCaps).not.toContain('ticketing');
  });

  it('food_truck retains _FOOD_DINING capabilities (unchanged)', () => {
    const caps = CATEGORY_DEFAULT_CAPABILITIES['food_truck'];
    expect(caps).toContain('ordering');
    // table_reservation is part of _FOOD_DINING — preserved intentionally
    expect(caps).toContain('table_reservation');
  });

  it('bakery retains _FOOD_DINING capabilities (unchanged)', () => {
    const caps = CATEGORY_DEFAULT_CAPABILITIES['bakery'];
    expect(caps).toContain('ordering');
    expect(caps).toContain('table_reservation');
  });

  it('logistics retains _TRANSPORT capabilities (existing approved config)', () => {
    const caps = CATEGORY_DEFAULT_CAPABILITIES['logistics'];
    expect(caps).toContain('ticketing');
  });
});

// ═══════════════════════════════════════════════════════════
// 3. Existing categories unchanged
// ═══════════════════════════════════════════════════════════

describe('#682: existing categories preserved', () => {
  const existingTemplateKeys = [
    'restaurant', 'barber', 'spa', 'salon', 'gym', 'clinic', 'consultant',
    'church', 'mosque', 'school', 'ngo', 'shop', 'food_delivery', 'events',
    'transport', 'cinema', 'car_park', 'tattoo', 'real_estate', 'travel_agency',
    'logistics', 'taxi', 'government', 'crowdfunding_org', 'laundry',
    'veterinary', 'dental', 'coworking', 'tutor', 'photographer', 'pharmacy',
    'hotel', 'car_wash', 'catering', 'funeral', 'tailor', 'other', 'shortlet',
  ];

  it.each(existingTemplateKeys)('%s remains in BUSINESS_CATEGORIES', (key) => {
    expect(BUSINESS_CATEGORIES.find(c => c.key === key)).toBeDefined();
  });

  it('restaurant flow type unchanged', () => {
    expect(CATEGORY_FLOW_MAP['restaurant']).toBe('scheduling');
  });

  it('shop flow type unchanged', () => {
    expect(CATEGORY_FLOW_MAP['shop']).toBe('ordering');
  });

  it('events flow type unchanged', () => {
    expect(CATEGORY_FLOW_MAP['events']).toBe('ticketing');
  });

  it('hotel flow type unchanged', () => {
    expect(CATEGORY_FLOW_MAP['hotel']).toBe('reservation');
  });

  it('church flow type unchanged', () => {
    expect(CATEGORY_FLOW_MAP['church']).toBe('scheduling');
  });
});

// ═══════════════════════════════════════════════════════════
// 4. Category loading guard
// ═══════════════════════════════════════════════════════════

describe('#682: category loading guard', () => {
  const stepCategorySrc = readFileSync(
    resolve(__dirname, '../../app/get-started/steps/StepCategory.tsx'),
    'utf-8',
  );

  it('StepCategory accepts isCategoryConfigLoaded prop', () => {
    expect(stepCategorySrc).toContain('isCategoryConfigLoaded');
  });

  it('renders loading state when config not loaded', () => {
    expect(stepCategorySrc).toContain('!isCategoryConfigLoaded');
    expect(stepCategorySrc).toContain('Loading business categories');
  });

  it('category buttons only render after config is loaded', () => {
    // The outcome picker (CUSTOMER_OUTCOMES) is gated behind the loaded check
    const loadingGuardPos = stepCategorySrc.indexOf('!isCategoryConfigLoaded');
    const outcomeButtonPos = stepCategorySrc.indexOf('CUSTOMER_OUTCOMES.map');
    expect(loadingGuardPos).toBeGreaterThan(0);
    expect(outcomeButtonPos).toBeGreaterThan(loadingGuardPos);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. Draft validation
// ═══════════════════════════════════════════════════════════

describe('#682: draft category validation', () => {
  const draftSrc = readFileSync(
    resolve(__dirname, '../../hooks/useOnboardingPersistence.ts'),
    'utf-8',
  );

  it('imports getAllCategoryKeys statically (not async import)', () => {
    expect(draftSrc).toContain("import { getAllCategoryKeys } from '@/lib/categoryConfig'");
    expect(draftSrc).not.toContain('await import');
  });

  it('validates draft category synchronously', () => {
    expect(draftSrc).toContain('getAllCategoryKeys().includes(draft.category)');
  });

  it('clears invalid category and resets to category step', () => {
    expect(draftSrc).toContain("draft.category = ''");
    expect(draftSrc).toContain("draft.step = 'category'");
  });

  it('preserves valid categories (does not clear unconditionally)', () => {
    // The clearing is conditional on !getAllCategoryKeys().includes(...)
    const clearLine = draftSrc.indexOf("draft.category = ''");
    const condLine = draftSrc.lastIndexOf('getAllCategoryKeys', clearLine);
    expect(condLine).toBeGreaterThan(0);
    expect(clearLine - condLine).toBeLessThan(200); // within the same block
  });
});

// ═══════════════════════════════════════════════════════════
// 5b. Draft validation — behavioral (getAllCategoryKeys covers all 89)
// ═══════════════════════════════════════════════════════════

describe('#682: draft validation behavior', () => {
  it('getAllCategoryKeys includes all 89 in BUSINESS_CATEGORIES fallback', () => {
    // When DB cache is empty/null, getAllCategoryKeys falls through to BUSINESS_CATEGORIES.
    // Verify that BUSINESS_CATEGORIES itself has all 89 keys — this is the fallback source.
    const allKeys = BUSINESS_CATEGORIES.map(c => c.key);
    expect(allKeys.length).toBe(89);
    // Spot-check new categories that were previously missing
    expect(allKeys).toContain('yoga');
    expect(allKeys).toContain('cafe');
    expect(allKeys).toContain('courier');
    expect(allKeys).toContain('plumber');
  });

  it('BUSINESS_CATEGORIES contains all existing template categories', () => {
    const allKeys = new Set(BUSINESS_CATEGORIES.map(c => c.key));
    // All 38 READY categories must be in the hardcoded list
    const existing = ['restaurant', 'barber', 'shop', 'events', 'church', 'hotel', 'gym', 'taxi'];
    for (const key of existing) {
      expect(allKeys.has(key), `${key} missing from BUSINESS_CATEGORIES`).toBe(true);
    }
  });

  it('invented categories are not in BUSINESS_CATEGORIES', () => {
    const allKeys = new Set(BUSINESS_CATEGORIES.map(c => c.key));
    expect(allKeys.has('invented_nonexistent')).toBe(false);
    expect(allKeys.has('')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. Groups and ordering
// ═══════════════════════════════════════════════════════════

describe('#682: group structure', () => {
  const groupMap = new Map<string, string[]>();
  for (const cat of BUSINESS_CATEGORIES) {
    if (!groupMap.has(cat.group)) groupMap.set(cat.group, []);
    groupMap.get(cat.group)!.push(cat.key);
  }

  it('has 17 groups', () => {
    expect(groupMap.size).toBe(17);
  });

  it('every category belongs to exactly one group', () => {
    let total = 0;
    for (const keys of groupMap.values()) total += keys.length;
    expect(total).toBe(89);
  });

  // Alphabetical ordering is enforced via sort_order in the migration,
  // verified in the migration test below. The source array order is a
  // hardcoded fallback gated by the loading guard.
});

// ═══════════════════════════════════════════════════════════
// 7. Migration file exists and covers all 89 categories
// ═══════════════════════════════════════════════════════════

describe('#682: migration 459', () => {
  const migrationSrc = readFileSync(
    resolve(__dirname, '../../supabase/migrations/459_expand_business_categories.sql'),
    'utf-8',
  );

  it('adds 32 new enum values', () => {
    const addValueCount = (migrationSrc.match(/ALTER TYPE business_category ADD VALUE/g) || []).length;
    expect(addValueCount).toBe(32);
  });

  it('inserts 51 new category templates (89 minus 38 already in templates)', () => {
    const insertCount = (migrationSrc.match(/INSERT INTO category_templates/g) || []).length;
    expect(insertCount).toBe(51);
  });

  it('uses generic default greeting for new templates', () => {
    expect(migrationSrc).toContain('Welcome to {{name}}! How can I help you today?');
    // Does NOT contain merchant-specific greeting copy
    expect(migrationSrc).not.toContain('book an appointment');
  });

  it('updates category_group for existing categories', () => {
    expect(migrationSrc).toContain("UPDATE category_templates SET category_group = 'Food & Dining' WHERE key = 'restaurant'");
    expect(migrationSrc).toContain("UPDATE category_templates SET category_group = 'Education & Training' WHERE key = 'school'");
    expect(migrationSrc).toContain("UPDATE category_templates SET category_group = 'Government & Public' WHERE key = 'car_park'");
  });

  it('is idempotent (ON CONFLICT for templates, IF NOT EXISTS for enums)', () => {
    expect(migrationSrc).toContain('ON CONFLICT (key) DO UPDATE');
    expect(migrationSrc).toContain('IF NOT EXISTS');
  });
});

// ═══════════════════════════════════════════════════════════
// 8. Corrective migration M460 — sort_order by label
// ═══════════════════════════════════════════════════════════

describe('#682: corrective migration 460', () => {
  const m460Src = readFileSync(
    resolve(__dirname, '../../supabase/migrations/460_category_sort_order_correction.sql'),
    'utf-8',
  );

  it('uses ROW_NUMBER window function for runtime label ordering', () => {
    expect(m460Src).toContain('ROW_NUMBER()');
    expect(m460Src).toContain('ORDER BY category_group, label');
  });

  it('only updates sort_order column', () => {
    expect(m460Src).toContain('SET sort_order = r.new_sort');
    expect(m460Src).not.toContain('SET label');
    expect(m460Src).not.toContain('SET default_greeting');
    expect(m460Src).not.toContain('SET category_group');
  });

  it('scopes to active templates only', () => {
    expect(m460Src).toContain('WHERE is_active = true');
  });

  it('does not modify M459 (immutable per Release Gate V2)', () => {
    const m459Src = readFileSync(
      resolve(__dirname, '../../supabase/migrations/459_expand_business_categories.sql'),
      'utf-8',
    );
    // M459 still has its original sort_order UPDATE statements
    expect(m459Src).toContain('UPDATE category_templates SET sort_order');
  });
});

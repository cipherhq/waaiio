/**
 * Discovery + Settings wiring consistency (#485) — regression tests
 *
 * Covers Fixes A–F from the CTO-approved bounded scope:
 * A. Settings address persists canonical coordinates
 * B. Manual address edit invalidates stale lat/lng
 * C. Failed save never reports success (pattern verification)
 * D. Distance unit localization (miles ↔ km round trip)
 * E. Discovery description UX (label + prefill behavior)
 * F. Bot uses top-level supports_delivery
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── Fix D: Distance Unit Helpers ──

import {
  getDistanceUnit,
  kmToMiles,
  milesToKm,
  kmToDisplayUnit,
  displayUnitToKm,
  formatDistance,
} from '@/lib/constants';

describe('Fix D — distance unit localization', () => {
  describe('getDistanceUnit', () => {
    it('returns "mi" for US', () => {
      expect(getDistanceUnit('US')).toBe('mi');
    });
    it('returns "mi" for UK (GB)', () => {
      expect(getDistanceUnit('GB')).toBe('mi');
    });
    it('returns "km" for Nigeria', () => {
      expect(getDistanceUnit('NG')).toBe('km');
    });
    it('returns "km" for Ghana', () => {
      expect(getDistanceUnit('GH')).toBe('km');
    });
    it('returns "km" for Canada', () => {
      expect(getDistanceUnit('CA')).toBe('km');
    });
  });

  describe('kmToMiles / milesToKm round trip', () => {
    it('10 km → miles → km ≈ 10 (no cumulative drift)', () => {
      const miles = kmToMiles(10);
      const backToKm = milesToKm(miles);
      expect(backToKm).toBeCloseTo(10, 0);
    });
    it('10 miles → km → miles ≈ 10', () => {
      const km = milesToKm(10);
      const backToMiles = kmToMiles(km);
      expect(backToMiles).toBeCloseTo(10, 0);
    });
    it('1 km ≈ 0.6 mi', () => {
      expect(kmToMiles(1)).toBeCloseTo(0.6, 1);
    });
    it('1 mi ≈ 1.6 km', () => {
      expect(milesToKm(1)).toBeCloseTo(1.6, 1);
    });
    it('0 km → 0 miles', () => {
      expect(kmToMiles(0)).toBe(0);
    });
    it('0 miles → 0 km', () => {
      expect(milesToKm(0)).toBe(0);
    });
    it('100 km US round trip stays close', () => {
      const display = kmToDisplayUnit(100, 'US');
      const canonical = displayUnitToKm(display, 'US');
      expect(canonical).toBeCloseTo(100, 0);
    });
    it('100 km NG round trip is identity', () => {
      const display = kmToDisplayUnit(100, 'NG');
      const canonical = displayUnitToKm(display, 'NG');
      expect(canonical).toBe(100);
    });
  });

  describe('formatDistance', () => {
    it('formats for US in miles', () => {
      const result = formatDistance(10, 'US');
      expect(result).toContain('mi');
      expect(result).toContain('6.2');
    });
    it('formats for NG in km', () => {
      const result = formatDistance(10, 'NG');
      expect(result).toContain('km');
      expect(result).toContain('10.0');
    });
    it('formats for GB in miles', () => {
      const result = formatDistance(16.09, 'GB');
      expect(result).toContain('mi');
      expect(result).toContain('10.0');
    });
  });
});

// ── Fix A: Settings address persists coordinates ──

describe('Fix A — Settings address captures Google coordinates', () => {
  it('BusinessTab handleSave payload includes latitude, longitude, city', () => {
    const source = readFileSync(
      resolve(__dirname, '../../app/dashboard/settings/tabs/BusinessTab.tsx'),
      'utf-8'
    );
    // The update payload must include these coordinate fields
    expect(source).toContain('latitude: form.latitude');
    expect(source).toContain('longitude: form.longitude');
    expect(source).toContain("city: form.city || null");
  });

  it('PlacesAutocomplete onChange captures placeData', () => {
    const source = readFileSync(
      resolve(__dirname, '../../app/dashboard/settings/tabs/BusinessTab.tsx'),
      'utf-8'
    );
    // The onChange callback must accept and use placeData
    expect(source).toContain('onChange={(value, placeData)');
    expect(source).toContain('placeData.lat');
    expect(source).toContain('placeData.lng');
  });

  it('manual text edit in Settings invalidates coordinates', () => {
    const source = readFileSync(
      resolve(__dirname, '../../app/dashboard/settings/tabs/BusinessTab.tsx'),
      'utf-8'
    );
    // When no placeData, lat/lng must be set to null
    expect(source).toContain('latitude: null, longitude: null');
  });
});

// ── Fix B: Discovery manual address clears stale lat/lng ──

describe('Fix B — Discovery manual address edit clears stale coordinates', () => {
  it('onManualChange sets latitude and longitude to null', () => {
    const source = readFileSync(
      resolve(__dirname, '../../app/dashboard/discovery/page.tsx'),
      'utf-8'
    );
    // The onManualChange handler must clear lat/lng
    const manualChangeBlock = source.slice(
      source.indexOf('onManualChange'),
      source.indexOf('onManualChange') + 300
    );
    expect(manualChangeBlock).toContain('latitude: null');
    expect(manualChangeBlock).toContain('longitude: null');
  });
});

// ── Fix C: Failed save never reports success ──

describe('Fix C — save error handling', () => {
  const files = [
    { name: 'Discovery', path: '../../app/dashboard/discovery/page.tsx' },
    { name: 'BusinessTab', path: '../../app/dashboard/settings/tabs/BusinessTab.tsx' },
    { name: 'FeaturesTab', path: '../../app/dashboard/settings/tabs/FeaturesTab.tsx' },
    { name: 'PaymentsTab', path: '../../app/dashboard/settings/tabs/PaymentsTab.tsx' },
    { name: 'NotificationsTab', path: '../../app/dashboard/settings/tabs/NotificationsTab.tsx' },
    { name: 'AccountTab', path: '../../app/dashboard/settings/tabs/AccountTab.tsx' },
    { name: 'IntegrationsTab', path: '../../components/dashboard/settings/IntegrationsTab.tsx' },
  ];

  for (const { name, path } of files) {
    it(`${name} save handlers destructure error from Supabase responses`, () => {
      const source = readFileSync(resolve(__dirname, path), 'utf-8');
      // Every .update().eq() or .upsert() call followed by unconditional setSaved(true)
      // should no longer exist. Check that the file contains { error } destructuring.
      const updateCalls = source.match(/\.update\(/g)?.length || 0;
      const upsertCalls = source.match(/\.upsert\(/g)?.length || 0;
      const totalDbWrites = updateCalls + upsertCalls;

      if (totalDbWrites > 0) {
        // The file should contain error checking patterns
        const errorChecks = (source.match(/\{ error/g)?.length || 0) +
          (source.match(/if \(!res\.ok\)/g)?.length || 0) +
          (source.match(/res\.ok/g)?.length || 0) +
          (source.match(/if \(error\)/g)?.length || 0);
        expect(errorChecks).toBeGreaterThan(0);
      }
    });
  }

  it('Discovery handleSave checks error before showing success', () => {
    const source = readFileSync(
      resolve(__dirname, '../../app/dashboard/discovery/page.tsx'),
      'utf-8'
    );
    const startIdx = source.indexOf('async function handleSave');
    const endIdx = source.indexOf('function update', startIdx);
    const handleSaveBlock = source.slice(startIdx, endIdx);
    expect(handleSaveBlock).toContain('{ error }');
    expect(handleSaveBlock).toContain('if (error)');
    // Success should come AFTER error check
    const errorIdx = handleSaveBlock.indexOf('if (error)');
    const savedIdx = handleSaveBlock.indexOf('setSaved(true)');
    expect(savedIdx).toBeGreaterThan(errorIdx);
  });

  it('BusinessTab handleSave checks error before showing success', () => {
    const source = readFileSync(
      resolve(__dirname, '../../app/dashboard/settings/tabs/BusinessTab.tsx'),
      'utf-8'
    );
    const handleSaveBlock = source.slice(
      source.indexOf('async function handleSave'),
      source.indexOf('async function handleSave') + 900
    );
    expect(handleSaveBlock).toContain('{ error }');
    expect(handleSaveBlock).toContain('if (error)');
  });

  it('BusinessTab handleSaveHours checks error before showing success', () => {
    const source = readFileSync(
      resolve(__dirname, '../../app/dashboard/settings/tabs/BusinessTab.tsx'),
      'utf-8'
    );
    const handleSaveBlock = source.slice(
      source.indexOf('async function handleSaveHours'),
      source.indexOf('async function handleSaveHours') + 900
    );
    expect(handleSaveBlock).toContain('{ error }');
    expect(handleSaveBlock).toContain('if (error)');
  });

  it('BusinessTab time format reload only after confirmed success', () => {
    const source = readFileSync(
      resolve(__dirname, '../../app/dashboard/settings/tabs/BusinessTab.tsx'),
      'utf-8'
    );
    // Find the time format handler — it should check error before reload
    const timeFormatBlock = source.slice(
      source.indexOf('time_format'),
      source.indexOf('time_format') + 400
    );
    expect(timeFormatBlock).toContain('reload');
    // Error check must come before reload
    const errIdx = timeFormatBlock.indexOf('Err');
    const reloadIdx = timeFormatBlock.indexOf('reload');
    expect(errIdx).toBeLessThan(reloadIdx);
  });
});

// ── Fix E: Discovery description UX ──

describe('Fix E — Discovery description UX clarification', () => {
  it('label says "Short Listing Summary" not "Discovery Description"', () => {
    const source = readFileSync(
      resolve(__dirname, '../../app/dashboard/discovery/page.tsx'),
      'utf-8'
    );
    expect(source).toContain('Short Listing Summary');
    // Old label should be gone
    expect(source).not.toContain('>Discovery Description<');
  });

  it('helper text mentions search results and 200 character limit', () => {
    const source = readFileSync(
      resolve(__dirname, '../../app/dashboard/discovery/page.tsx'),
      'utf-8'
    );
    expect(source).toContain('shown in search');
    expect(source).toContain('200');
  });

  it('prefill from description on first focus when discovery_description is blank', () => {
    const source = readFileSync(
      resolve(__dirname, '../../app/dashboard/discovery/page.tsx'),
      'utf-8'
    );
    // Should contain onFocus handler that checks for blank discovery_description
    expect(source).toContain('onFocus');
    expect(source).toContain('config.description');
    expect(source).toContain('.slice(0, 200)');
  });
});

// ── Fix F: Bot delivery source alignment ──

describe('Fix F — bot supports_delivery reads from top-level column', () => {
  it('loadBusinessKnowledge selects supports_delivery column', () => {
    const source = readFileSync(
      resolve(__dirname, '../../lib/bot/business-knowledge.ts'),
      'utf-8'
    );
    // The select query must include supports_delivery as a top-level column
    const selectBlock = source.slice(
      source.indexOf(".select('name, description"),
      source.indexOf(".select('name, description") + 200
    );
    expect(selectBlock).toContain('supports_delivery');
    expect(selectBlock).toContain('delivery_radius_km');
  });

  it('supportsDelivery reads from biz.supports_delivery not metadata', () => {
    const source = readFileSync(
      resolve(__dirname, '../../lib/bot/business-knowledge.ts'),
      'utf-8'
    );
    // Must use biz.supports_delivery, not metadata.supports_delivery
    expect(source).toContain('supportsDelivery: !!(biz.supports_delivery)');
    expect(source).not.toContain('metadata.supports_delivery');
  });

  it('BusinessKnowledge interface uses deliveryRadius not deliveryArea', () => {
    const source = readFileSync(
      resolve(__dirname, '../../lib/bot/business-knowledge.ts'),
      'utf-8'
    );
    expect(source).toContain('deliveryRadius: number | null');
    expect(source).not.toContain('deliveryArea: string | null');
  });
});

// ── Cross-cutting: existing wiring stays intact ──

describe('existing wiring regression', () => {
  it('logo upload still uses /api/business/upload-logo with auth', () => {
    const source = readFileSync(
      resolve(__dirname, '../../app/dashboard/settings/tabs/BusinessTab.tsx'),
      'utf-8'
    );
    expect(source).toContain('/api/business/upload-logo');
    expect(source).toContain("res.ok && data.url");
  });

  it('operating hours save still writes to operating_hours column', () => {
    const source = readFileSync(
      resolve(__dirname, '../../app/dashboard/settings/tabs/BusinessTab.tsx'),
      'utf-8'
    );
    expect(source).toContain('update({ operating_hours: hours })');
  });

  it('Discovery page reads description for completeness but does not write it', () => {
    const source = readFileSync(
      resolve(__dirname, '../../app/dashboard/discovery/page.tsx'),
      'utf-8'
    );
    // Reads description for completeness
    expect(source).toContain("config.description");
    // The save payload should NOT include a bare 'description' field (only discovery_description)
    const payloadBlock = source.slice(
      source.indexOf('const payload = {'),
      source.indexOf('const payload = {') + 500
    );
    // All 'description:' occurrences should be prefixed with 'discovery_'
    const descMatches = payloadBlock.match(/(?<!discovery_)description:/g);
    expect(descMatches).toBeNull();
  });
});

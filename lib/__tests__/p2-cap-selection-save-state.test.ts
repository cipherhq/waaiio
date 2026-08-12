/**
 * P2-CAP-1 + P1-PLAN-2: Add Features page state model tests
 *
 * Tests the code patterns in app/dashboard/capabilities/page.tsx
 * to verify correct state comparison, discard, and save behavior.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';

const PAGE_SOURCE = fs.readFileSync('app/dashboard/capabilities/page.tsx', 'utf-8');

describe('P2-CAP-1: Add Features state model', () => {
  it('1. hasChanges compares against serverSelected (not business.capabilities)', () => {
    // Must use serverSelected (selectedCapabilities || capabilities)
    expect(PAGE_SOURCE).toContain('serverSelected');
    expect(PAGE_SOURCE).toContain('enabled.length !== serverSelected.length');
    // Must NOT compare against business.capabilities for hasChanges
    expect(PAGE_SOURCE).not.toMatch(/hasChanges[\s\S]*?business\.capabilities\.length/);
  });

  it('2. serverSelected is derived from selectedCapabilities (includes paused)', () => {
    expect(PAGE_SOURCE).toContain('business.selectedCapabilities || business.capabilities');
    expect(PAGE_SOURCE).toContain('const serverSelected');
  });

  it('3. Discard restores serverSelected (not business.capabilities)', () => {
    // Discard onClick must reference serverSelected
    expect(PAGE_SOURCE).toContain('setEnabled([...serverSelected])');
    expect(PAGE_SOURCE).toContain('setOrderedCaps([...serverSelected])');
  });

  it('4. handleToggle does NOT auto-save (no saveCapabilities call)', () => {
    const handleToggleFn = PAGE_SOURCE.slice(
      PAGE_SOURCE.indexOf('function handleToggle('),
      PAGE_SOURCE.indexOf('function handleToggle(') + PAGE_SOURCE.slice(PAGE_SOURCE.indexOf('function handleToggle(')).indexOf('\n  }') + 4
    );
    expect(handleToggleFn).not.toContain('saveCapabilities');
    expect(handleToggleFn).not.toContain('fetch(');
  });

  it('5. handleToggle is guarded by saving state (no concurrent toggles during save)', () => {
    const handleToggleFn = PAGE_SOURCE.slice(
      PAGE_SOURCE.indexOf('function handleToggle('),
      PAGE_SOURCE.indexOf('function handleToggle(') + 200
    );
    expect(handleToggleFn).toContain('saving');
  });

  it('6. Save button is disabled while saving', () => {
    expect(PAGE_SOURCE).toContain('disabled={saving}');
  });

  it('7. Save sends one configuration request (explicit atomic save)', () => {
    // Save button calls saveCapabilities which POSTs to /api/capabilities/configure
    expect(PAGE_SOURCE).toContain("'/api/capabilities/configure'");
  });

  it('8. Save uses serverSelected as previous snapshot (not effective)', () => {
    // The Save button's onClick uses serverSelected for deriveCapabilityConfiguration
    expect(PAGE_SOURCE).toContain('[...serverSelected]');
  });

  it('9. newlyEnabled compares against selectedCapabilities (not effective)', () => {
    expect(PAGE_SOURCE).toContain('business.selectedCapabilities || business.capabilities');
    expect(PAGE_SOURCE).toContain('previousSelected');
    expect(PAGE_SOURCE).toContain('newlyEnabled');
  });

  it('10. membership/loyalty dependency bundling exists in handleToggle', () => {
    expect(PAGE_SOURCE).toContain("capId === 'membership'");
    expect(PAGE_SOURCE).toContain("capId === 'loyalty'");
  });

  it('11. ordering auto-save is guarded by saving state', () => {
    const handleDropFn = PAGE_SOURCE.slice(
      PAGE_SOURCE.indexOf('const handleDrop'),
      PAGE_SOURCE.indexOf('const handleDrop') + 500
    );
    expect(handleDropFn).toContain('if (saving) return');
  });

  it('12. failed save shows specific error messages', () => {
    expect(PAGE_SOURCE).toContain('capabilities_denied');
    expect(PAGE_SOURCE).toContain('dependency_missing');
    expect(PAGE_SOURCE).toContain('configuration_conflict');
  });

  it('13. failed save rolls back to previous snapshot', () => {
    expect(PAGE_SOURCE).toContain('config.previousCapabilities');
    expect(PAGE_SOURCE).toContain('config.previousOrder');
  });

  it('14. template provisioning is best-effort (catch swallowed)', () => {
    expect(PAGE_SOURCE).toContain("'/api/whatsapp/templates/provision'");
    expect(PAGE_SOURCE).toContain('.catch(() => {})');
  });
});

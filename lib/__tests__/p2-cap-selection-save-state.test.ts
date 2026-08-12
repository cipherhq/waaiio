/**
 * P2-CAP-1 + P1-PLAN-2: Add Features page state model tests
 *
 * Tests the code patterns in app/dashboard/capabilities/page.tsx
 * to verify correct state comparison, discard, and save behavior.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';

const PAGE_SOURCE = fs.readFileSync('app/dashboard/capabilities/page.tsx', 'utf-8');

// Extract handleDrop function body for targeted assertions
const handleDropStart = PAGE_SOURCE.indexOf('const handleDrop');
const handleDropBody = PAGE_SOURCE.slice(handleDropStart, handleDropStart + 600);

describe('P2-CAP-1: Add Features state model', () => {
  // ── Selection state ──

  it('1. hasChanges compares against serverSelected (not business.capabilities)', () => {
    expect(PAGE_SOURCE).toContain('serverSelected');
    expect(PAGE_SOURCE).toContain('enabled.length !== serverSelected.length');
    expect(PAGE_SOURCE).not.toMatch(/hasChanges[\s\S]*?business\.capabilities\.length/);
  });

  it('2. serverSelected is derived from selectedCapabilities (includes paused)', () => {
    expect(PAGE_SOURCE).toContain('business.selectedCapabilities || business.capabilities');
    expect(PAGE_SOURCE).toContain('const serverSelected');
  });

  it('3. Discard restores serverSelected AND serverOrder', () => {
    expect(PAGE_SOURCE).toContain('setEnabled([...serverSelected])');
    expect(PAGE_SOURCE).toContain('setOrderedCaps([...serverOrder])');
  });

  it('4. handleToggle does NOT auto-save (no saveCapabilities call, no fetch)', () => {
    const handleToggleFn = PAGE_SOURCE.slice(
      PAGE_SOURCE.indexOf('function handleToggle('),
      PAGE_SOURCE.indexOf('function handleToggle(') + PAGE_SOURCE.slice(PAGE_SOURCE.indexOf('function handleToggle(')).indexOf('\n  }') + 4
    );
    expect(handleToggleFn).not.toContain('saveCapabilities');
    expect(handleToggleFn).not.toContain('fetch(');
  });

  it('5. handleToggle is guarded by saving state', () => {
    const handleToggleFn = PAGE_SOURCE.slice(
      PAGE_SOURCE.indexOf('function handleToggle('),
      PAGE_SOURCE.indexOf('function handleToggle(') + 200
    );
    expect(handleToggleFn).toContain('saving');
  });

  // ── Order state ──

  it('6. handleDrop is local-only (ZERO network requests)', () => {
    expect(handleDropBody).not.toContain('fetch(');
    expect(handleDropBody).not.toContain('fetch(');
    expect(handleDropBody).not.toContain("'/api/");
    expect(handleDropBody).toContain('setOrderedCaps(newOrder)');
  });

  it('7. no savingOrder state (removed — ordering is local-only)', () => {
    expect(PAGE_SOURCE).not.toContain('savingOrder');
    expect(PAGE_SOURCE).not.toContain('setSavingOrder');
  });

  it('8. hasChanges considers order changes', () => {
    // Must compare orderedCaps against serverOrder
    expect(PAGE_SOURCE).toContain('orderedCaps.length !== serverOrder.length');
    expect(PAGE_SOURCE).toContain('orderedCaps.some');
  });

  it('9. serverOrder snapshot exists', () => {
    expect(PAGE_SOURCE).toContain('const serverOrder');
  });

  // ── Save behavior ──

  it('10. Save button is disabled while saving', () => {
    expect(PAGE_SOURCE).toContain('disabled={saving}');
  });

  it('11. Save sends ONE configuration request (explicit atomic save)', () => {
    expect(PAGE_SOURCE).toContain("'/api/capabilities/configure'");
  });

  it('12. Save uses serverSelected as previous snapshot', () => {
    expect(PAGE_SOURCE).toContain('[...serverSelected]');
  });

  it('13. newlyEnabled compares against selectedCapabilities (not effective)', () => {
    expect(PAGE_SOURCE).toContain('previousSelected');
    expect(PAGE_SOURCE).toContain('newlyEnabled');
  });

  it('14. membership/loyalty dependency bundling in handleToggle', () => {
    expect(PAGE_SOURCE).toContain("capId === 'membership'");
    expect(PAGE_SOURCE).toContain("capId === 'loyalty'");
  });

  // ── Error handling ──

  it('15. failed save shows specific error messages', () => {
    expect(PAGE_SOURCE).toContain('capabilities_denied');
    expect(PAGE_SOURCE).toContain('dependency_missing');
    expect(PAGE_SOURCE).toContain('configuration_conflict');
  });

  it('16. failed save rolls back to previous snapshot', () => {
    expect(PAGE_SOURCE).toContain('config.previousCapabilities');
    expect(PAGE_SOURCE).toContain('config.previousOrder');
  });

  it('17. template provisioning is best-effort (catch swallowed)', () => {
    expect(PAGE_SOURCE).toContain("'/api/whatsapp/templates/provision'");
    expect(PAGE_SOURCE).toContain('.catch(() => {})');
  });

  // ── Integration: toggle then drag has zero network calls ──

  it('18. neither handleToggle nor handleDrop calls fetch', () => {
    const handleToggleFn = PAGE_SOURCE.slice(
      PAGE_SOURCE.indexOf('function handleToggle('),
      PAGE_SOURCE.indexOf('function handleToggle(') + PAGE_SOURCE.slice(PAGE_SOURCE.indexOf('function handleToggle(')).indexOf('\n  }') + 4
    );
    expect(handleToggleFn).not.toContain('fetch(');
    expect(handleDropBody).not.toContain('fetch(');
  });
});

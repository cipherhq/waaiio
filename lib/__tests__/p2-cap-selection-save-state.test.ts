/**
 * P2-CAP-1 + P1-PLAN-2: Add Features page state model tests
 *
 * Tests the code patterns in app/dashboard/capabilities/page.tsx
 * to verify correct state comparison, discard, save, and rollback behavior.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';

const PAGE_SOURCE = fs.readFileSync('app/dashboard/capabilities/page.tsx', 'utf-8');

const handleDropStart = PAGE_SOURCE.indexOf('const handleDrop');
const handleDropBody = PAGE_SOURCE.slice(handleDropStart, handleDropStart + 600);

describe('P2-CAP-1: Add Features state model', () => {
  // ── Selection state ──

  it('1. hasChanges compares against serverSelected (not business.capabilities)', () => {
    expect(PAGE_SOURCE).toContain('serverSelected');
    expect(PAGE_SOURCE).toContain('enabled.length !== serverSelected.length');
    expect(PAGE_SOURCE).not.toMatch(/hasChanges[\s\S]*?business\.capabilities\.length/);
  });

  it('2. serverSelected derived from selectedCapabilities (includes paused)', () => {
    expect(PAGE_SOURCE).toContain('business.selectedCapabilities || business.capabilities');
    expect(PAGE_SOURCE).toContain('const serverSelected');
  });

  it('3. Discard restores serverSelected AND serverOrder', () => {
    expect(PAGE_SOURCE).toContain('setEnabled([...serverSelected])');
    expect(PAGE_SOURCE).toContain('setOrderedCaps([...serverOrder])');
  });

  it('4. handleToggle does NOT auto-save', () => {
    const handleToggleFn = PAGE_SOURCE.slice(
      PAGE_SOURCE.indexOf('function handleToggle('),
      PAGE_SOURCE.indexOf('function handleToggle(') + PAGE_SOURCE.slice(PAGE_SOURCE.indexOf('function handleToggle(')).indexOf('\n  }') + 4
    );
    expect(handleToggleFn).not.toContain('handleSave');
    expect(handleToggleFn).not.toContain('fetch(');
  });

  it('5. handleToggle guarded by saving state', () => {
    const start = PAGE_SOURCE.indexOf('function handleToggle(');
    expect(PAGE_SOURCE.slice(start, start + 200)).toContain('saving');
  });

  // ── Order state ──

  it('6. handleDrop is local-only (ZERO network requests)', () => {
    expect(handleDropBody).not.toContain('fetch(');
    expect(handleDropBody).not.toContain("'/api/");
    expect(handleDropBody).toContain('setOrderedCaps(newOrder)');
  });

  it('7. no savingOrder state', () => {
    expect(PAGE_SOURCE).not.toContain('savingOrder');
    expect(PAGE_SOURCE).not.toContain('setSavingOrder');
  });

  it('8. hasChanges considers order changes', () => {
    expect(PAGE_SOURCE).toContain('orderedCaps.length !== serverOrder.length');
    expect(PAGE_SOURCE).toContain('orderedCaps.some');
  });

  it('9. serverOrder snapshot exists', () => {
    expect(PAGE_SOURCE).toContain('const serverOrder');
  });

  // ── Save behavior ──

  it('10. Save button disabled while saving', () => {
    expect(PAGE_SOURCE).toContain('disabled={saving}');
  });

  it('11. Save sends ONE configure request', () => {
    expect(PAGE_SOURCE).toContain("'/api/capabilities/configure'");
  });

  it('12. Save button calls handleSave directly', () => {
    expect(PAGE_SOURCE).toContain('onClick={handleSave}');
  });

  // ── Rollback ──

  it('13. failed save rolls back to SERVER selection (not local draft)', () => {
    const handleSaveFn = PAGE_SOURCE.slice(
      PAGE_SOURCE.indexOf('async function handleSave'),
      PAGE_SOURCE.indexOf('async function handleSave') + PAGE_SOURCE.slice(PAGE_SOURCE.indexOf('async function handleSave')).indexOf('\n  }') + 4
    );
    expect(handleSaveFn).toContain('setEnabled([...serverSelected])');
    expect(handleSaveFn).toContain('setOrderedCaps([...serverOrder])');
  });

  it('14. network error also rolls back to SERVER state', () => {
    const handleSaveFn = PAGE_SOURCE.slice(
      PAGE_SOURCE.indexOf('async function handleSave'),
      PAGE_SOURCE.indexOf('async function handleSave') + PAGE_SOURCE.slice(PAGE_SOURCE.indexOf('async function handleSave')).indexOf('\n  }') + 4
    );
    const rollbackCount = (handleSaveFn.match(/setEnabled\(\[\.\.\.serverSelected\]\)/g) || []).length;
    expect(rollbackCount).toBeGreaterThanOrEqual(2);
    const orderRollbackCount = (handleSaveFn.match(/setOrderedCaps\(\[\.\.\.serverOrder\]\)/g) || []).length;
    expect(orderRollbackCount).toBeGreaterThanOrEqual(2);
  });

  it('15. rollback does NOT use config.previousOrder (which was local draft)', () => {
    const handleSaveFn = PAGE_SOURCE.slice(
      PAGE_SOURCE.indexOf('async function handleSave'),
      PAGE_SOURCE.indexOf('async function handleSave') + PAGE_SOURCE.slice(PAGE_SOURCE.indexOf('async function handleSave')).indexOf('\n  }') + 4
    );
    expect(handleSaveFn).not.toContain('config.previousCapabilities');
    expect(handleSaveFn).not.toContain('config.previousOrder');
  });

  // ── Error UX ──

  it('16. failed save shows specific error messages', () => {
    expect(PAGE_SOURCE).toContain('capabilities_denied');
    expect(PAGE_SOURCE).toContain('dependency_missing');
    expect(PAGE_SOURCE).toContain('configuration_conflict');
  });

  it('17. template provisioning is best-effort', () => {
    expect(PAGE_SOURCE).toContain("'/api/whatsapp/templates/provision'");
    expect(PAGE_SOURCE).toContain('.catch(() => {})');
  });

  // ── Integration ──

  it('18. neither handleToggle nor handleDrop calls fetch', () => {
    const handleToggleFn = PAGE_SOURCE.slice(
      PAGE_SOURCE.indexOf('function handleToggle('),
      PAGE_SOURCE.indexOf('function handleToggle(') + PAGE_SOURCE.slice(PAGE_SOURCE.indexOf('function handleToggle(')).indexOf('\n  }') + 4
    );
    expect(handleToggleFn).not.toContain('fetch(');
    expect(handleDropBody).not.toContain('fetch(');
  });

  it('19. newlyEnabled compares against serverSelected', () => {
    expect(PAGE_SOURCE).toContain('new Set(serverSelected)');
    expect(PAGE_SOURCE).toContain('newlyEnabled');
  });

  it('20. membership/loyalty dependency bundling in handleToggle', () => {
    expect(PAGE_SOURCE).toContain("capId === 'membership'");
    expect(PAGE_SOURCE).toContain("capId === 'loyalty'");
  });
});

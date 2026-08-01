/**
 * Source-path verification tests for capability configuration callers.
 *
 * Verifies that AccountTab, Capabilities page, and WhatsApp page:
 * - Use selectedCapabilities (not effective capabilities)
 * - Handle errors without stuck saving state
 * - Roll back on failure
 * - Don't provision paused capabilities as new
 *
 * These are static analysis/import tests — they read the source and verify patterns.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

function readSource(path: string): string {
  return readFileSync(resolve(path), 'utf-8');
}

describe('AccountTab: post-upgrade capability save', () => {
  const src = readSource('app/dashboard/settings/tabs/AccountTab.tsx');

  it('uses selectedCapabilities (not effective capabilities)', () => {
    // Must reference business.selectedCapabilities for the base set
    expect(src).toContain('business.selectedCapabilities');
    // Must NOT use the useCapabilities() hook result directly for the API call
    expect(src).not.toMatch(/const allEnabled = \[\.\.\.new Set\(\[\.\.\.capabilities,/);
  });

  it('wraps fetch in try/catch', () => {
    // The capability save block should have try/catch
    expect(src).toContain('} catch {');
    expect(src).toContain('Network error saving capabilities');
  });

  it('clears capSaving in finally', () => {
    expect(src).toContain('} finally {');
    expect(src).toContain('setCapSaving(false)');
  });

  it('does not use alert() for capability save errors', () => {
    // Should not have alert() in the capability modal save handler
    // Check that setUpgradeError is used instead
    expect(src).toContain('setUpgradeError(');
    // The old alert pattern should be gone
    expect(src).not.toMatch(/alert\(data\.reason === 'capabilities_denied'/);
  });

  it('handles configuration_conflict error', () => {
    expect(src).toContain('configuration_conflict');
    expect(src).toContain('Configuration changed elsewhere');
  });
});

describe('Capabilities page: save and rollback', () => {
  const src = readSource('app/dashboard/capabilities/page.tsx');

  it('uses deriveCapabilityConfiguration for toggle', () => {
    expect(src).toContain('deriveCapabilityConfiguration(');
  });

  it('passes explicit config to saveCapabilities (not reading closure state)', () => {
    // saveCapabilities receives config object, does not read orderedCaps or enabled
    expect(src).toContain('saveCapabilities(config)');
    // The save function signature takes explicit config
    expect(src).toContain('async function saveCapabilities(config:');
  });

  it('restores previous state from config on API failure', () => {
    expect(src).toContain('setEnabled(config.previousCapabilities)');
    expect(src).toContain('setOrderedCaps(config.previousOrder)');
  });

  it('wraps fetch in try/catch with finally', () => {
    expect(src).toContain('} catch {');
    expect(src).toMatch(/} finally \{[\s\S]*?setSaving\(false\)/);
  });

  it('detects newly enabled against selectedCapabilities not effective', () => {
    expect(src).toContain('business.selectedCapabilities || business.capabilities');
    expect(src).toContain('const previousSelected = new Set(');
  });

  it('paused selected capability is NOT newly activated', () => {
    expect(src).toContain('previousSelected.has(cap)');
  });

  it('handles configuration_conflict with refresh guidance', () => {
    expect(src).toContain('configuration_conflict');
    expect(src).toContain('refresh the page');
  });

  it('uses atomic configure endpoint for reorder (not multiple toggle calls)', () => {
    const handleDropSection = src.slice(src.indexOf('const handleDrop'), src.indexOf('const handleDragEnd'));
    expect(handleDropSection).toContain('/api/capabilities/configure');
    expect(handleDropSection).not.toContain('Promise.all');
  });

  it('reorder sends explicit currentEnabled snapshot', () => {
    const handleDropSection = src.slice(src.indexOf('const handleDrop'), src.indexOf('const handleDragEnd'));
    expect(handleDropSection).toContain('const currentEnabled = [...enabled]');
    expect(handleDropSection).toContain('capabilities: currentEnabled');
  });

  it('order in API payload uses synchronously derived newOrder (not stale state)', () => {
    // In handleToggle, order comes from deriveCapabilityConfiguration
    // In handleDrop, order comes from the synchronous splice
    // Neither reads orderedCaps at fetch-time from closure
    const saveSection = src.slice(src.indexOf('async function saveCapabilities'));
    expect(saveSection).toContain('order: config.order');
    expect(saveSection).not.toContain('order: orderedCaps');
  });
});

describe('WhatsApp page: metadata caller rollback', () => {
  const src = readSource('app/dashboard/whatsapp/page.tsx');

  it('captures previous order before optimistic mutation', () => {
    // In handleDrop, must capture before splice
    const dropSection = src.slice(
      src.indexOf('const handleDrop'),
      src.indexOf('const handleDrop') + 2000,
    );
    expect(dropSection).toContain('const previousOrder = [...orderedCaps]');
  });

  it('restores previous order on failure (not stale closure)', () => {
    const dropSection = src.slice(
      src.indexOf('const handleDrop'),
      src.indexOf('const handleDrop') + 2000,
    );
    expect(dropSection).toContain('setOrderedCaps(previousOrder)');
    // Must NOT reference orderedCaps in the revert (stale closure)
    expect(dropSection).not.toContain('setOrderedCaps([...orderedCaps])');
  });

  it('clears saving state in finally', () => {
    const dropSection = src.slice(
      src.indexOf('const handleDrop'),
      src.indexOf('const handleDrop') + 2000,
    );
    expect(dropSection).toContain('} finally {');
    expect(dropSection).toContain('setSavingOrder(false)');
  });

  it('shows error on failure', () => {
    const dropSection = src.slice(
      src.indexOf('const handleDrop'),
      src.indexOf('const handleDrop') + 2000,
    );
    expect(dropSection).toContain('setSaveError(');
  });

  it('handles network exceptions in label save', () => {
    const labelSection = src.slice(
      src.indexOf('handleSaveCustomLabel'),
      src.indexOf('handleSaveCustomLabel') + 1500,
    );
    expect(labelSection).toContain('} catch {');
    expect(labelSection).toContain('} finally {');
    expect(labelSection).toContain('setSavingLabel(null)');
  });
});

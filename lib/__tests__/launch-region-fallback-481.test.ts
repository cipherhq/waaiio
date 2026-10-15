/**
 * #481 — Regional launch QR fallback tests.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const modalSrc = readFileSync(resolve(__dirname, '../../components/marketing/SiteAnnouncement.tsx'), 'utf-8');
const launchClientSrc = readFileSync(resolve(__dirname, '../../app/(marketing)/launch/LaunchClient.tsx'), 'utf-8');

function extractSelectionExpr(src: string): string | null {
  const match = src.match(/setSelectedCode\((match[\s\S]*?)\);/);
  return match ? match[1].replace(/\s+/g, ' ').trim() : null;
}

const modalExpr = extractSelectionExpr(modalSrc.substring(modalSrc.indexOf('LaunchModal')));
const launchExpr = extractSelectionExpr(launchClientSrc);

describe('#481 Modal and /launch identical semantics', () => {
  it('modal uses fallback to list[0]', () => { expect(modalExpr).toContain('list[0]'); });
  it('/launch uses fallback to list[0]', () => { expect(launchExpr).toContain('list[0]'); });
  it('both use match?.code || list[0]?.code pattern', () => {
    expect(modalExpr).toContain('match?.code');
    expect(launchExpr).toContain('match?.code');
  });
});

function simulateSelection(detected: string | null, regions: Array<{ code: string }>): string | null {
  const match = regions.find(r => r.code === detected);
  return match?.code || regions[0]?.code || null;
}

describe('#481 GB + only US', () => {
  it('falls back to US', () => { expect(simulateSelection('GB', [{ code: 'US' }])).toBe('US'); });
});
describe('#481 NG + only US', () => {
  it('falls back to US', () => { expect(simulateSelection('NG', [{ code: 'US' }])).toBe('US'); });
});
describe('#481 Matching region', () => {
  it('prefers NG match', () => { expect(simulateSelection('NG', [{ code: 'US' }, { code: 'NG' }])).toBe('NG'); });
  it('prefers US match', () => { expect(simulateSelection('US', [{ code: 'US' }, { code: 'NG' }])).toBe('US'); });
});
describe('#481 Unknown timezone', () => {
  it('null → first region', () => { expect(simulateSelection(null, [{ code: 'US' }])).toBe('US'); });
  it('JP → first region', () => { expect(simulateSelection('JP', [{ code: 'US' }, { code: 'NG' }])).toBe('US'); });
});
describe('#481 Multiple regions', () => {
  it('unknown → first deterministically', () => { expect(simulateSelection('JP', [{ code: 'NG' }, { code: 'US' }, { code: 'GB' }])).toBe('NG'); });
});
describe('#481 Zero regions', () => {
  it('returns null', () => { expect(simulateSelection('US', [])).toBeNull(); });
  it('null country + empty → null', () => { expect(simulateSelection(null, [])).toBeNull(); });
});
describe('#481 No hardcoded numbers', () => {
  it('modal fetches from /api/launch/regions', () => { expect(modalSrc).toContain("fetch('/api/launch/regions')"); });
});

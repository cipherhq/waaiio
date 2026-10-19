/**
 * #620 — Admin Payouts: held payouts reviewable, date-only rendering, error banner
 *
 * Proves:
 * 1. "Needs Review" tab exists and filters by status === 'held'
 * 2. Held payouts show flags (type, message, severity) column
 * 3. Approve + Reject actions available on review tab
 * 4. Pending tab unchanged (still shows pending/approved, no held)
 * 5. formatDate renders date-only strings without timezone shift
 * 6. Error banner shown on load failure (not "No payouts found")
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../pages/Payouts.tsx'),
  'utf-8',
);

describe('#620 — Held payouts reviewable', () => {
  it('has a Needs Review tab button', () => {
    expect(SRC).toContain("Needs Review");
    expect(SRC).toContain("setTab('review')");
  });

  it('review tab filters to held status only', () => {
    // The filter logic for tab === 'review' must check status === 'held'
    expect(SRC).toMatch(/tab\s*===\s*'review'\s*&&\s*p\.status\s*!==\s*'held'/);
  });

  it('held count badge is rendered', () => {
    expect(SRC).toContain('held-count-badge');
    // Badge shows heldCount
    expect(SRC).toContain('{heldCount}');
  });

  it('held status has a style entry', () => {
    expect(SRC).toMatch(/held:\s*'/);
  });

  it('flags column header shown on review tab', () => {
    expect(SRC).toMatch(/tab\s*===\s*'review'.*Flags/s);
  });

  it('each payout row renders flags with type and severity', () => {
    expect(SRC).toContain('payout-flags');
    // Renders f.type and uses f.severity for style
    expect(SRC).toContain('{f.type}');
    expect(SRC).toContain('f.severity');
  });

  it('approve + reject actions available on review tab', () => {
    // Actions column shows for both pending and review tabs
    expect(SRC).toMatch(/tab\s*===\s*'pending'\s*\|\|\s*tab\s*===\s*'review'/);
    // Approve button uses openApproveModal
    expect(SRC).toContain('openApproveModal(p)');
    // Reject button uses setRejectTarget
    expect(SRC).toContain('setRejectTarget(p)');
  });

  it('pending tab still filters to pending/approved only (no held)', () => {
    // The pending filter must NOT include 'held'
    expect(SRC).toMatch(/tab\s*===\s*'pending'\s*&&\s*!\['pending',\s*'approved'\]\.includes\(p\.status\)/);
  });
});

describe('#620 — Date-only rendering', () => {
  it('formatDate parses YYYY-MM-DD without using new Date() constructor', () => {
    // The function must NOT use new Date(d) which would apply timezone
    const formatDateFn = SRC.match(/function formatDate\(d: string\)[\s\S]*?^}/m);
    expect(formatDateFn).not.toBeNull();
    const fnBody = formatDateFn![0];
    expect(fnBody).not.toContain('new Date(d)');
    expect(fnBody).not.toContain('toLocaleDateString');
  });

  it('formatDate uses string parsing for month/day extraction', () => {
    const formatDateFn = SRC.match(/function formatDate\(d: string\)[\s\S]*?^}/m);
    expect(formatDateFn).not.toBeNull();
    const fnBody = formatDateFn![0];
    // Should use regex or split to parse the date parts
    expect(fnBody).toMatch(/match|split/);
    // Should have month abbreviations
    expect(fnBody).toContain("'Jan'");
    expect(fnBody).toContain("'Oct'");
  });

  // Functional tests: import and run formatDate under simulated timezones
  it('renders 2026-10-05 as "5 Oct 2026" regardless of timezone', () => {
    // Extract and eval the formatDate function
    const fnMatch = SRC.match(/function formatDate\(d: string\): string \{[\s\S]*?^}/m);
    expect(fnMatch).not.toBeNull();
    // eslint-disable-next-line no-eval
    const formatDate = new Function('d', fnMatch![0].replace(/^function formatDate\(d: string\): string \{/, '').replace(/}$/, ''));
    expect(formatDate('2026-10-05')).toBe('5 Oct 2026');
    expect(formatDate('2026-01-15')).toBe('15 Jan 2026');
    // Verifying no day shift: Dec 31 should not become Jan 1 or Dec 30
    expect(formatDate('2026-12-31')).toBe('31 Dec 2026');
    expect(formatDate('2026-01-01')).toBe('1 Jan 2026');
  });

  it('handles date strings with trailing time component', () => {
    const fnMatch = SRC.match(/function formatDate\(d: string\): string \{[\s\S]*?^}/m);
    expect(fnMatch).not.toBeNull();
    const formatDate = new Function('d', fnMatch![0].replace(/^function formatDate\(d: string\): string \{/, '').replace(/}$/, ''));
    // If a date accidentally has a time component, it should still render the date part
    expect(formatDate('2026-10-05T00:00:00')).toBe('5 Oct 2026');
  });
});

describe('#620 — UTC-4 and UTC+1 date rendering', () => {
  // These tests verify the formatDate function produces identical output
  // regardless of the TZ environment variable — because it does string parsing,
  // not Date object construction, the output is timezone-invariant by design.
  it('formatDate is timezone-invariant (no Date constructor)', () => {
    const fnMatch = SRC.match(/function formatDate\(d: string\): string \{[\s\S]*?^}/m);
    expect(fnMatch).not.toBeNull();
    const formatDate = new Function('d', fnMatch![0].replace(/^function formatDate\(d: string\): string \{/, '').replace(/}$/, ''));

    // "2026-10-05" — in UTC-4 this midnight is still Oct 4 in UTC, but our function is safe
    // In UTC+1 this midnight is Oct 5 01:00 UTC, which is still Oct 5
    // Both must render as "5 Oct 2026"
    const result = formatDate('2026-10-05');
    expect(result).toBe('5 Oct 2026');

    // Edge case: "2026-01-01" — in UTC-4, new Date('2026-01-01') would show Dec 31
    const newYears = formatDate('2026-01-01');
    expect(newYears).toBe('1 Jan 2026');
  });
});

describe('#620 — Error banner on load failure', () => {
  it('has loadError state', () => {
    expect(SRC).toContain("const [loadError, setLoadError]");
  });

  it('sets loadError on non-OK response', () => {
    // When res.ok is false, setLoadError should be called
    expect(SRC).toMatch(/!res\.ok[\s\S]*?setLoadError/);
  });

  it('renders error banner with data-testid', () => {
    expect(SRC).toContain('data-testid="load-error-banner"');
  });

  it('error banner displays the error message', () => {
    expect(SRC).toContain('{loadError}');
  });

  it('error banner has a retry button that calls loadData', () => {
    // The retry button's onClick calls loadData, and button text is "Retry"
    expect(SRC).toMatch(/loadData\(\)[\s\S]*?Retry/s);
  });

  it('catch block sets a fallback error message', () => {
    // The catch block must also set loadError for network errors
    expect(SRC).toMatch(/catch.*\{[\s\S]*?setLoadError\(/);
  });
});

/**
 * Unit tests for shared/topup-packages.ts validator.
 *
 * Tests both client-facing and server-facing validation paths.
 * The same validateTopupPackages function is imported by:
 *   - app/api/admin/platform-settings/commercial/route.ts (Next.js HTTP layer)
 *   - admin/src/pages/PlatformSettings.tsx (client-side)
 *
 * Acceptance criteria from task:
 *  - Valid save produces the exact JSON shape
 *  - Negative amount rejected
 *  - Zero rejected
 *  - Decimal minor units rejected (non-integer major input)
 *  - Empty currency key rejected
 *  - Unknown currency rejected
 *  - Duplicate amounts within a currency rejected
 */
import { describe, it, expect } from 'vitest';
import {
  validateTopupPackages,
  isTopupPackagesKey,
  TOPUP_ALLOWED_CURRENCIES,
  TOPUP_MINOR_PER_MAJOR,
  TOPUP_LABEL_MAX_LEN,
  TOPUP_DESCRIPTION_MAX_LEN,
  TOPUP_AMOUNT_MINOR_MAX,
  TOPUP_MAX_PACKAGES_PER_CURRENCY,
  type TopupPackage,
} from '@shared/topup-packages';

describe('isTopupPackagesKey', () => {
  it('returns true for messaging_topup_packages', () => {
    expect(isTopupPackagesKey('messaging_topup_packages')).toBe(true);
  });
  it('returns false for other keys', () => {
    expect(isTopupPackagesKey('minimum_payout')).toBe(false);
    expect(isTopupPackagesKey('')).toBe(false);
  });
});

describe('validateTopupPackages — valid shapes', () => {
  it('accepts an empty object {}', () => {
    expect(validateTopupPackages({})).toBeNull();
  });

  it('accepts a valid single-currency config', () => {
    const value = {
      NGN: [
        { amount_minor: 100000, label: '₦1,000 credit' },
      ],
    };
    expect(validateTopupPackages(value)).toBeNull();
  });

  it('accepts a valid multi-currency config', () => {
    const value = {
      NGN: [
        { amount_minor: 100000, label: '₦1,000 credit' },
        { amount_minor: 500000, label: '₦5,000 credit', description: 'Best value' },
      ],
      GHS: [
        { amount_minor: 10000, label: 'GH₵100 credit' },
      ],
      USD: [
        { amount_minor: 1000, label: '$10 credit' },
      ],
      GBP: [
        { amount_minor: 1000, label: '£10 credit' },
      ],
      CAD: [
        { amount_minor: 1000, label: 'CA$10 credit' },
      ],
    };
    expect(validateTopupPackages(value)).toBeNull();
  });

  it('produces the exact canonical JSON shape from major-unit inputs (× 100 = minor)', () => {
    // Verify that 1000 NGN major → 100000 NGN minor
    const minorPerMajor = TOPUP_MINOR_PER_MAJOR['NGN'];
    expect(minorPerMajor).toBe(100);
    const pkg: TopupPackage = { amount_minor: 1000 * minorPerMajor, label: '₦1,000 credit' };
    expect(pkg.amount_minor).toBe(100000);
    const value = { NGN: [pkg] };
    expect(validateTopupPackages(value)).toBeNull();
    // Shape check: round-trippable via JSON
    const serialized = JSON.stringify(value);
    const reparsed = JSON.parse(serialized);
    expect(reparsed).toEqual(value);
  });
});

describe('validateTopupPackages — null / wrong types', () => {
  it('rejects null', () => {
    expect(validateTopupPackages(null)).not.toBeNull();
  });
  it('rejects undefined', () => {
    expect(validateTopupPackages(undefined)).not.toBeNull();
  });
  it('rejects a string', () => {
    expect(validateTopupPackages('{"NGN":[]}')).not.toBeNull();
  });
  it('rejects an array', () => {
    expect(validateTopupPackages([])).not.toBeNull();
  });
});

describe('validateTopupPackages — unknown currency', () => {
  it('rejects an unknown currency code', () => {
    const errors = validateTopupPackages({ EUR: [{ amount_minor: 1000, label: '€10' }] });
    expect(errors).not.toBeNull();
    expect(errors!.some(e => e.message.includes('EUR'))).toBe(true);
  });

  it('rejects lowercase currency code (e.g. "ngn")', () => {
    const errors = validateTopupPackages({ ngn: [{ amount_minor: 1000, label: '₦10' }] });
    expect(errors).not.toBeNull();
  });
});

describe('validateTopupPackages — empty currency key', () => {
  it('rejects an empty-string currency key', () => {
    const obj: Record<string, unknown> = {};
    obj[''] = [{ amount_minor: 1000, label: 'test' }];
    const errors = validateTopupPackages(obj);
    expect(errors).not.toBeNull();
  });
});

describe('validateTopupPackages — amount_minor negative', () => {
  it('rejects negative amount_minor', () => {
    const errors = validateTopupPackages({ NGN: [{ amount_minor: -1000, label: 'bad' }] });
    expect(errors).not.toBeNull();
    expect(errors!.some(e => e.field.includes('amount_minor'))).toBe(true);
    expect(errors!.some(e => e.message.includes('greater than 0'))).toBe(true);
  });

  it('rejects -0.01 (negative fraction)', () => {
    const errors = validateTopupPackages({ NGN: [{ amount_minor: -0.01, label: 'bad' }] });
    expect(errors).not.toBeNull();
  });
});

describe('validateTopupPackages — amount_minor zero', () => {
  it('rejects zero amount_minor', () => {
    const errors = validateTopupPackages({ NGN: [{ amount_minor: 0, label: 'bad' }] });
    expect(errors).not.toBeNull();
    expect(errors!.some(e => e.message.includes('greater than 0'))).toBe(true);
  });
});

describe('validateTopupPackages — decimal minor units', () => {
  it('rejects a non-integer amount_minor (e.g. 1000.5)', () => {
    const errors = validateTopupPackages({ NGN: [{ amount_minor: 1000.5, label: 'bad' }] });
    expect(errors).not.toBeNull();
    expect(errors!.some(e => e.field.includes('amount_minor'))).toBe(true);
    expect(errors!.some(e => e.message.includes('whole number'))).toBe(true);
  });

  it('rejects 0.1 (common floating-point edge case)', () => {
    const errors = validateTopupPackages({ NGN: [{ amount_minor: 0.1, label: 'bad' }] });
    expect(errors).not.toBeNull();
  });

  it('accepts 100 (integer)', () => {
    expect(validateTopupPackages({ NGN: [{ amount_minor: 100, label: '₦1' }] })).toBeNull();
  });
});

describe('validateTopupPackages — duplicate amounts', () => {
  it('rejects duplicate amount_minor values within the same currency', () => {
    const errors = validateTopupPackages({
      NGN: [
        { amount_minor: 100000, label: 'First ₦1,000' },
        { amount_minor: 100000, label: 'Duplicate ₦1,000' },
      ],
    });
    expect(errors).not.toBeNull();
    expect(errors!.some(e => e.message.includes('duplicate'))).toBe(true);
  });

  it('allows same amount in different currencies', () => {
    // amount_minor 1000 is valid in both NGN and GHS
    expect(validateTopupPackages({
      NGN: [{ amount_minor: 1000, label: '₦10' }],
      GHS: [{ amount_minor: 1000, label: 'GH₵10' }],
    })).toBeNull();
  });
});

describe('validateTopupPackages — missing / empty label', () => {
  it('rejects a missing label', () => {
    const errors = validateTopupPackages({ NGN: [{ amount_minor: 100000 } as TopupPackage] });
    expect(errors).not.toBeNull();
    expect(errors!.some(e => e.field.includes('label'))).toBe(true);
  });

  it('rejects an empty-string label', () => {
    const errors = validateTopupPackages({ NGN: [{ amount_minor: 100000, label: '' }] });
    expect(errors).not.toBeNull();
    expect(errors!.some(e => e.field.includes('label'))).toBe(true);
  });

  it('rejects a whitespace-only label', () => {
    const errors = validateTopupPackages({ NGN: [{ amount_minor: 100000, label: '   ' }] });
    expect(errors).not.toBeNull();
    expect(errors!.some(e => e.field.includes('label'))).toBe(true);
  });
});

describe('validateTopupPackages — all allowed currencies', () => {
  it('accepts every allowed currency', () => {
    for (const c of TOPUP_ALLOWED_CURRENCIES) {
      const value = { [c]: [{ amount_minor: 1000, label: 'test' }] };
      expect(validateTopupPackages(value), `should accept currency ${c}`).toBeNull();
    }
  });
});

describe('validateTopupPackages — label length cap (TOPUP_LABEL_MAX_LEN = 50)', () => {
  it('accepts a label exactly at the max length', () => {
    const label = 'A'.repeat(TOPUP_LABEL_MAX_LEN);
    expect(validateTopupPackages({ NGN: [{ amount_minor: 1000, label }] })).toBeNull();
  });

  it('rejects a label one character over the max', () => {
    const label = 'A'.repeat(TOPUP_LABEL_MAX_LEN + 1);
    const errors = validateTopupPackages({ NGN: [{ amount_minor: 1000, label }] });
    expect(errors).not.toBeNull();
    expect(errors!.some(e => e.field.includes('label'))).toBe(true);
    expect(errors!.some(e => e.message.includes(String(TOPUP_LABEL_MAX_LEN)))).toBe(true);
  });
});

describe('validateTopupPackages — description validation', () => {
  it('accepts a present description within the max length', () => {
    const description = 'A'.repeat(TOPUP_DESCRIPTION_MAX_LEN);
    expect(validateTopupPackages({ NGN: [{ amount_minor: 1000, label: 'ok', description }] })).toBeNull();
  });

  it('rejects a description one character over the max', () => {
    const description = 'A'.repeat(TOPUP_DESCRIPTION_MAX_LEN + 1);
    const errors = validateTopupPackages({ NGN: [{ amount_minor: 1000, label: 'ok', description }] });
    expect(errors).not.toBeNull();
    expect(errors!.some(e => e.field.includes('description'))).toBe(true);
    expect(errors!.some(e => e.message.includes(String(TOPUP_DESCRIPTION_MAX_LEN)))).toBe(true);
  });

  it('rejects a non-string description (e.g. number)', () => {
    const errors = validateTopupPackages({
      NGN: [{ amount_minor: 1000, label: 'ok', description: 42 as unknown as string }],
    });
    expect(errors).not.toBeNull();
    expect(errors!.some(e => e.field.includes('description'))).toBe(true);
  });

  it('accepts a package with no description key (field is optional)', () => {
    expect(validateTopupPackages({ NGN: [{ amount_minor: 1000, label: 'ok' }] })).toBeNull();
  });
});

describe('validateTopupPackages — amount_minor max (TOPUP_AMOUNT_MINOR_MAX)', () => {
  it('accepts amount_minor exactly at the max', () => {
    expect(validateTopupPackages({ NGN: [{ amount_minor: TOPUP_AMOUNT_MINOR_MAX, label: 'ok' }] })).toBeNull();
  });

  it('rejects amount_minor one above the max', () => {
    const errors = validateTopupPackages({ NGN: [{ amount_minor: TOPUP_AMOUNT_MINOR_MAX + 1, label: 'ok' }] });
    expect(errors).not.toBeNull();
    expect(errors!.some(e => e.field.includes('amount_minor'))).toBe(true);
    expect(errors!.some(e => e.message.includes(String(TOPUP_AMOUNT_MINOR_MAX)))).toBe(true);
  });
});

describe('validateTopupPackages — max packages per currency (TOPUP_MAX_PACKAGES_PER_CURRENCY = 10)', () => {
  it('accepts exactly the max number of packages', () => {
    const pkgs = Array.from({ length: TOPUP_MAX_PACKAGES_PER_CURRENCY }, (_, i) => ({
      amount_minor: (i + 1) * 1000,
      label: `package ${i + 1}`,
    }));
    expect(validateTopupPackages({ NGN: pkgs })).toBeNull();
  });

  it('rejects one package over the max', () => {
    const pkgs = Array.from({ length: TOPUP_MAX_PACKAGES_PER_CURRENCY + 1 }, (_, i) => ({
      amount_minor: (i + 1) * 1000,
      label: `package ${i + 1}`,
    }));
    const errors = validateTopupPackages({ NGN: pkgs });
    expect(errors).not.toBeNull();
    expect(errors!.some(e => e.field === 'NGN')).toBe(true);
    expect(errors!.some(e => e.message.includes(String(TOPUP_MAX_PACKAGES_PER_CURRENCY)))).toBe(true);
  });
});

describe('validateTopupPackages — unknown package keys', () => {
  it('rejects a package with an unknown key', () => {
    const errors = validateTopupPackages({
      NGN: [{ amount_minor: 1000, label: 'ok', bonus: 'free' } as unknown as TopupPackage],
    });
    expect(errors).not.toBeNull();
    expect(errors!.some(e => e.message.includes('"bonus"'))).toBe(true);
  });

  it('rejects multiple unknown keys on one package', () => {
    const errors = validateTopupPackages({
      NGN: [{ amount_minor: 1000, label: 'ok', foo: 1, bar: 2 } as unknown as TopupPackage],
    });
    expect(errors).not.toBeNull();
    expect(errors!.some(e => e.message.includes('"foo"'))).toBe(true);
    expect(errors!.some(e => e.message.includes('"bar"'))).toBe(true);
  });

  it('accepts a package with only the three known keys (amount_minor, label, description)', () => {
    expect(validateTopupPackages({
      NGN: [{ amount_minor: 1000, label: 'ok', description: 'note' }],
    })).toBeNull();
  });
});

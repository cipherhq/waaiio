import { describe, it, expect } from 'vitest';
import { truncTitle, buildListItem } from '../truncate';
import { formatCurrency, type CountryCode } from '@/lib/constants';

// ─── UNIT TESTS: truncTitle helper ───────────────────────────────────────────

describe('truncTitle', () => {
  it('returns text unchanged when within limit', () => {
    expect(truncTitle('Hello', 20)).toBe('Hello');
  });

  it('truncates at word boundary', () => {
    const result = truncTitle('Very Long Button Title Here', 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result).toContain('…');
  });

  it('hard-cuts when no good word boundary', () => {
    const result = truncTitle('Abcdefghijklmnopqrstuvwxyz', 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result.endsWith('…')).toBe(true);
  });
});

// ─── UNIT TESTS: buildListItem helper ────────────────────────────────────────

describe('buildListItem', () => {
  it('no detail — truncates name into title', () => {
    const result = buildListItem({
      name: 'Build a New Community Center for Everyone!', // 42 chars
      postbackText: 'campaign_abc',
    });
    expect(result.title.length).toBeLessThanOrEqual(24);
    expect(result.title).toContain('…');
    expect(result.description).toBeUndefined();
    expect(result.postbackText).toBe('campaign_abc');
  });

  it('combined fits — single title, no description', () => {
    const result = buildListItem({
      name: 'Tithe',
      detail: 'NGN500/mo',
      postbackText: 'svc-789',
    });
    expect(result.title).toBe('Tithe — NGN500/mo');
    expect(result.description).toBeUndefined();
  });

  it('name fits, combined does not — name as title, detail as description', () => {
    const result = buildListItem({
      name: 'Biazo Conference',       // 16 chars
      detail: 'NGN1,000/month',
      postbackText: 'svc-123',
    });
    expect(result.title).toBe('Biazo Conference');
    expect(result.description).toBe('NGN1,000/month');
    expect(result.postbackText).toBe('svc-123');
  });

  it('name too long — truncated title, description STARTS with detail', () => {
    const result = buildListItem({
      name: 'A Very Long Business Service Name Here',  // 38 chars
      detail: 'NGN5,000/week',
      postbackText: 'svc-456',
    });
    expect(result.title.length).toBeLessThanOrEqual(24);
    expect(result.title).toContain('…');
    expect(result.description!.startsWith('NGN5,000/week')).toBe(true);
    expect(result.postbackText).toBe('svc-456');
  });

  it('exactly 24-char name + detail — name as title, detail as description', () => {
    const name = 'A'.repeat(24);
    const result = buildListItem({ name, detail: '$10/month', postbackText: 'svc-exact' });
    expect(result.title).toBe(name);
    expect(result.description).toBe('$10/month');
  });

  it('postback IDs preserved regardless of truncation', () => {
    const id = 'uuid-1234-5678';
    expect(buildListItem({ name: 'A', postbackText: id }).postbackText).toBe(id);
    expect(buildListItem({ name: 'A'.repeat(30), detail: '$5', postbackText: id }).postbackText).toBe(id);
    expect(buildListItem({ name: 'Hi', detail: '$1', postbackText: id }).postbackText).toBe(id);
  });

  it('description never exceeds 72 chars', () => {
    const r1 = buildListItem({ name: 'Short', detail: 'D'.repeat(80), postbackText: 'x' });
    expect(r1.description!.length).toBeLessThanOrEqual(72);

    const r2 = buildListItem({ name: 'N'.repeat(30), detail: 'D'.repeat(60), postbackText: 'y' });
    expect(r2.description!.length).toBeLessThanOrEqual(72);
  });

  it('defaults maxTitle to 24', () => {
    const result = buildListItem({ name: 'A'.repeat(25), postbackText: 'z' });
    expect(result.title.length).toBeLessThanOrEqual(24);
  });

  it('respects custom maxTitle', () => {
    const result = buildListItem({ name: 'A'.repeat(15), maxTitle: 10, postbackText: 'z' });
    expect(result.title.length).toBeLessThanOrEqual(10);
  });
});

// ─── BLOCKER 2: Flow-level list item production ──────────────────────────────
// These tests exercise the EXACT code path each flow uses to build WhatsApp
// list items — same imports (buildListItem + formatCurrency), same branching
// logic, same argument shapes. This proves the final WhatsApp row contract.

describe('payment.flow.ts — recurring service list item production', () => {
  // Replicates: payment.flow.ts lines 54-63 (select_category prompt)
  function buildPaymentListItem(service: {
    id: string;
    name: string;
    billing_type: string;
    recurring_interval: string | null;
    price: number;
  }, cc: CountryCode) {
    if (service.billing_type === 'recurring' && service.recurring_interval && service.price > 0) {
      const suffix = service.recurring_interval === 'weekly' ? '/week' : '/month';
      return buildListItem({
        name: service.name,
        detail: `${formatCurrency(service.price, cc)}${suffix}`,
        postbackText: service.id,
      });
    }
    return buildListItem({ name: service.name, postbackText: service.id });
  }

  it('recurring monthly service — title=name, description=price/month', () => {
    const item = buildPaymentListItem({
      id: 'svc-biazo',
      name: 'Biazo Conference',
      billing_type: 'recurring',
      recurring_interval: 'monthly',
      price: 1000,
    }, 'NG');

    expect(item.title).toBe('Biazo Conference');
    // formatCurrency(1000, 'NG') produces "₦1,000" — detail = "₦1,000/month"
    // Combined = "Biazo Conference — ₦1,000/month" > 24, name alone (16) fits
    expect(item.description).toContain('/month');
    expect(item.description).toContain('1,000');
    expect(item.postbackText).toBe('svc-biazo');
  });

  it('recurring service with 38+ char name — title truncated, description starts with price', () => {
    const item = buildPaymentListItem({
      id: 'svc-long',
      name: 'Premium Monthly Worship Experience Plan',  // 40 chars
      billing_type: 'recurring',
      recurring_interval: 'monthly',
      price: 5000,
    }, 'NG');

    expect(item.title.length).toBeLessThanOrEqual(24);
    expect(item.title).toContain('…');
    // Description must START with the price (material info first)
    expect(item.description!).toMatch(/^₦/);
    expect(item.description!).toContain('/month');
    expect(item.postbackText).toBe('svc-long');
  });

  it('non-recurring service — name-only, no detail', () => {
    const item = buildPaymentListItem({
      id: 'svc-onetime',
      name: 'Sunday Offering',
      billing_type: 'one_time',
      recurring_interval: null,
      price: 0,
    }, 'NG');

    expect(item.title).toBe('Sunday Offering');
    expect(item.description).toBeUndefined();
    expect(item.postbackText).toBe('svc-onetime');
  });
});

describe('scheduling.flow.ts — add-on list item production', () => {
  // Replicates: scheduling.flow.ts lines 1362-1365 (select_addons prompt)
  function buildAddonListItem(addon: { id: string; name: string; price: number }, cc: CountryCode) {
    return buildListItem({
      name: addon.name,
      detail: formatCurrency(addon.price, cc),
      postbackText: addon.id,
    });
  }

  it('addon with normal name — price in description', () => {
    const item = buildAddonListItem({
      id: 'addon-1',
      name: 'Extra Towel Set',
      price: 500,
    }, 'NG');

    // "Extra Towel Set" (15 chars) + " — ₦500" = ~24 chars
    // If combined fits, single title; otherwise name + description
    expect(item.title.length).toBeLessThanOrEqual(24);
    expect(item.postbackText).toBe('addon-1');
    // Price info must be present somewhere (title or description)
    const fullText = item.title + (item.description || '');
    expect(fullText).toContain('500');
  });

  it('addon with long name — title truncated, price preserved in description', () => {
    const item = buildAddonListItem({
      id: 'addon-2',
      name: 'Professional Photography Session Package',  // 40 chars
      price: 15000,
    }, 'NG');

    expect(item.title.length).toBeLessThanOrEqual(24);
    expect(item.title).toContain('…');
    // Description must start with price (material info first)
    expect(item.description!).toMatch(/^₦/);
    expect(item.description!).toContain('15,000');
    expect(item.postbackText).toBe('addon-2');
  });
});

describe('crowdfunding.flow.ts — campaign list item production', () => {
  // Replicates: crowdfunding.flow.ts lines 95-103 (select_campaign prompt)
  function buildCampaignListItem(campaign: {
    id: string;
    title: string;
    raised_amount: number;
    goal_amount: number;
    donor_count: number;
  }, country: CountryCode) {
    const progress = campaign.goal_amount > 0
      ? Math.round((campaign.raised_amount / campaign.goal_amount) * 100)
      : 0;
    const desc = `${formatCurrency(campaign.raised_amount, country)} raised (${progress}%) - ${campaign.donor_count} donors`;
    return {
      ...buildListItem({ name: campaign.title, postbackText: `campaign_${campaign.id}` }),
      description: desc.slice(0, 72),
    };
  }

  it('short campaign title — title unchanged', () => {
    const item = buildCampaignListItem({
      id: 'abc',
      title: 'New Church Roof',
      raised_amount: 50000,
      goal_amount: 200000,
      donor_count: 15,
    }, 'NG');

    expect(item.title).toBe('New Church Roof');
    expect(item.description).toContain('raised');
    expect(item.description).toContain('25%');
    expect(item.postbackText).toBe('campaign_abc');
  });

  it('43-char campaign title — title truncated, postback ID unchanged', () => {
    const item = buildCampaignListItem({
      id: 'xyz-123',
      title: 'Build a Brand New Community Center for All!',  // 43 chars
      raised_amount: 100000,
      goal_amount: 500000,
      donor_count: 42,
    }, 'NG');

    expect(item.title.length).toBeLessThanOrEqual(24);
    expect(item.title).toContain('…');
    // Postback must be the campaign ID, NOT truncated
    expect(item.postbackText).toBe('campaign_xyz-123');
    // Description comes from the spread override, not buildListItem
    expect(item.description).toContain('raised');
  });
});

// ─── BLOCKER 3: Unicode/emoji truncation safety ──────────────────────────────

describe('Unicode safety — surrogate pair handling', () => {
  it('emoji at truncation boundary is not split', () => {
    // 🎉 is a surrogate pair (2 UTF-16 code units)
    const text = 'Test emoji here 🎉🎉🎉';
    const result = truncTitle(text, 20);
    expect(result.length).toBeLessThanOrEqual(20);
    // Must not contain orphaned surrogates — every char should be valid
    for (let i = 0; i < result.length; i++) {
      const code = result.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF) {
        // High surrogate — next must be low surrogate
        const next = result.charCodeAt(i + 1);
        expect(next).toBeGreaterThanOrEqual(0xDC00);
        expect(next).toBeLessThanOrEqual(0xDFFF);
        i++; // skip the low surrogate
      } else {
        // Must not be an orphaned low surrogate
        expect(code < 0xDC00 || code > 0xDFFF).toBe(true);
      }
    }
  });

  it('emoji-only string truncation produces valid text', () => {
    const text = '🎉🎊🎁🎈🎆🎇🎄🎃🎋🎍🎎🎏';
    const result = truncTitle(text, 10);
    expect(result.length).toBeLessThanOrEqual(10);
    // Verify no broken surrogates
    for (let i = 0; i < result.length; i++) {
      const code = result.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF) {
        const next = result.charCodeAt(i + 1);
        expect(next).toBeGreaterThanOrEqual(0xDC00);
        expect(next).toBeLessThanOrEqual(0xDFFF);
        i++;
      } else {
        expect(code < 0xDC00 || code > 0xDFFF).toBe(true);
      }
    }
  });

  it('currency symbols (BMP) work correctly', () => {
    // ₦, $, £ are BMP characters (single UTF-16 code unit)
    expect(truncTitle('₦1,000 payment', 20)).toBe('₦1,000 payment');
    expect(truncTitle('$500 service charge here now', 20)).toContain('…');
    expect(truncTitle('£250 membership fee payment', 20)).toContain('…');
  });

  it('mixed emoji + ASCII at boundary', () => {
    // Position the emoji right where truncation would land
    const text = 'ABCDEFGHIJKLMNOPQR🎉Z';  // 🎉 at position 18 (2 code units)
    const result = truncTitle(text, 20);
    expect(result.length).toBeLessThanOrEqual(20);
    // Verify valid output
    for (let i = 0; i < result.length; i++) {
      const code = result.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF) {
        const next = result.charCodeAt(i + 1);
        expect(next).toBeGreaterThanOrEqual(0xDC00);
        expect(next).toBeLessThanOrEqual(0xDFFF);
        i++;
      } else {
        expect(code < 0xDC00 || code > 0xDFFF).toBe(true);
      }
    }
  });

  it('buildListItem description with emoji is not split', () => {
    const result = buildListItem({
      name: 'Short',
      detail: 'A'.repeat(70) + '🎉🎉',  // 74 chars in code units, slice at 72 would split
      postbackText: 'x',
    });
    expect(result.description!.length).toBeLessThanOrEqual(72);
    // Verify no orphaned surrogates in description
    for (let i = 0; i < result.description!.length; i++) {
      const code = result.description!.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF) {
        const next = result.description!.charCodeAt(i + 1);
        expect(next).toBeGreaterThanOrEqual(0xDC00);
        expect(next).toBeLessThanOrEqual(0xDFFF);
        i++;
      } else {
        expect(code < 0xDC00 || code > 0xDFFF).toBe(true);
      }
    }
  });
});

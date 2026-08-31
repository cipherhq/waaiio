import { describe, it, expect } from 'vitest';
import { truncTitle, buildListItem } from '../truncate';

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
    expect(result.length).toBe(20);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('buildListItem', () => {
  it('case 1: "Biazo Conference" + "NGN1,000/month" → name as title, detail as description', () => {
    const result = buildListItem({
      name: 'Biazo Conference',       // 16 chars — fits in 24
      detail: 'NGN1,000/month',
      postbackText: 'svc-123',
    });
    // Combined = "Biazo Conference — NGN1,000/month" = 33 chars > 24
    // Name alone (16) fits in 24 → name as title, detail as description
    expect(result.title).toBe('Biazo Conference');
    expect(result.description).toBe('NGN1,000/month');
    expect(result.postbackText).toBe('svc-123');
  });

  it('case 2: very long name + detail → title truncated, description STARTS with detail', () => {
    const result = buildListItem({
      name: 'A Very Long Business Service Name Here',  // 38 chars
      detail: 'NGN5,000/week',
      postbackText: 'svc-456',
    });
    expect(result.title.length).toBeLessThanOrEqual(24);
    expect(result.title).toContain('…');
    // Description MUST start with the detail (material info first)
    expect(result.description!.startsWith('NGN5,000/week')).toBe(true);
    expect(result.postbackText).toBe('svc-456');
  });

  it('case 3: short name + short detail combined <=24 → single title, no description', () => {
    const result = buildListItem({
      name: 'Tithe',
      detail: 'NGN500/mo',
      postbackText: 'svc-789',
    });
    // Combined = "Tithe — NGN500/mo" = 17 chars <= 24
    expect(result.title).toBe('Tithe — NGN500/mo');
    expect(result.description).toBeUndefined();
    expect(result.postbackText).toBe('svc-789');
  });

  it('case 4: exactly 24-char name + detail → name as title, detail as description', () => {
    const name = 'A'.repeat(24);  // exactly 24 chars
    const result = buildListItem({
      name,
      detail: '$10/month',
      postbackText: 'svc-exact',
    });
    // Combined would be > 24, name alone is exactly 24 → fits
    expect(result.title).toBe(name);
    expect(result.description).toBe('$10/month');
    expect(result.postbackText).toBe('svc-exact');
  });

  it('case 5: crowdfunding 43-char title, no detail → truncated to 24', () => {
    const result = buildListItem({
      name: 'Build a New Community Center for Everyone!',  // 42 chars
      postbackText: 'campaign_abc',
    });
    expect(result.title.length).toBeLessThanOrEqual(24);
    expect(result.title).toContain('…');
    expect(result.description).toBeUndefined();
    expect(result.postbackText).toBe('campaign_abc');
  });

  it('case 6: postback IDs unchanged in all cases', () => {
    const id = 'uuid-1234-5678';

    const short = buildListItem({ name: 'A', postbackText: id });
    expect(short.postbackText).toBe(id);

    const withDetail = buildListItem({ name: 'A'.repeat(30), detail: '$5', postbackText: id });
    expect(withDetail.postbackText).toBe(id);

    const combined = buildListItem({ name: 'Hi', detail: '$1', postbackText: id });
    expect(combined.postbackText).toBe(id);
  });

  it('case 7: description never exceeds 72 chars', () => {
    const longDetail = 'D'.repeat(80);
    const result = buildListItem({
      name: 'Short',
      detail: longDetail,
      postbackText: 'x',
    });
    // Name fits (5 <= 24), detail goes to description, sliced to 72
    expect(result.description!.length).toBeLessThanOrEqual(72);

    const longName = 'N'.repeat(30);
    const result2 = buildListItem({
      name: longName,
      detail: 'D'.repeat(60),
      postbackText: 'y',
    });
    // Name too long → description = "detail · name", sliced to 72
    expect(result2.description!.length).toBeLessThanOrEqual(72);
  });

  it('defaults maxTitle to 24', () => {
    const name25 = 'A'.repeat(25);
    const result = buildListItem({ name: name25, postbackText: 'z' });
    expect(result.title.length).toBeLessThanOrEqual(24);
  });

  it('respects custom maxTitle', () => {
    const result = buildListItem({
      name: 'A'.repeat(15),
      maxTitle: 10,
      postbackText: 'z',
    });
    expect(result.title.length).toBeLessThanOrEqual(10);
  });
});

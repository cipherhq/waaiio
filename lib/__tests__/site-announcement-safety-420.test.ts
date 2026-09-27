import { describe, expect, it } from 'vitest';
import {
  EMPTY_SITE_ANNOUNCEMENT,
  localDateTimeInputToIso,
  resolveSiteAnnouncementCtaUrl,
  toLocalDateTimeInputValue,
  validateSiteAnnouncementConfig,
} from '@/shared/site-announcement';

describe('#420 shared site announcement safety contract', () => {
  const now = new Date('2026-09-27T20:00:00.000Z');

  it('allows incomplete drafts while disabled', () => {
    expect(validateSiteAnnouncementConfig({
      ...EMPTY_SITE_ANNOUNCEMENT,
      type: 'launch_countdown',
      enabled: false,
    }, now)).toEqual([]);
  });

  it('blocks a live countdown with no headline or target', () => {
    const errors = validateSiteAnnouncementConfig({
      ...EMPTY_SITE_ANNOUNCEMENT,
      type: 'launch_countdown',
      enabled: true,
    }, now);

    expect(errors).toContain('Headline is required before making the announcement live.');
    expect(errors).toContain('A target date/time is required before making a launch countdown live.');
  });

  it('blocks a live countdown with a past target', () => {
    const errors = validateSiteAnnouncementConfig({
      ...EMPTY_SITE_ANNOUNCEMENT,
      enabled: true,
      type: 'launch_countdown',
      headline: 'Waaiio launches soon',
      target_date: '2026-09-26T20:00:00.000Z',
    }, now);

    expect(errors).toContain('Launch countdown target must be in the future before making it live.');
  });

  it('accepts a valid future countdown', () => {
    const errors = validateSiteAnnouncementConfig({
      ...EMPTY_SITE_ANNOUNCEMENT,
      enabled: true,
      type: 'launch_countdown',
      headline: 'Waaiio launches October 11',
      message: 'Turn WhatsApp conversations into transactions.',
      target_date: '2026-10-11T16:00:00.000Z',
      cta_text: 'Get Launch Updates',
      cta_link: '/launch',
    }, now);

    expect(errors).toEqual([]);
  });

  it('requires CTA text and link together and rejects protocol-relative URLs', () => {
    expect(validateSiteAnnouncementConfig({
      ...EMPTY_SITE_ANNOUNCEMENT,
      cta_text: 'Go',
      cta_link: null,
    }, now)).toContain('CTA text and CTA link must be provided together.');

    expect(validateSiteAnnouncementConfig({
      ...EMPTY_SITE_ANNOUNCEMENT,
      cta_text: 'Go',
      cta_link: '//evil.example',
    }, now)).toContain('CTA link must start with / or https:// and cannot start with //.');
  });

  it('round-trips a stored UTC minute through a browser-local datetime-local value', () => {
    const iso = '2026-10-11T16:00:00.000Z';
    const local = toLocalDateTimeInputValue(iso);
    const roundTrip = localDateTimeInputToIso(local);

    expect(roundTrip).not.toBeNull();
    expect(new Date(roundTrip!).getTime()).toBe(new Date(iso).getTime());
  });

  it('resolves relative Test CTA links against the configured public app and leaves HTTPS links intact', () => {
    expect(resolveSiteAnnouncementCtaUrl('/launch', 'https://www.waaiio.com'))
      .toBe('https://www.waaiio.com/launch');
    expect(resolveSiteAnnouncementCtaUrl('https://example.com/path', 'https://www.waaiio.com'))
      .toBe('https://example.com/path');
    expect(() => resolveSiteAnnouncementCtaUrl('//evil.example', 'https://www.waaiio.com'))
      .toThrow('Invalid CTA link');
  });
});

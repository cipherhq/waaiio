export const SITE_ANNOUNCEMENT_TYPES = [
  'launch_countdown',
  'maintenance_notice',
  'general',
] as const;

export const SITE_ANNOUNCEMENT_STYLES = ['brand', 'warning', 'info'] as const;

export type SiteAnnouncementType = (typeof SITE_ANNOUNCEMENT_TYPES)[number];
export type SiteAnnouncementStyle = (typeof SITE_ANNOUNCEMENT_STYLES)[number];

export interface SiteAnnouncementConfig {
  enabled: boolean;
  type: SiteAnnouncementType;
  headline: string;
  message: string;
  target_date: string | null;
  cta_text: string | null;
  cta_link: string | null;
  style: SiteAnnouncementStyle;
}

export const EMPTY_SITE_ANNOUNCEMENT: SiteAnnouncementConfig = {
  enabled: false,
  type: 'general',
  headline: '',
  message: '',
  target_date: null,
  cta_text: null,
  cta_link: null,
  style: 'brand',
};

/**
 * Current behavior, deliberately unchanged by #420:
 * after a launch countdown reaches zero, the countdown disappears but the
 * announcement remains visible until an admin disables or changes it.
 */
export const SITE_ANNOUNCEMENT_EXPIRY_POLICY = 'manual_disable' as const;

export function isSafeSiteAnnouncementCtaLink(link: string): boolean {
  if (link.startsWith('//')) return false;
  return link.startsWith('/') || link.startsWith('https://');
}

export function validateSiteAnnouncementConfig(
  config: SiteAnnouncementConfig,
  now: Date = new Date(),
): string[] {
  const errors: string[] = [];
  const headline = config.headline.trim();
  const message = config.message.trim();
  const ctaText = config.cta_text?.trim() || '';
  const ctaLink = config.cta_link?.trim() || '';

  if (!SITE_ANNOUNCEMENT_TYPES.includes(config.type)) {
    errors.push('Announcement type is invalid.');
  }
  if (!SITE_ANNOUNCEMENT_STYLES.includes(config.style)) {
    errors.push('Announcement style is invalid.');
  }
  if (config.headline.length > 200) {
    errors.push('Headline must be 200 characters or fewer.');
  }
  if (config.message.length > 500) {
    errors.push('Message must be 500 characters or fewer.');
  }
  if (ctaText.length > 50) {
    errors.push('CTA text must be 50 characters or fewer.');
  }

  if ((ctaText && !ctaLink) || (!ctaText && ctaLink)) {
    errors.push('CTA text and CTA link must be provided together.');
  }
  if (ctaLink && !isSafeSiteAnnouncementCtaLink(ctaLink)) {
    errors.push('CTA link must start with / or https:// and cannot start with //.');
  }

  if (config.target_date) {
    const targetMs = new Date(config.target_date).getTime();
    if (!Number.isFinite(targetMs)) {
      errors.push('Target date/time is invalid.');
    }
  }

  if (config.enabled) {
    if (!headline) {
      errors.push('Headline is required before making the announcement live.');
    }

    // Headline is the minimum public content. Message remains optional by design.
    if (!headline && !message) {
      errors.push('Announcement content is required before making it live.');
    }

    if (config.type === 'launch_countdown') {
      if (!config.target_date) {
        errors.push('A target date/time is required before making a launch countdown live.');
      } else {
        const targetMs = new Date(config.target_date).getTime();
        if (Number.isFinite(targetMs) && targetMs <= now.getTime()) {
          errors.push('Launch countdown target must be in the future before making it live.');
        }
      }
    }
  }

  return [...new Set(errors)];
}

/**
 * Render an ISO timestamp correctly in a browser-local datetime-local control.
 * Using iso.slice(0, 16) is incorrect because it displays UTC clock fields as
 * though they were local time.
 */
export function toLocalDateTimeInputValue(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';

  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
  ].join('');
}

export function localDateTimeInputToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function getBrowserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local browser time';
  } catch {
    return 'Local browser time';
  }
}

export function resolveSiteAnnouncementCtaUrl(link: string, publicBase: string): string {
  if (!isSafeSiteAnnouncementCtaLink(link)) {
    throw new Error('Invalid CTA link');
  }
  if (link.startsWith('https://')) return link;
  return `${publicBase.replace(/\/$/, '')}${link}`;
}

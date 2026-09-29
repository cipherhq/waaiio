/**
 * Launch banner (#446) — regression tests
 *
 * Proves the shared launch helpers, SiteAnnouncement component behavior,
 * and launch banner contract without live network calls.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── Shared helpers unit tests ──

import {
  buildWhatsAppLink,
  formatPhone,
  formatLaunchDate,
  detectCountryFromTimezone,
  computeTimeLeft,
  LAUNCH_OPT_IN_MESSAGE,
} from '@/lib/launch/shared';

describe('shared launch helpers', () => {
  describe('buildWhatsAppLink', () => {
    it('builds a clean wa.me link without source suffixes (#460)', () => {
      const link = buildWhatsAppLink('2348001234567');
      expect(link).toContain('wa.me/2348001234567');
      // Must NOT contain customer-visible source attribution
      expect(decodeURIComponent(link)).not.toContain('(button)');
      expect(decodeURIComponent(link)).not.toContain('(qr)');
    });

    it('strips non-digit characters from phone', () => {
      const link = buildWhatsAppLink('+234-800-123-4567');
      expect(link).toContain('wa.me/2348001234567');
    });

    it('includes the canonical opt-in message', () => {
      const link = buildWhatsAppLink('12025551234');
      expect(decodeURIComponent(link)).toContain(LAUNCH_OPT_IN_MESSAGE);
    });

    it('includes rocket emoji for clean customer experience', () => {
      const link = buildWhatsAppLink('12025551234');
      expect(decodeURIComponent(link)).toContain('🚀');
    });
  });

  describe('formatPhone', () => {
    it('formats Nigerian numbers', () => {
      expect(formatPhone('2348001234567')).toContain('234');
    });

    it('formats US numbers', () => {
      expect(formatPhone('12025551234')).toBe('1 202 555 1234');
    });

    it('handles short numbers', () => {
      expect(formatPhone('1234')).toBe('1234');
    });
  });

  describe('formatLaunchDate', () => {
    it('formats an ISO date to month + day', () => {
      // Use noon UTC to avoid timezone-boundary issues
      const result = formatLaunchDate('2026-10-11T12:00:00Z');
      expect(result).toContain('October');
    });

    it('returns empty string for invalid date', () => {
      expect(formatLaunchDate('not-a-date')).toBe('');
    });
  });

  describe('detectCountryFromTimezone', () => {
    it('returns a string or null', () => {
      const result = detectCountryFromTimezone();
      expect(result === null || typeof result === 'string').toBe(true);
    });
  });

  describe('computeTimeLeft', () => {
    it('returns null for past dates', () => {
      expect(computeTimeLeft('2020-01-01T00:00:00Z')).toBeNull();
    });

    it('returns TimeLeft for future dates', () => {
      const future = new Date(Date.now() + 90_000_000).toISOString(); // ~1 day ahead
      const result = computeTimeLeft(future);
      expect(result).not.toBeNull();
      expect(result!.days).toBeGreaterThanOrEqual(0);
      expect(result!.hours).toBeGreaterThanOrEqual(0);
    });
  });
});

// ── SiteAnnouncement component source analysis ──

describe('SiteAnnouncement component contract', () => {
  const siteAnnouncementSrc = readFileSync(
    resolve(__dirname, '../../components/marketing/SiteAnnouncement.tsx'),
    'utf-8'
  );

  it('renders launch banner for launch_countdown type', () => {
    expect(siteAnnouncementSrc).toContain("config.type === 'launch_countdown'");
    expect(siteAnnouncementSrc).toContain('LaunchBanner');
  });

  it('renders compact announcement for non-launch types', () => {
    expect(siteAnnouncementSrc).toContain('CompactAnnouncement');
  });

  it('launch banner has a country selector', () => {
    expect(siteAnnouncementSrc).toContain('country-selector');
    expect(siteAnnouncementSrc).toContain('Choose your country');
    expect(siteAnnouncementSrc).toContain('banner-country-select');
  });

  it('auto-selection only when a valid detected country exists', () => {
    // Must call detectCountryFromTimezone and only set if match found
    expect(siteAnnouncementSrc).toContain('detectCountryFromTimezone');
    expect(siteAnnouncementSrc).toContain('match ? match.code : null');
  });

  it('no selection disables CTA and QR', () => {
    expect(siteAnnouncementSrc).toContain('cta-disabled');
    expect(siteAnnouncementSrc).toContain('qr-disabled');
    expect(siteAnnouncementSrc).toContain('Select a country above');
  });

  it('uses buildWhatsAppLink without source suffix (#460)', () => {
    expect(siteAnnouncementSrc).toContain('buildWhatsAppLink(selectedRegion.phone)');
    // Must NOT contain customer-visible source attribution
    expect(siteAnnouncementSrc).not.toContain("'button')");
    expect(siteAnnouncementSrc).not.toContain("'qr')");
  });

  it('only uses shared channel regions from /api/launch/regions', () => {
    expect(siteAnnouncementSrc).toContain('/api/launch/regions');
    // Must NOT hardcode any phone numbers
    expect(siteAnnouncementSrc).not.toMatch(/wa\.me\/\d+/);
  });

  it('does not reference dedicated channels or fallback to arbitrary numbers', () => {
    expect(siteAnnouncementSrc).not.toContain('dedicated');
    expect(siteAnnouncementSrc).not.toContain('channel_type');
    // No hardcoded phone numbers
    expect(siteAnnouncementSrc).not.toMatch(/\+234\d{10}/);
    expect(siteAnnouncementSrc).not.toMatch(/\+1\d{10}/);
  });

  it('countdown uses authoritative announcement config target_date', () => {
    expect(siteAnnouncementSrc).toContain('config.target_date');
    expect(siteAnnouncementSrc).toContain('computeTimeLeft');
  });

  it('has QRCodeSVG for QR rendering', () => {
    expect(siteAnnouncementSrc).toContain('QRCodeSVG');
    expect(siteAnnouncementSrc).toContain('qrcode.react');
  });

  it('has whatsapp-button test ID', () => {
    expect(siteAnnouncementSrc).toContain('whatsapp-button');
  });

  it('renders launch-banner test ID for launch countdown', () => {
    expect(siteAnnouncementSrc).toContain('launch-banner');
  });

  it('renders compact-announcement test ID for non-launch types', () => {
    expect(siteAnnouncementSrc).toContain('compact-announcement');
  });

  it('is responsive with no hardcoded widths that could overflow', () => {
    // Must use responsive classes (flex-col on mobile, flex-row on desktop)
    expect(siteAnnouncementSrc).toContain('flex-col');
    expect(siteAnnouncementSrc).toContain('lg:flex-row');
    // Must use max-w constraint
    expect(siteAnnouncementSrc).toContain('max-w-');
    // Country selector must be constrained
    expect(siteAnnouncementSrc).toContain('max-w-xs');
  });
});

// ── LaunchClient still uses shared helpers ──

describe('LaunchClient /launch page uses shared helpers', () => {
  const launchClientSrc = readFileSync(
    resolve(__dirname, '../../app/(marketing)/launch/LaunchClient.tsx'),
    'utf-8'
  );

  it('imports from shared helpers', () => {
    expect(launchClientSrc).toContain('@/lib/launch/shared');
  });

  it('uses buildWhatsAppLink from shared', () => {
    expect(launchClientSrc).toContain('buildWhatsAppLink');
  });

  it('uses formatPhone from shared', () => {
    expect(launchClientSrc).toContain('formatPhone');
  });

  it('uses detectCountryFromTimezone from shared', () => {
    expect(launchClientSrc).toContain('detectCountryFromTimezone');
  });

  it('does not duplicate helper implementations', () => {
    // Should not have local function declarations for shared helpers
    expect(launchClientSrc).not.toMatch(/^function buildWhatsAppLink/m);
    expect(launchClientSrc).not.toMatch(/^function formatPhone/m);
    expect(launchClientSrc).not.toMatch(/^function computeTimeLeft/m);
    expect(launchClientSrc).not.toMatch(/^function detectCountryFromTimezone/m);
  });

  it('still uses /api/launch/regions', () => {
    expect(launchClientSrc).toContain('/api/launch/regions');
  });

  it('still uses QRCodeSVG', () => {
    expect(launchClientSrc).toContain('QRCodeSVG');
  });
});

// ── /api/launch/regions only returns shared channels ──

describe('/api/launch/regions route contract', () => {
  const regionsSrc = readFileSync(
    resolve(__dirname, '../../app/api/launch/regions/route.ts'),
    'utf-8'
  );

  it('only queries shared channels', () => {
    expect(regionsSrc).toContain("'shared'");
    expect(regionsSrc).toContain("eq('channel_type', 'shared')");
  });

  it('only queries active channels', () => {
    expect(regionsSrc).toContain("eq('is_active', true)");
  });

  it('does not return dedicated channels', () => {
    expect(regionsSrc).not.toContain("'dedicated'");
  });
});

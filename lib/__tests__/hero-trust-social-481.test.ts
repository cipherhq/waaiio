/**
 * #481 — Hero trust marks + footer @waaiiobot social links
 *
 * QR fallback tests are already on main via PR #484.
 * This file covers only the incremental #487 scope.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const HOME_CLIENT = readFileSync(join(process.cwd(), 'app/(marketing)/HomeClient.tsx'), 'utf-8');
const FOOTER = readFileSync(join(process.cwd(), 'components/marketing/Footer.tsx'), 'utf-8');

describe('Hero trust marks (#481)', () => {
  it('hero contains "Built on WhatsApp" text', () => {
    expect(HOME_CLIENT).toContain('Built on WhatsApp');
  });

  it('hero contains "Meta Partner" text', () => {
    expect(HOME_CLIENT).toContain('Meta Partner');
  });

  it('hero references existing meta-business-partner.svg asset', () => {
    expect(HOME_CLIENT).toContain('meta-business-partner.svg');
  });

  it('trust marks are within hero section (before HeroAutomationFlow component)', () => {
    const trustIdx = HOME_CLIENT.indexOf('Built on WhatsApp');
    const heroFlowUsageIdx = HOME_CLIENT.indexOf('<HeroAutomationFlow');
    expect(trustIdx).toBeGreaterThan(0);
    expect(heroFlowUsageIdx).toBeGreaterThan(0);
    expect(trustIdx).toBeLessThan(heroFlowUsageIdx);
  });
});

describe('Footer social links — @waaiiobot (#481)', () => {
  it('has Instagram link for @waaiiobot', () => {
    expect(FOOTER).toContain('https://instagram.com/waaiiobot');
    expect(FOOTER).toContain('aria-label="Instagram @waaiiobot"');
  });

  it('has TikTok link for @waaiiobot', () => {
    expect(FOOTER).toContain('https://tiktok.com/@waaiiobot');
    expect(FOOTER).toContain('aria-label="TikTok @waaiiobot"');
  });

  it('has X link for @waaiiobot (not @waaiio)', () => {
    expect(FOOTER).toContain('https://x.com/waaiiobot');
    expect(FOOTER).toContain('aria-label="X @waaiiobot"');
    expect(FOOTER).not.toContain('https://x.com/waaiio"');
  });

  it('social links use safe external-link behavior', () => {
    const socialLinks = FOOTER.match(/href="https:\/\/(instagram|tiktok|x)\.com[^"]*"[^>]*/g) || [];
    expect(socialLinks.length).toBeGreaterThanOrEqual(3);
    for (const link of socialLinks) {
      expect(link).toContain('target="_blank"');
      expect(link).toContain('rel="noopener noreferrer"');
    }
  });

  it('retains existing WhatsApp and LinkedIn links', () => {
    expect(FOOTER).toContain('wa.me/12029226251');
    expect(FOOTER).toContain('linkedin.com/company/waaiio');
  });
});

describe('#484 QR fallback behavior preserved on current main', () => {
  const SITE_ANNOUNCEMENT = readFileSync(join(process.cwd(), 'components/marketing/SiteAnnouncement.tsx'), 'utf-8');

  it('SiteAnnouncement uses fallback pattern (merged via #484)', () => {
    expect(SITE_ANNOUNCEMENT).toMatch(/setSelectedCode\(match\?\.code\s*\|\|\s*list\[0\]\?\.code/);
    expect(SITE_ANNOUNCEMENT).not.toMatch(/setSelectedCode\(match\s*\?\s*match\.code\s*:\s*null\)/);
  });
});

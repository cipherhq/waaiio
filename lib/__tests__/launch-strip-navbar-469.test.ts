/**
 * #469 — Launch strip / navbar stacking + Meta Partner trust badge tests.
 *
 * Covers:
 * 1. Launch strip uses fixed positioning with z-50 (above navbar z-40)
 * 2. Navbar uses CSS custom property --announcement-h for top offset
 * 3. Get notified button is present and clickable
 * 4. /launch still suppresses launch strip
 * 5. Dismiss resets --announcement-h to 0px
 * 6. Meta Partner asset renders on homepage trust section
 * 7. Existing marketing structure preserved
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const siteAnnouncementSource = readFileSync(
  resolve(__dirname, '../../components/marketing/SiteAnnouncement.tsx'),
  'utf-8'
);

const navbarSource = readFileSync(
  resolve(__dirname, '../../components/marketing/Navbar.tsx'),
  'utf-8'
);

const homeClientSource = readFileSync(
  resolve(__dirname, '../../app/(marketing)/HomeClient.tsx'),
  'utf-8'
);

const layoutSource = readFileSync(
  resolve(__dirname, '../../app/(marketing)/layout.tsx'),
  'utf-8'
);

describe('#469 Launch strip + navbar stacking', () => {
  it('launch strip uses fixed positioning at top-0 with z-50', () => {
    expect(siteAnnouncementSource).toContain('data-testid="launch-strip"');
    expect(siteAnnouncementSource).toContain('fixed left-0 right-0 top-0 z-50');
  });

  it('launch strip measures height and sets --announcement-h CSS custom property', () => {
    expect(siteAnnouncementSource).toContain('--announcement-h');
    expect(siteAnnouncementSource).toContain('offsetHeight');
    expect(siteAnnouncementSource).toContain("style.setProperty('--announcement-h'");
  });

  it('navbar uses --announcement-h for top offset instead of hardcoded top-0', () => {
    expect(navbarSource).toContain("top: 'var(--announcement-h, 0px)'");
    const headerClassLine = navbarSource.split('\n').find(l =>
      l.includes('className') && l.includes('fixed') && l.includes('z-40')
    );
    expect(headerClassLine).toBeDefined();
    expect(headerClassLine).not.toContain('top-0');
  });

  it('homepage reserves the measured announcement height so navbar logo cannot overlap hero content', () => {
    expect(navbarSource).toContain('{isHeroPage && (');
    expect(navbarSource).toContain("height: 'var(--announcement-h, 0px)'");

    const headerEnd = navbarSource.indexOf('</header>');
    const reservedHeight = navbarSource.indexOf("height: 'var(--announcement-h, 0px)'");
    const mobileMenu = navbarSource.indexOf('<MobileMenu');

    expect(headerEnd).toBeGreaterThan(-1);
    expect(reservedHeight).toBeGreaterThan(headerEnd);
    expect(mobileMenu).toBeGreaterThan(reservedHeight);
  });

  it('Get notified button is present in launch strip', () => {
    expect(siteAnnouncementSource).toContain('Get notified');
    expect(siteAnnouncementSource).toContain('onClick={onOpenModal}');
  });

  it('dismiss handler resets --announcement-h to 0px', () => {
    expect(siteAnnouncementSource).toContain("setProperty('--announcement-h', '0px')");
    expect(siteAnnouncementSource).toContain('setDismissed(true)');
  });

  it('cleanup on unmount resets --announcement-h to 0px', () => {
    const cleanupPattern = /return\s*\(\)\s*=>\s*\{[^}]*--announcement-h[^}]*0px/;
    expect(siteAnnouncementSource).toMatch(cleanupPattern);
  });
});

describe('#469 /launch suppression preserved', () => {
  it('SiteAnnouncement suppresses on /launch page', () => {
    expect(siteAnnouncementSource).toContain("pathname === '/launch'");
    expect(siteAnnouncementSource).toContain('return null');
  });

  it('session modal behavior preserved (MODAL_SHOWN_KEY)', () => {
    expect(siteAnnouncementSource).toContain('MODAL_SHOWN_KEY');
    expect(siteAnnouncementSource).toContain('sessionStorage');
  });
});

describe('#469 Meta Partner trust badge', () => {
  it('homepage trust section includes Meta Partner badge with official SVG', () => {
    expect(homeClientSource).toContain('meta-business-partner.svg');
    expect(homeClientSource).toContain('alt="Meta Business Partner"');
    expect(homeClientSource).toContain('data-testid="meta-partner-badge"');
  });

  it('trust section still includes WhatsApp, Stripe, and Paystack', () => {
    expect(homeClientSource).toContain('Built on WhatsApp Business Platform');
    expect(homeClientSource).toContain('Stripe');
    expect(homeClientSource).toContain('Paystack');
  });

  it('meta partner SVG asset exists in public directory', () => {
    const fs = require('fs');
    const exists = fs.existsSync(resolve(__dirname, '../../public/meta-business-partner.svg'));
    expect(exists).toBe(true);
  });
});

describe('#469 Layout structure preserved', () => {
  it('SiteAnnouncement renders before Navbar in layout', () => {
    const announcementIdx = layoutSource.indexOf('SiteAnnouncement');
    const navbarIdx = layoutSource.indexOf('<Navbar');
    expect(announcementIdx).toBeGreaterThan(-1);
    expect(navbarIdx).toBeGreaterThan(-1);
    expect(announcementIdx).toBeLessThan(navbarIdx);
  });

  it('no horizontal overflow utility on main content', () => {
    expect(layoutSource).toContain("overflowX: 'clip'");
  });
});

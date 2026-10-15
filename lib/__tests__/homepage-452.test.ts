/**
 * Homepage simplification (#452) — regression tests
 *
 * Proves removed claims, accurate provider wording, correct launch authority,
 * and structural integrity of the simplified homepage.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const homeClientSrc = readFileSync(
  resolve(__dirname, '../../app/(marketing)/HomeClient.tsx'),
  'utf-8'
);

const pageSrc = readFileSync(
  resolve(__dirname, '../../app/(marketing)/page.tsx'),
  'utf-8'
);

const navbarSrc = readFileSync(
  resolve(__dirname, '../../components/marketing/Navbar.tsx'),
  'utf-8'
);

const mobileMenuSrc = readFileSync(
  resolve(__dirname, '../../components/marketing/MobileMenu.tsx'),
  'utf-8'
);

describe('#452 homepage simplification — removed claims', () => {
  it('does not contain unsupported statistics', () => {
    // All unsourced problem-section stats must be removed
    expect(homeClientSrc).not.toContain('40%');
    expect(homeClientSrc).not.toContain('67%');
    expect(homeClientSrc).not.toContain('60%');
    expect(homeClientSrc).not.toContain("30%");
    // '3x' as a stat claim (not CSS like text-3xl)
    expect(homeClientSrc).not.toMatch(/['"]3x['"]/);
    expect(homeClientSrc).not.toContain('5hrs');
  });

  it('does not contain fabricated testimonials', () => {
    expect(homeClientSrc).not.toContain('TestimonialCard');
    expect(homeClientSrc).not.toContain('Pastor Grace');
    expect(homeClientSrc).not.toContain('Adebayo O.');
    expect(homeClientSrc).not.toContain('Chioma N.');
    expect(homeClientSrc).not.toContain("King's Cuts");
    expect(homeClientSrc).not.toContain('What our users say');
  });

  it('does not contain inflated quantity claims', () => {
    expect(homeClientSrc).not.toContain('89+');
    expect(homeClientSrc).not.toContain('30 Capabilities');
    expect(homeClientSrc).not.toContain('thousands');
    expect(homeClientSrc).not.toContain('Join thousands');
  });

  it('does not contain unsupported Meta partnership wording beyond official badge', () => {
    const combined = homeClientSrc + pageSrc;
    // #469: Official meta-business-partner.svg badge restored with factual alt text.
    // Fabricated stronger partnership wording is still blocked.
    expect(combined).not.toContain('Official Technology Partner');
    expect(combined).not.toContain('Meta Verified Technology Provider');
    // The official badge + factual alt text "Meta Business Partner" are approved (#469).
    expect(homeClientSrc).toContain('meta-business-partner.svg');
    expect(homeClientSrc).toContain('alt="Meta Business Partner"');
  });

  it('JSON-LD does not claim unverified awards or memberships', () => {
    expect(pageSrc).not.toContain('"award"');
    expect(pageSrc).not.toContain('"memberOf"');
    expect(pageSrc).not.toContain('Meta Business Partners');
    expect(pageSrc).not.toContain('Meta Verified Tech Provider');
  });
});

describe('#452 homepage simplification — provider truth', () => {
  it('homepage shows only Stripe and Paystack as payment providers', () => {
    expect(homeClientSrc).toContain('Stripe');
    expect(homeClientSrc).toContain('Paystack');
  });

  it('homepage does not show Square, Flutterwave, or PayPal', () => {
    expect(homeClientSrc).not.toContain('Square');
    expect(homeClientSrc).not.toContain('Flutterwave');
    expect(homeClientSrc).not.toContain('PayPal');
  });

  it('FAQ only mentions Stripe and Paystack', () => {
    expect(pageSrc).toContain('Stripe');
    expect(pageSrc).toContain('Paystack');
    expect(pageSrc).not.toContain('Square');
    expect(pageSrc).not.toContain('Flutterwave');
    expect(pageSrc).not.toContain('PayPal');
  });
});

describe('#452 homepage simplification — pricing and trial', () => {
  it('pricing uses getPricingTiers (not hardcoded values)', () => {
    expect(homeClientSrc).toContain('getPricingTiers');
    expect(homeClientSrc).toContain('formatCurrency');
  });

  it('does not introduce hardcoded specific trial duration claim', () => {
    expect(homeClientSrc).not.toMatch(/30.day.*trial/i);
    expect(homeClientSrc).not.toMatch(/14.day.*trial/i);
    expect(pageSrc).not.toMatch(/30.day.*trial/i);
    expect(pageSrc).not.toMatch(/14.day.*trial/i);
  });
});

describe('#452 homepage simplification — launch authority', () => {
  it('does not hardcode a launch date', () => {
    const combined = homeClientSrc + pageSrc;
    expect(combined).not.toContain('October 11');
    expect(combined).not.toContain('2026-10-11');
    expect(combined).not.toContain('Oct 11');
  });

  it('does not hardcode arbitrary WhatsApp numbers', () => {
    expect(homeClientSrc).not.toContain('12029226251');
    expect(homeClientSrc).not.toMatch(/wa\.me\/\d+/);
  });

  it('does not read raw platform_settings directly', () => {
    expect(pageSrc).not.toContain("from('platform_settings')");
    expect(homeClientSrc).not.toContain("from('platform_settings')");
  });

  it('preserves existing launch config authority (SiteAnnouncement in layout)', () => {
    const layoutSrc = readFileSync(
      resolve(__dirname, '../../app/(marketing)/layout.tsx'),
      'utf-8'
    );
    expect(layoutSrc).toContain('SiteAnnouncement');
  });
});

describe('#452 homepage simplification — structural integrity', () => {
  it('homepage renders LiveBotDemo', () => {
    expect(homeClientSrc).toContain('LiveBotDemo');
  });

  it('homepage renders HeroAutomationFlow', () => {
    expect(homeClientSrc).toContain('HeroAutomationFlow');
  });

  it('homepage has approved hero headline', () => {
    expect(homeClientSrc).toContain('Your business,');
    expect(homeClientSrc).toContain('running on');
    expect(homeClientSrc).toContain('WhatsApp');
  });

  it('homepage retains "Just message. It understands." badge', () => {
    expect(homeClientSrc).toContain('Just message. It understands.');
  });

  it('homepage has compact 5-capability summary', () => {
    expect(homeClientSrc).toContain('Book');
    expect(homeClientSrc).toContain('Order');
    expect(homeClientSrc).toContain('Pay');
    expect(homeClientSrc).toContain('Sell Tickets');
    expect(homeClientSrc).toContain('Follow Up');
  });

  it('homepage links to /features for depth', () => {
    expect(homeClientSrc).toContain('/features');
    expect(homeClientSrc).toContain('See all features');
  });

  it('homepage has pricing section with country selector', () => {
    expect(homeClientSrc).toContain('PRICE_COUNTRIES');
    expect(homeClientSrc).toContain('setPriceCountry');
  });

  it('FAQ count is reduced (4-5 questions)', () => {
    const faqMatches = pageSrc.match(/question:/g);
    expect(faqMatches).not.toBeNull();
    expect(faqMatches!.length).toBeGreaterThanOrEqual(3);
    expect(faqMatches!.length).toBeLessThanOrEqual(5);
  });

  it('visible FAQ and JSON-LD FAQ are synchronized', () => {
    // Both use the same FAQ_DATA
    expect(pageSrc).toContain('FAQ_DATA.map');
    expect(pageSrc).toContain("'@type': 'FAQPage'");
    // FAQ_DATA is used for both JSON-LD and passed to HomeClient
    expect(pageSrc).toContain('faqData={FAQ_DATA}');
  });
});

describe('#452 homepage simplification — navigation CTAs', () => {
  it('navbar CTA links to /launch not /get-started', () => {
    expect(navbarSrc).not.toContain('href="/get-started"');
    expect(navbarSrc).toContain('href="/launch"');
  });

  it('mobile menu CTA links to /launch not /get-started', () => {
    expect(mobileMenuSrc).not.toContain('href="/get-started"');
    expect(mobileMenuSrc).toContain('href="/launch"');
  });

  it('homepage CTAs do not link to /get-started', () => {
    // All homepage CTAs should route to /launch or /pricing, not /get-started
    expect(homeClientSrc).not.toContain('href="/get-started"');
  });
});

describe('#452 homepage simplification — removed sections', () => {
  it('does not contain the comparison table', () => {
    expect(homeClientSrc).not.toContain('WhatsApp Business vs');
    expect(homeClientSrc).not.toContain('Comparison');
  });

  it('does not contain the industry showcase', () => {
    expect(homeClientSrc).not.toContain('IndustryShowcase');
    expect(homeClientSrc).not.toContain('Business Types');
  });

  it('does not contain the problem/fear section', () => {
    expect(homeClientSrc).not.toContain('losing time and money');
    expect(homeClientSrc).not.toContain('The problem');
  });

  it('does not contain the 10-card capability wall', () => {
    expect(homeClientSrc).not.toContain('Cuts No-Shows');
    expect(homeClientSrc).not.toContain('Loyalty Without an App');
    expect(homeClientSrc).not.toContain('Scan to Pay');
  });

  it('does not contain "Why Waaiio" cards', () => {
    expect(homeClientSrc).not.toContain('WhyCard');
    expect(homeClientSrc).not.toContain("What WhatsApp Business can't do");
  });

  it('does not contain repeated NL examples section', () => {
    expect(homeClientSrc).not.toContain('No menus. No buttons. Just talk');
    expect(homeClientSrc).not.toContain('People already know how to use it');
  });
});

describe('#452 homepage simplification — responsive', () => {
  it('uses responsive classes for mobile layout', () => {
    expect(homeClientSrc).toContain('lg:grid-cols-');
    expect(homeClientSrc).toContain('sm:grid-cols-');
    expect(homeClientSrc).toContain('max-w-');
  });

  it('uses flexbox wrap for capability summary', () => {
    expect(homeClientSrc).toContain('flex-wrap');
  });
});

describe('#452 homepage simplification — WhatsApp platform wording', () => {
  it('uses factual "Built on WhatsApp Business Platform" wording', () => {
    expect(homeClientSrc).toContain('Built on WhatsApp Business Platform');
  });
});

describe('#452 homepage simplification — reduced motion', () => {
  it('imports useReducedMotion from framer-motion', () => {
    expect(homeClientSrc).toContain('useReducedMotion');
  });

  it('uses useReducedMotion in the component body', () => {
    // Must call useReducedMotion and use the result
    expect(homeClientSrc).toContain('useReducedMotion()');
    expect(homeClientSrc).toContain('noMotion');
  });

  it('disables parallax scroll when reduced motion is preferred', () => {
    // heroY should resolve to 0 when noMotion is true
    expect(homeClientSrc).toContain('noMotion ? 0 : 80');
  });

  it('hides scroll progress bar when reduced motion is preferred', () => {
    expect(homeClientSrc).toContain('!noMotion');
  });

  it('does not contain unused REDUCED_MOTION_CLASS constant', () => {
    expect(homeClientSrc).not.toContain('REDUCED_MOTION_CLASS');
  });

  it('PlanCard uses CSS motion-reduce instead of framer whileHover', () => {
    expect(homeClientSrc).toContain('motion-reduce:hover:translate-y-0');
  });
});

describe('#452 homepage simplification — unsupported language claims', () => {
  it('does not claim a specific unsupported language count', () => {
    const combined = homeClientSrc + pageSrc;
    expect(combined).not.toContain('7 languages');
    expect(combined).not.toMatch(/in \d+ languages/);
  });

  it('structured metadata does not advertise uncertified Pidgin', () => {
    expect(pageSrc).not.toMatch(/availableLanguage.*Pidgin/);
  });

  it('structured metadata availableLanguage contains only production-certified languages', () => {
    const match = pageSrc.match(/availableLanguage:\s*\[([^\]]+)\]/);
    expect(match).not.toBeNull();
    const languages = match![1].replace(/'/g, '').split(',').map(s => s.trim());
    // Must not contain uncertified languages
    expect(languages).not.toContain('Pidgin');
    expect(languages).not.toContain('Yoruba');
    expect(languages).not.toContain('Igbo');
    expect(languages).not.toContain('Hausa');
    expect(languages).not.toContain('Twi');
  });
});

describe('#452 homepage simplification — setup wording truth', () => {
  it('does not claim bot goes live instantly', () => {
    expect(homeClientSrc).not.toContain('goes live instantly');
  });

  it('uses evidence-backed setup wording', () => {
    expect(homeClientSrc).toContain('ready to receive messages');
  });
});

describe('#452 homepage simplification — CTA post-launch handoff (#453)', () => {
  it('navbar documents CTA must switch to /get-started when signup gate opens', () => {
    expect(navbarSrc).toContain('#453');
    expect(navbarSrc).toContain('/get-started');
  });

  it('mobile menu documents CTA must switch to /get-started when signup gate opens', () => {
    expect(mobileMenuSrc).toContain('#453');
    expect(mobileMenuSrc).toContain('/get-started');
  });
});

/**
 * #1175 F15 / S10 catalog: the planned firewall exclusions cover every
 * webhook, callback, cron, health and WhatsApp route in app/api, and no
 * limited sign-in path is a provider path. Reads the real route tree.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, statSync, existsSync } from 'fs';
import { join, relative, sep } from 'path';
import {
  FIREWALL_SIGNIN_CODE_PATHS,
  FIREWALL_SIGNIN_PAGES,
  isFirewallExcluded,
} from '@/lib/security/firewall-exclusions';

const ROOT = process.cwd();

function apiRoutes(dir = join(ROOT, 'app', 'api')): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__') continue;
      out.push(...apiRoutes(full));
    } else if (name === 'route.ts') {
      out.push('/' + relative(join(ROOT, 'app'), dir).split(sep).join('/'));
    }
  }
  return out;
}

const routes = apiRoutes();
const mustBeExcluded = routes.filter((p) =>
  /webhook|callback/i.test(p) ||
  /^\/api\/(cron|whatsapp|health)(\/|$)/.test(p),
);

describe('firewall exclusion catalog', () => {
  it('finds the provider, cron and WhatsApp routes (sanity)', () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(mustBeExcluded).toEqual(expect.arrayContaining([
      '/api/webhook/meta-cloud',
      '/api/payments/stripe-webhook',
      '/api/payments/byo-webhook/[businessId]',
      '/api/whatsapp/flow-callback',
      '/api/cron/auto-payout',
      '/api/health',
      '/api/messaging/topup/callback',
      '/api/auth/facebook/callback',
      '/api/payouts/stripe-callback',
    ]));
  });

  it.each(mustBeExcluded)('%s is excluded from every firewall rule', (path) => {
    expect(isFirewallExcluded(path)).toBe(true);
  });

  it('the payment return page is excluded', () => {
    expect(existsSync(join(ROOT, 'app', 'payment-success'))).toBe(true);
    expect(isFirewallExcluded('/payment-success')).toBe(true);
  });

  it('every limited sign-in path and page is not excluded and is not a provider path', () => {
    for (const p of [...FIREWALL_SIGNIN_CODE_PATHS, ...FIREWALL_SIGNIN_PAGES]) {
      expect(isFirewallExcluded(p)).toBe(false);
      expect(p).not.toMatch(/webhook|callback|cron|whatsapp|payment/i);
    }
  });

  it('customer checkout codes are not limited (Q6 A)', () => {
    expect(FIREWALL_SIGNIN_CODE_PATHS).not.toContain('/api/auth/email-otp');
    expect(FIREWALL_SIGNIN_CODE_PATHS).not.toContain('/api/contracts/otp/verify');
  });

  it('the listed sign-in code routes exist (the sign-in route arrives in a later slice)', () => {
    for (const p of FIREWALL_SIGNIN_CODE_PATHS) {
      if (p === '/api/auth/sign-in') continue;
      expect(routes).toContain(p);
    }
  });
});

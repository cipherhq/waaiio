/**
 * The "📎 Terms:" link in bot payment summaries must open a page that exists.
 *
 * It used to be hard-coded to https://www.waaiio.com/t/<slug>, a route that did
 * not exist, so it 404'd on every domain. It now points at app/t/[slug] on the
 * deployment's own domain (NEXT_PUBLIC_APP_URL), and all five summaries that
 * show it use one helper. Each summary prompt is run for real below.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockContext, getStep } from './helpers';
import { getBusinessTermsUrl } from '../shared/terms';
import { schedulingFlow } from '../scheduling.flow';
import { orderingFlow } from '../ordering.flow';
import { paymentFlow } from '../payment.flow';
import { reservationFlow } from '../reservation.flow';
import { ticketingFlow } from '../ticketing.flow';
import type { FlowContext, PromptMessage } from '../types';

const STAGING = 'https://staging.waaiio.com';

function body(messages: PromptMessage[]): string {
  return messages.map((m) => ('body' in m ? m.body : 'text' in m ? m.text : '')).join('\n');
}

/** Minimal Supabase stand-in: every query resolves to `rows` for products, nothing otherwise. */
function fakeSupabase(products: unknown[] = []) {
  return {
    from: (table: string) => {
      const result = { data: table === 'products' ? products : null, error: null };
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'gte', 'lte', 'order', 'limit']) {
        chain[m] = () => chain;
      }
      chain.single = async () => ({ data: null, error: null });
      chain.maybeSingle = async () => ({ data: null, error: null });
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
      return chain;
    },
    rpc: async () => ({ data: 0, error: null }),
  };
}

function ctxFor(sessionData: Record<string, unknown>, metadata: Record<string, unknown> = {}, products: unknown[] = []): FlowContext {
  return createMockContext({
    supabase: fakeSupabase(products) as any,
    session: { id: 's1', user_id: 'u1', business_id: 'b1', current_step: '', version: 0, session_data: sessionData },
    business: {
      id: 'b1',
      name: 'Test Biz',
      slug: 'testbiz',
      category: 'other' as any,
      flow_type: 'scheduling' as any,
      subscription_tier: 'starter',
      trial_ends_at: null,
      country_code: 'NG',
      metadata,
    } as any,
  });
}

const summaries: Array<{ name: string; prompt: (meta?: Record<string, unknown>) => Promise<PromptMessage[]> }> = [
  {
    name: 'scheduling booking summary',
    prompt: (meta) => getStep(schedulingFlow, 'confirmation').prompt(
      ctxFor({ date: '2026-12-01', time: '10:00', service_name: 'Table for 2', service_price: 5000, service_deposit: 0, party_size: 2 }, meta),
    ),
  },
  {
    name: 'ordering order summary',
    prompt: (meta) => getStep(orderingFlow, 'review_order_summary').prompt(
      ctxFor(
        { cart: [{ product_id: 'p1', name: 'Widget', quantity: 1, price: 5000 }], customer_name: 'Ada' },
        meta,
        [{ id: 'p1', name: 'Widget', price: 5000, stock_quantity: null, track_inventory: false, is_active: true, deleted_at: null }],
      ),
    ),
  },
  {
    name: 'payment summary',
    prompt: (meta) => getStep(paymentFlow, 'confirm_amount').prompt(ctxFor({ amount: 5000, service_name: 'Invoice 12' }, meta)),
  },
  {
    name: 'reservation summary',
    prompt: (meta) => getStep(reservationFlow, 'reservation_confirmation').prompt(
      ctxFor({ check_in: '2026-12-10', check_out: '2026-12-12', nights: 2, nightly_rate: 5000, service_name: 'Studio', guests: 1 }, meta),
    ),
  },
  {
    name: 'ticketing summary',
    prompt: (meta) => getStep(ticketingFlow, 'ticket_confirmation').prompt(
      ctxFor({ event_date: '2026-12-20', event_name: 'Launch', ticket_quantity: 1, total_amount: 5000 }, meta),
    ),
  },
];

describe('bot terms link resolves to a real page', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', STAGING);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('the /t/<slug> path is served by app/t/[slug]/page.tsx', () => {
    const route = path.resolve(__dirname, '../../../../app/t/[slug]/page.tsx');
    expect(fs.existsSync(route)).toBe(true);
    expect(new URL(getBusinessTermsUrl({ slug: 'testbiz' })).pathname).toBe('/t/testbiz');
  });

  for (const s of summaries) {
    it(`${s.name} links to this deployment's /t/<slug> page`, async () => {
      const text = body(await s.prompt());
      expect(text).toContain(`📎 Terms: ${STAGING}/t/testbiz`);
      expect(text).not.toContain('www.waaiio.com/t/');
    });

    it(`${s.name} still uses the merchant's own terms_url when set`, async () => {
      const own = ['https:', '//mybiz.example/terms'].join('');
      const text = body(await s.prompt({ terms_url: own }));
      expect(text).toContain(`📎 Terms: ${own}`);
      expect(text).not.toContain('/t/testbiz');
    });
  }
});

describe('getBusinessTermsUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to www.waaiio.com when NEXT_PUBLIC_APP_URL is unset', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    expect(getBusinessTermsUrl({ slug: 'testbiz' })).toBe('https://www.waaiio.com/t/testbiz');
  });

  it("uses Waaiio's /terms when the business has no slug", () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', STAGING);
    expect(getBusinessTermsUrl({ slug: null })).toBe(`${STAGING}/terms`);
    expect(getBusinessTermsUrl(undefined)).toBe(`${STAGING}/terms`);
  });

  it('drops a trailing slash on the app URL and encodes the slug', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', `${STAGING}/`);
    expect(getBusinessTermsUrl({ slug: 'a b' })).toBe(`${STAGING}/t/a%20b`);
  });

  it('ignores a non-string terms_url', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', STAGING);
    expect(getBusinessTermsUrl({ slug: 'testbiz', metadata: { terms_url: 42 } })).toBe(`${STAGING}/t/testbiz`);
  });
});


// This suite exercises confirmation UX with an untaxed authoritative quote.
// RPC validation and quote failures are covered by the merchant-tax suites.
vi.mock('@/lib/tax/server-quote', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tax/server-quote')>()),
  quoteBookingTax: vi.fn(async (_db, input) => ({
    total: Math.max(Number(input.expectedTerms.price || 0) * input.partySize, Number(input.expectedTerms.deposit || 0)),
    deposit: Number(input.expectedTerms.deposit || 0), tax_snapshot: null,
  })),
  quoteOrderTax: vi.fn(async (_db, input) => ({ is_preview: true, created: false,
    server_total: input.items.reduce((sum: number, item: { unit_price: number; quantity: number }) => sum + item.unit_price * item.quantity, input.shippingCost),
    server_discount: 0, server_volume_discount: 0, tax_snapshot: null,
  })),
}));

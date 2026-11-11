/**
 * Follow-up to PR #970 (Owner rule 2026-11-10): the payment-success page's
 * "Return to WhatsApp" number for a web (non-WhatsApp-origin) payment.
 *
 * Renders the real server page on an in-memory database. Staging: the
 * designated number for a business in any country, never a competing shared
 * number; a broken designated row falls back to the business phone exactly as
 * when no channel exists. Production: the same country query and result.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryDb } from './helpers/memory-db';
import {
  BROKEN_DESIGNATED, DESIGNATED_ID, allShared, channelChains, record, saveEnv, setStaging, type Recorded,
} from './helpers/staging-channels';

const H = vi.hoisted(() => ({ db: null as unknown, country: 'NG' as string | undefined }));
const BIZ = '11111111-1111-4111-8111-111111111111';
const OWNER_PHONE = '2348099999999';

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => H.db }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/ReturnToWhatsApp', () => ({ ReturnToWhatsApp: function ReturnToWhatsApp() { return null; } }));
vi.mock('@/lib/payments/reconcile', () => ({ reconcilePayment: vi.fn() }));
vi.mock('@/lib/payments/payment-success-helpers', () => ({
  reconcileAndConfirm: async () => ({ confirmed: false }),
  getConfirmationMessage: () => 'ok',
}));
vi.mock('@/lib/payments/payment-success-resolver', () => ({
  resolvePaymentFromRef: async () => ({
    path: 'test',
    payment: {
      id: 'p1', business_id: BIZ, booking_id: null, metadata: {},
      businesses: { phone: OWNER_PHONE, name: 'TestBiz', country_code: H.country, subscription_tier: 'free' },
    },
  }),
}));

type Row = Record<string, unknown>;
let restoreEnv: () => void;
beforeEach(() => { restoreEnv = saveEnv(); H.country = 'NG'; });
afterEach(() => restoreEnv());

function findPhone(node: unknown): string | undefined | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) { const p = findPhone(child); if (p !== null) return p; }
    return null;
  }
  const el = node as { type?: { name?: string }; props?: { phone?: string; children?: unknown } };
  if (el.type?.name === 'ReturnToWhatsApp') return el.props?.phone;
  return findPhone(el.props?.children);
}

async function returnPhone(rows: Row[]): Promise<{ phone: string | undefined | null; rec: Recorded }> {
  const rec = record(createMemoryDb({
    businesses: [{ id: BIZ, assigned_channel_id: null, whatsapp_channel_id: null }],
    whatsapp_channels: rows,
  }));
  H.db = rec.client;
  const { default: PaymentSuccessPage } = await import('@/app/payment-success/page');
  const tree = await PaymentSuccessPage({ searchParams: Promise.resolve({ ref: 'REF-1' }) });
  return { phone: findPhone(tree), rec };
}

describe('payment-success Return to WhatsApp (web payment, no assigned or dedicated channel)', () => {
  it.each(['NG', 'GB', 'US', 'KE', undefined])('staging: business country %s → the designated number', async (cc) => {
    setStaging(true);
    H.country = cc;
    expect((await returnPhone(allShared())).phone).toBe('12404712139');
  });
  it.each(BROKEN_DESIGNATED)('staging: designated row %s → business phone, never a competing number', async (_l, rows) => {
    setStaging(true);
    expect((await returnPhone(rows)).phone).toBe(OWNER_PHONE);
  });
  it('production: NG business → the NG shared number via the same country query as before', async () => {
    setStaging(false);
    const { phone, rec } = await returnPhone(allShared());
    expect(phone).toBe('2348000000000');
    expect(channelChains(rec)).toContainEqual([
      ['select', 'phone_number'], ['eq', 'channel_type', 'shared'], ['eq', 'country_code', 'NG'],
      ['eq', 'is_active', true], ['limit', 1], ['maybeSingle'],
    ]);
    expect(channelChains(rec).some(c => c.some(x => x[0] === 'eq' && x[1] === 'id' && x[2] === DESIGNATED_ID))).toBe(false);
  });
  it('production: no country → US default, first US shared number (unchanged)', async () => {
    setStaging(false);
    H.country = undefined;
    expect((await returnPhone(allShared())).phone).toBe('12025550100');
  });
});

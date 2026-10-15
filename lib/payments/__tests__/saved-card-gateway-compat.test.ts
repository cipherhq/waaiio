import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockResolveBusinessGateway } = vi.hoisted(() => ({
  mockResolveBusinessGateway: vi.fn(),
}));

vi.mock('../gateway-resolver', () => ({
  resolveBusinessGateway: (...args: unknown[]) => mockResolveBusinessGateway(...args),
}));

import {
  isCompatibleForSavedCard,
  isSharedPlatformPaystackCompatible,
} from '../saved-card-compat';
import { getSavedPaymentMethod } from '../charge-saved';
import { savedPaymentAdapter } from '../saved-payment-adapter';

const JSHOP_ID = '07e121fa-6efc-41b5-a057-0a458ffec94d';
const PAYSTACK_BIZ_ID = 'adea3e0c-47b0-4976-b961-2709b512ab04';
const PHONE = '+2348012345678';

const PAYSTACK_METHOD = {
  id: 'ac0031bb-6ffb-484c-82be-0d766014b335',
  gateway: 'paystack',
  authorization_code: 'AUTH_test',
  customer_code: 'CUS_test',
  authorization_email: '2348012345678@whatsapp.waaiio.com',
  stripe_payment_method_id: null,
  stripe_customer_id: null,
  card_last4: '4081',
  card_brand: 'visa',
  pin_hash: 'pin-hash',
  pin_attempts: 0,
  pin_locked_until: null,
  customer_phone: PHONE,
  is_active: true,
};

type CredentialRow = {
  id: string;
  secret_key?: string | null;
  platform_subaccount_code?: string | null;
  connect_account_id?: string | null;
  connection_type?: string | null;
} | null;

function createSupabase(opts: {
  credential?: CredentialRow;
  savedMethods?: Array<Record<string, unknown>>;
} = {}) {
  const from = vi.fn((table: string) => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};

    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.not = vi.fn(() => chain);
    chain.in = vi.fn(() => chain);

    chain.maybeSingle = vi.fn(async () => {
      if (table === 'business_payment_credentials') {
        return { data: opts.credential ?? null, error: null };
      }
      if (table === 'saved_payment_methods') {
        return { data: opts.savedMethods?.[0] ?? null, error: null };
      }
      return { data: null, error: null };
    });

    chain.limit = vi.fn(async () => {
      if (table === 'saved_payment_methods') {
        return { data: opts.savedMethods ?? [], error: null };
      }
      return { data: [], error: null };
    });

    return chain;
  });

  return {
    supabase: { from } as any,
    from,
  };
}

describe('#520 saved-card canonical gateway compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('blocks the production Jshop shape: Stripe/USD target cannot offer a global Paystack method', async () => {
    mockResolveBusinessGateway.mockResolvedValue({
      gateway: 'stripe',
      currency: 'USD',
      source: 'country_default',
    });
    const { supabase, from } = createSupabase({ savedMethods: [PAYSTACK_METHOD] });

    const method = await getSavedPaymentMethod(supabase, JSHOP_ID, PHONE);

    expect(method).toBeNull();
    expect(mockResolveBusinessGateway).toHaveBeenCalledWith(supabase, JSHOP_ID);
    expect(from).not.toHaveBeenCalledWith('saved_payment_methods');
    expect(from).not.toHaveBeenCalledWith('business_payment_credentials');
  });

  it('preserves compatible Paystack cross-business reuse on the shared platform account', async () => {
    mockResolveBusinessGateway.mockResolvedValue({
      gateway: 'paystack',
      currency: 'NGN',
      source: 'country_default',
    });
    const { supabase } = createSupabase({ savedMethods: [PAYSTACK_METHOD] });

    const method = await getSavedPaymentMethod(supabase, PAYSTACK_BIZ_ID, PHONE);

    expect(method?.id).toBe(PAYSTACK_METHOD.id);
    expect(method?.gateway).toBe('paystack');
  });

  it('blocks a Stripe saved method when the target business is canonically Paystack', async () => {
    mockResolveBusinessGateway.mockResolvedValue({
      gateway: 'paystack',
      currency: 'NGN',
      source: 'country_default',
    });
    const { supabase, from } = createSupabase();

    const result = await isCompatibleForSavedCard(supabase, PAYSTACK_BIZ_ID, 'stripe');

    expect(result).toEqual({ compatible: false, reason: 'gateway_mismatch' });
    expect(from).not.toHaveBeenCalledWith('business_payment_credentials');
  });

  it('allows a Stripe saved method for a canonical Stripe platform business', async () => {
    mockResolveBusinessGateway.mockResolvedValue({
      gateway: 'stripe',
      currency: 'USD',
      source: 'country_default',
    });
    const { supabase } = createSupabase();

    const result = await isCompatibleForSavedCard(supabase, JSHOP_ID, 'stripe');

    expect(result).toEqual({ compatible: true });
  });

  it('keeps Paystack BYO credential state fail-closed even when the canonical provider is Paystack', async () => {
    mockResolveBusinessGateway.mockResolvedValue({
      gateway: 'paystack',
      currency: 'NGN',
      source: 'country_default',
    });
    const { supabase } = createSupabase({
      credential: {
        id: 'cred-byo',
        secret_key: 'sk_business',
        platform_subaccount_code: 'ACCT_business',
        connect_account_id: null,
      },
    });

    const result = await isSharedPlatformPaystackCompatible(supabase, PAYSTACK_BIZ_ID);

    expect(result).toEqual({ compatible: false, reason: 'byo_paystack' });
  });

  it('fails closed when the target business canonical route cannot be resolved', async () => {
    mockResolveBusinessGateway.mockResolvedValue({
      gateway: null,
      currency: null,
      source: null,
      reason: 'country_gateway_not_configured',
    });
    const { supabase, from } = createSupabase();

    const result = await isCompatibleForSavedCard(supabase, JSHOP_ID, 'stripe');

    expect(result).toEqual({ compatible: false, reason: 'gateway_resolution_failed' });
    expect(from).not.toHaveBeenCalledWith('business_payment_credentials');
  });

  it('blocks a stale incompatible Paystack method before any payment row or provider dispatch', async () => {
    mockResolveBusinessGateway.mockResolvedValue({
      gateway: 'stripe',
      currency: 'USD',
      source: 'country_default',
    });
    const { supabase, from } = createSupabase({ savedMethods: [PAYSTACK_METHOD] });

    const result = await savedPaymentAdapter.chargeSavedMethod(supabase, {
      methodId: PAYSTACK_METHOD.id,
      customerPhone: PHONE,
      amount: 50,
      currency: 'USD',
      email: '',
      reference: 'WA-520-STALE',
      businessId: JSHOP_ID,
      bookingId: 'booking-520',
      transactionCategory: 'scheduling',
      inboundChannelId: 'channel-520',
      confirmationOrigin: 'whatsapp',
    });

    expect(result).toEqual({ status: 'method_not_found' });
    expect(from).not.toHaveBeenCalledWith('payments');
  });
});

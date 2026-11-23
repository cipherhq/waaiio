/**
 * M557 part 2 (Owner decision 2026-11-23): the WhatsApp table journey with a
 * minimum spend and bottle packages. table → date → time → party size →
 * "Choose a package" → summary → pay deposit or full amount → confirmation.
 * Tables with no minimum spend and no packages behave exactly as before.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockContext, getStep } from '@/lib/bot/flows/__tests__/helpers';
import type { FlowContext } from '@/lib/bot/flows/types';
import { tableOffer, tableOfferLines, tablePayableNow } from '@/lib/bot/flows/shared/table-offer';

const GOLD = { id: '11111111-1111-4111-8111-111111111111', name: 'Gold', includes: '2 Hennessy VS + 1 Moët', price: 650000 };
const SILVER = { id: '22222222-2222-4222-8222-222222222222', name: 'Silver', includes: '', price: 400000 };
type TableRow = { id: string } & Record<string, unknown>;
const plain: TableRow = {
  id: 'table-plain', name: 'Patio A', resource_type: 'table', capacity: 6, min_party_size: 2, section: null,
  deposit_amount: 5000, reservation_duration_minutes: 90, description: null,
  available_days: null, available_from: null, available_to: null,
  minimum_spend: null, payment_mode: 'deposit', packages: [],
};
const vip: TableRow = { ...plain, id: 'table-vip', name: 'VIP Booth', capacity: 8, deposit_amount: 50000, minimum_spend: 500000, packages: [GOLD, SILVER] };

function query(data: unknown = [], count = 0): any {
  const q: any = {};
  for (const method of ['select', 'eq', 'neq', 'is', 'not', 'in', 'or', 'gte', 'lte', 'order', 'limit', 'update', 'insert']) q[method] = vi.fn(() => q);
  q.single = vi.fn(async () => ({ data, error: null }));
  q.maybeSingle = vi.fn(async () => ({ data, error: null }));
  q.then = (resolve: any, reject: any) => Promise.resolve({ data, count, error: null }).then(resolve, reject);
  return q;
}
function context(data: Record<string, unknown> = {}): FlowContext {
  const ctx = createMockContext();
  ctx.copyLang = 'en';
  ctx.business!.category = 'restaurant';
  ctx.business!.country_code = 'NG';
  ctx.business!.metadata = { require_terms_before_payment: false };
  ctx.session.business_id = null;
  ctx.session.session_data = { first_name: 'Ada', last_name: 'Obi', date: '2030-01-07', time: '22:00', party_size: 6, ...data };
  vi.mocked(ctx.supabase.from).mockImplementation((() => query()) as any);
  return ctx;
}
async function flows() {
  const [{ tableReservationFlow }, { schedulingFlow }] = await Promise.all([
    import('@/lib/bot/flows/table-reservation.flow'),
    import('@/lib/bot/flows/scheduling.flow'),
  ]);
  return { tableReservationFlow, schedulingFlow };
}
/** Pick a table the way the customer does: validate() on select_table, then merge its data. */
async function pickTable(ctx: FlowContext, table: TableRow) {
  const { tableReservationFlow } = await flows();
  vi.mocked(ctx.supabase.from).mockImplementation(((t: string) => t === 'seating_resources' ? query(table) : query()) as any);
  const result = await getStep(tableReservationFlow, 'select_table').validate(table.id, ctx);
  expect(result.valid).toBe(true);
  Object.assign(ctx.session.session_data, result.data);
  vi.mocked(ctx.supabase.from).mockImplementation((() => query()) as any);
}
async function choosePackage(ctx: FlowContext, input: string) {
  const { schedulingFlow } = await flows();
  const step = getStep(schedulingFlow, 'select_table_package');
  const result = await step.validate(input, ctx);
  if (result.valid) Object.assign(ctx.session.session_data, result.data);
  return result;
}
const text = (m: unknown) => JSON.stringify(m);

// The flow modules are large; load them once outside the 5 s per-test limit.
beforeAll(async () => { await flows(); }, 60_000);
afterEach(() => vi.restoreAllMocks());

describe('table list (select_table)', () => {
  it('shows the minimum spend in the row; a table without one keeps its exact row', async () => {
    const { tableReservationFlow } = await flows();
    const ctx = context();
    vi.mocked(ctx.supabase.from).mockImplementation((() => query([plain, vip])) as any);
    const [list] = await getStep(tableReservationFlow, 'select_table').prompt(ctx) as any[];
    expect(list.items[0]).toEqual({ title: 'Patio A', description: '2-6 guests · Deposit: ₦5,000', postbackText: 'table-plain' });
    expect(list.items[1].description).toBe('2-8 guests · ₦500,000 minimum spend · Deposit: ₦50,000');
  });

  it('keeps the offer in the session and clears an earlier package choice', async () => {
    const ctx = context({ _seating_package_id: GOLD.id });
    await pickTable(ctx, vip);
    expect(ctx.session.session_data).toMatchObject({
      _seating_minimum_spend: 500000, _seating_payment_mode: 'deposit', _seating_packages: [GOLD, SILVER], _seating_package_id: null,
      service_price: 50000, service_deposit: 50000,
    });
  });
});

describe('"Choose a package" step', () => {
  it('follows the party size for every table', async () => {
    const { schedulingFlow } = await flows();
    const ctx = context({ _is_table_reservation: true });
    expect(await getStep(schedulingFlow, 'select_quantity').next(ctx)).toBe('select_table_package');
    expect(await getStep(schedulingFlow, 'select_table_package').next(ctx)).toBe('collect_guest_names');
  });

  it('is skipped, changing nothing, for ordinary bookings and tables without an offer', async () => {
    const { schedulingFlow } = await flows();
    const step = getStep(schedulingFlow, 'select_table_package');
    const service = context({ service_id: 'svc', service_price: 7000, service_deposit: 1000 });
    expect(await step.skipIf!(service)).toBe(true);
    expect(service.session.session_data).toMatchObject({ service_price: 7000, service_deposit: 1000 });
    const ctx = context();
    await pickTable(ctx, plain);
    const before = { ...ctx.session.session_data };
    expect(await step.skipIf!(ctx)).toBe(true);
    expect(ctx.session.session_data).toEqual({ ...before, _seating_package_id: null });
  });

  it('is skipped for a minimum spend without packages; pay in full then charges the minimum spend', async () => {
    const { schedulingFlow } = await flows();
    const ctx = context();
    await pickTable(ctx, { ...plain, minimum_spend: 300000, payment_mode: 'full' });
    expect(await getStep(schedulingFlow, 'select_table_package').skipIf!(ctx)).toBe(true);
    expect(ctx.session.session_data).toMatchObject({ service_price: 300000, service_deposit: 300000 });
  });

  it('lists each package with its price, then "No package – minimum spend"', async () => {
    const { schedulingFlow } = await flows();
    const ctx = context();
    await pickTable(ctx, vip);
    const step = getStep(schedulingFlow, 'select_table_package');
    expect(await step.skipIf!(ctx)).toBe(false);
    const [list] = await step.prompt(ctx) as any[];
    expect(list).toMatchObject({ type: 'list', title: 'Choose a package', buttonLabel: 'View packages' });
    expect(list.body).toBe('Choose a package for VIP Booth.\n\nYou pay a ₦50,000 deposit now and the rest at the venue.');
    expect(list.items).toEqual([
      { title: 'Gold', description: '₦650,000 · 2 Hennessy VS + 1 Moët', postbackText: `tpkg:${GOLD.id}` },
      // A short price fits in the title (buildListItem).
      { title: 'Silver — ₦400,000', postbackText: `tpkg:${SILVER.id}` },
      { title: 'No package', description: 'Minimum spend ₦500,000', postbackText: 'tpkg:none' },
    ]);
  });

  it('fits WhatsApp limits: at most 10 rows, titles 24 and descriptions 72 characters', async () => {
    const { schedulingFlow } = await flows();
    const ctx = context();
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `0000000${i}-0000-4000-8000-000000000000`.slice(-36), name: `Package with a very long name ${i}`, includes: 'x'.repeat(300), price: 1000 + i }));
    await pickTable(ctx, { ...vip, minimum_spend: null, packages: many, payment_mode: 'full' });
    const [list] = await getStep(schedulingFlow, 'select_table_package').prompt(ctx) as any[];
    expect(list.items).toHaveLength(10);
    for (const item of list.items) {
      expect(item.title.length).toBeLessThanOrEqual(24);
      expect((item.description || '').length).toBeLessThanOrEqual(72);
    }
    expect(list.items[9]).toEqual({ title: 'No package', description: 'Just the table', postbackText: 'tpkg:none' });
    expect(list.body).toContain('You pay for your choice in full when you book.');
  });

  it.each([
    ['deposit only, a package', 'deposit', `tpkg:${GOLD.id}`, GOLD.id, 50000],
    ['deposit only, no package', 'deposit', 'tpkg:none', null, 50000],
    ['pay in full, a package', 'full', `tpkg:${SILVER.id}`, SILVER.id, 400000],
    ['pay in full, no package', 'full', 'tpkg:none', null, 500000],
    ['pay in full, the name typed', 'full', 'gold', GOLD.id, 650000],
  ] as const)('%s → amount to pay now', async (_label, mode, input, packageId, amount) => {
    const ctx = context();
    await pickTable(ctx, { ...vip, payment_mode: mode });
    expect(await choosePackage(ctx, input)).toEqual({ valid: true, data: { _seating_package_id: packageId, service_price: amount, service_deposit: amount } });
  });

  it('pay in full, no package and no minimum spend pays the deposit (Owner Q1 A)', async () => {
    const ctx = context();
    await pickTable(ctx, { ...vip, minimum_spend: null, payment_mode: 'full' });
    expect(await choosePackage(ctx, 'tpkg:none')).toMatchObject({ data: { service_price: 50000 } });
  });

  it("refuses a package that is not on this table", async () => {
    const ctx = context();
    await pickTable(ctx, vip);
    expect(await choosePackage(ctx, 'tpkg:33333333-3333-4333-8333-333333333333')).toMatchObject({ valid: false });
    expect(await choosePackage(ctx, 'Platinum')).toMatchObject({ valid: false });
  });
});

describe('summary before confirming', () => {
  it('names the package, minimum spend and what is paid now', async () => {
    const { schedulingFlow } = await flows();
    const ctx = context();
    await pickTable(ctx, vip);
    await choosePackage(ctx, `tpkg:${GOLD.id}`);
    const out = text(await getStep(schedulingFlow, 'confirmation').prompt(ctx));
    expect(out).toContain('🪑 VIP Booth\\n🍾 Package: Gold – ₦650,000\\n   2 Hennessy VS + 1 Moët\\n💵 Minimum spend: ₦500,000\\nThe rest is paid at the venue.');
    expect(out).toContain('💰 ₦50,000');
  });

  it('pay in full shows the package price as the amount', async () => {
    const { schedulingFlow } = await flows();
    const ctx = context();
    await pickTable(ctx, { ...vip, payment_mode: 'full' });
    await choosePackage(ctx, `tpkg:${GOLD.id}`);
    const out = text(await getStep(schedulingFlow, 'confirmation').prompt(ctx));
    expect(out).toContain('💰 ₦650,000');
    expect(out).not.toContain('rest is paid at the venue');
  });

  it('a table without an offer shows exactly the old summary lines', async () => {
    const { schedulingFlow } = await flows();
    const ctx = context();
    await pickTable(ctx, plain);
    const out = text(await getStep(schedulingFlow, 'confirmation').prompt(ctx));
    expect(out).toContain('🪑 Patio A\\n📅');
    expect(out).not.toMatch(/Package|Minimum spend|venue/);
  });
});

describe('create_booking: amount, RPC terms, payment and confirmation', () => {
  beforeEach(async () => {
    vi.spyOn(await import('@/lib/integrations/google-calendar'), 'syncBookingToCalendar').mockResolvedValue(undefined as any);
    vi.spyOn(await import('@/lib/capabilities/service'), 'getEnabledCapabilities').mockResolvedValue([]);
    vi.spyOn(await import('@/lib/tier-limits'), 'checkTierLimit').mockResolvedValue({ allowed: true } as any);
    vi.spyOn(await import('@/lib/bot/flows/shared/capability-guard'), 'requireCurrentCapability').mockResolvedValue({ allowed: true });
    vi.spyOn(await import('@/lib/bot/automation/rules-engine'), 'evaluateRules').mockResolvedValue(undefined as any);
    vi.spyOn(await import('@/lib/bot/automation/sequence-service'), 'triggerSequences').mockResolvedValue(undefined as any);
    vi.spyOn(await import('@/lib/bot/flows/shared/notifications'), 'createNotification').mockResolvedValue(undefined as any);
    vi.spyOn(await import('@/lib/bot/flows/shared/notify-owner'), 'notifyOwnerNewBooking').mockResolvedValue(undefined as any);
    vi.spyOn(await import('@/lib/bot/flows/shared/post-completion'), 'handlePostCompletion').mockResolvedValue(undefined as any);
    const { savedPaymentAdapter } = await import('@/lib/payments/saved-payment-adapter');
    vi.spyOn(savedPaymentAdapter, 'getSavedMethods').mockResolvedValue([]);
    vi.spyOn(await import('@/lib/bot/flows/shared/payment'), 'initializePayment').mockResolvedValue({ reference: 'pay-ref', url: 'https://example.test/pay' } as any);
    vi.spyOn(await import('@/lib/bot/flows/shared/bank-transfer'), 'checkBankTransferEligibility').mockResolvedValue({ qualifies: false, bankAccount: null, platformSettings: {} } as any);
  });
  /** The committed booking the database returns: by default exactly what the session chose. */
  function committedRow(ctx: FlowContext, status: string) {
    const offer = tableOffer(ctx.session.session_data);
    const amount = tablePayableNow(offer);
    return { status, deposit_amount: amount, total_amount: amount, metadata: { table_offer: { package: offer.selectedPackage } } };
  }
  function bookTable(ctx: FlowContext, status = 'pending', error: unknown = null, committed = committedRow(ctx, status)) {
    vi.mocked(ctx.supabase.rpc).mockImplementation(((name: string) => {
      if (name === 'book_table_atomic') {
        const q = query(error ? null : { booking_id: 'booking-vip', reference_code: 'VIP001', slot_available: true });
        if (error) q.single = vi.fn(async () => ({ data: null, error }));
        return q;
      }
      return Promise.resolve({ data: null, error: null });
    }) as any);
    vi.mocked(ctx.supabase.from).mockImplementation(((t: string) => t === 'bookings' ? query(committed) : query()) as any);
  }

  it('pay in full with a package: the package price is the amount, checked by the database and charged', async () => {
    const { schedulingFlow } = await flows();
    const ctx = context();
    await pickTable(ctx, { ...vip, payment_mode: 'full' });
    await choosePackage(ctx, `tpkg:${GOLD.id}`);
    bookTable(ctx);
    const out = text(await getStep(schedulingFlow, 'create_booking').prompt(ctx));
    expect(ctx.supabase.rpc).toHaveBeenCalledWith('book_table_atomic', expect.objectContaining({
      p_seating_resource_id: 'table-vip', p_expected_deposit: 50000,
      p_deposit_amount: 650000, p_total_amount: 650000, p_deposit_status: 'pending', p_status: 'pending',
      p_package_id: GOLD.id, p_expected_payable: 650000, p_expected_minimum_spend: 500000, p_expected_package_price: 650000,
    }));
    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');
    expect(initializePayment).toHaveBeenCalledWith(ctx.supabase, expect.objectContaining({ amount: 650000, bookingId: 'booking-vip' }));
    expect(out).toContain('💳 *Payment: ₦650,000*');
    expect(out).toContain('🍾 Package: Gold – ₦650,000');
    expect(ctx.session.session_data).toMatchObject({ deposit_amount: 650000, total_amount: 650000 });
  });

  it('deposit only with a package: the deposit is charged and the package is named', async () => {
    const { schedulingFlow } = await flows();
    const ctx = context();
    await pickTable(ctx, vip);
    await choosePackage(ctx, `tpkg:${SILVER.id}`);
    bookTable(ctx);
    const out = text(await getStep(schedulingFlow, 'create_booking').prompt(ctx));
    expect(ctx.supabase.rpc).toHaveBeenCalledWith('book_table_atomic', expect.objectContaining({
      p_deposit_amount: 50000, p_total_amount: 50000, p_package_id: SILVER.id, p_expected_payable: 50000, p_expected_package_price: 400000,
    }));
    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');
    expect(initializePayment).toHaveBeenCalledWith(ctx.supabase, expect.objectContaining({ amount: 50000 }));
    expect(out).toContain('💳 *Deposit: ₦50,000*');
    expect(out).toContain('🍾 Package: Silver – ₦400,000');
    expect(out).toContain('The rest is paid at the venue.');
  });

  it('a table without an offer books exactly as before (same amount, no package terms)', async () => {
    const { schedulingFlow } = await flows();
    const ctx = context();
    await pickTable(ctx, plain);
    bookTable(ctx);
    const out = text(await getStep(schedulingFlow, 'create_booking').prompt(ctx));
    expect(ctx.supabase.rpc).toHaveBeenCalledWith('book_table_atomic', expect.objectContaining({
      p_expected_deposit: 5000, p_deposit_amount: 5000, p_total_amount: 5000,
      p_package_id: null, p_expected_payable: 5000, p_expected_minimum_spend: null, p_expected_package_price: null,
    }));
    expect(out).toContain('💳 *Deposit: ₦5,000*');
    expect(out).not.toMatch(/Package|Minimum spend|venue/);
  });

  it('no deposit and deposit only: confirmed at once, and the confirmation names the package above the reference', async () => {
    const { schedulingFlow } = await flows();
    const ctx = context();
    await pickTable(ctx, { ...vip, deposit_amount: 0 });
    await choosePackage(ctx, `tpkg:${GOLD.id}`);
    bookTable(ctx, 'confirmed');
    const [msg] = await getStep(schedulingFlow, 'create_booking').prompt(ctx) as any[];
    expect(ctx.supabase.rpc).toHaveBeenCalledWith('book_table_atomic', expect.objectContaining({ p_deposit_amount: 0, p_status: 'confirmed', p_package_id: GOLD.id }));
    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');
    expect(initializePayment).not.toHaveBeenCalled();
    const pkgAt = msg.text.indexOf('🍾 Package: Gold – ₦650,000');
    expect(pkgAt).toBeGreaterThan(0);
    expect(pkgAt).toBeLessThan(msg.text.indexOf('🔑'));
  });

  it('a reused booking (payment retry) for another package or amount is never paid', async () => {
    const { schedulingFlow } = await flows();
    const ctx = context({ booking_id: 'booking-vip', reference_code: 'VIP001' });
    await pickTable(ctx, { ...vip, payment_mode: 'full' });
    Object.assign(ctx.session.session_data, { booking_id: 'booking-vip', reference_code: 'VIP001' });
    await choosePackage(ctx, `tpkg:${SILVER.id}`);
    // The booking was committed earlier for Gold at 650,000; the customer then went back and chose Silver.
    bookTable(ctx, 'pending', null, { status: 'pending', deposit_amount: 650000, total_amount: 650000, metadata: { table_offer: { package: GOLD } } });
    const out = text(await getStep(schedulingFlow, 'create_booking').prompt(ctx));
    expect(ctx.supabase.rpc).not.toHaveBeenCalledWith('book_table_atomic', expect.anything());
    expect(out).toContain('Your booking terms could not be verified');
    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');
    expect(initializePayment).not.toHaveBeenCalled();
  });

  it('a reused booking that matches is paid at the committed amount', async () => {
    const { schedulingFlow } = await flows();
    const ctx = context();
    await pickTable(ctx, { ...vip, payment_mode: 'full' });
    Object.assign(ctx.session.session_data, { booking_id: 'booking-vip', reference_code: 'VIP001' });
    await choosePackage(ctx, `tpkg:${GOLD.id}`);
    bookTable(ctx);
    await getStep(schedulingFlow, 'create_booking').prompt(ctx);
    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');
    expect(initializePayment).toHaveBeenCalledWith(ctx.supabase, expect.objectContaining({ amount: 650000, bookingId: 'booking-vip' }));
  });

  it.each(['package_unavailable:Package x is not offered', 'deposit_changed:Amount to pay changed from 1 to 2'])(
    'changed terms from the database (%s) ask the customer to start again, nothing is charged', async message => {
      const { schedulingFlow } = await flows();
      const ctx = context();
      await pickTable(ctx, { ...vip, payment_mode: 'full' });
      await choosePackage(ctx, `tpkg:${GOLD.id}`);
      bookTable(ctx, 'pending', { message });
      const out = text(await getStep(schedulingFlow, 'create_booking').prompt(ctx));
      expect(out).toContain('The reservation terms have been updated');
      const { initializePayment } = await import('@/lib/bot/flows/shared/payment');
      expect(initializePayment).not.toHaveBeenCalled();
    });
});

describe('offer helpers and post-payment confirmation lines', () => {
  it('works out the amount to pay now for every combination', () => {
    const base = { _seating_deposit: 50000, _seating_packages: [GOLD], _seating_minimum_spend: 500000 };
    expect(tablePayableNow(tableOffer({ ...base, _seating_payment_mode: 'deposit', _seating_package_id: GOLD.id }))).toBe(50000);
    expect(tablePayableNow(tableOffer({ ...base, _seating_payment_mode: 'full', _seating_package_id: GOLD.id }))).toBe(650000);
    expect(tablePayableNow(tableOffer({ ...base, _seating_payment_mode: 'full', _seating_package_id: null }))).toBe(500000);
    expect(tablePayableNow(tableOffer({ ...base, _seating_payment_mode: 'full', _seating_minimum_spend: null }))).toBe(50000);
    expect(tablePayableNow(tableOffer({ _seating_deposit: 5000, _seating_payment_mode: 'full' }))).toBe(5000);
    expect(tablePayableNow(tableOffer({ ...base, _seating_payment_mode: 'full', _seating_package_id: 'not-on-table' }))).toBe(500000);
  });

  it('the paid confirmation lines (built from booking.metadata.table_offer) name the package', () => {
    expect(tableOfferLines({ packages: [GOLD], minimumSpend: 500000, paymentMode: 'full', deposit: 650000, hasOffer: true, selectedPackage: GOLD }, 'NG'))
      .toEqual(['🍾 Package: Gold – ₦650,000', '   2 Hennessy VS + 1 Moët', '💵 Minimum spend: ₦500,000']);
    expect(tableOfferLines({ packages: [], minimumSpend: null, paymentMode: 'deposit', deposit: 0, hasOffer: false, selectedPackage: null }, 'NG')).toEqual([]);
  });

  it('a capability change clears every package key', async () => {
    const { clearStaleCapabilityState } = await import('@/lib/bot/flows/shared/capability-transition');
    const d: Record<string, unknown> = { _seating_minimum_spend: 1, _seating_payment_mode: 'full', _seating_packages: [GOLD], _seating_package_id: GOLD.id };
    clearStaleCapabilityState(d, 'table_reservation', 'ordering');
    for (const key of Object.keys(d)) expect(key).not.toMatch(/^_seating_/);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getStep } from './helpers';
import { orderingFlow } from '../ordering.flow';
import { schedulingFlow } from '../scheduling.flow';
const { guard } = vi.hoisted(() => ({ guard: vi.fn() }));
vi.mock('../shared/capability-guard', () => ({ requireCurrentCapability: guard }));

for (const flow of [orderingFlow, schedulingFlow]) {
  describe(`${flow.type} referral entitlement`, () => {
    beforeEach(() => guard.mockReset());
    function context() {
      const query: any = {};
      for (const method of ['select', 'eq', 'limit']) query[method] = vi.fn(() => query);
      query.maybeSingle = vi.fn(async () => ({ data: null }));
      return { business: { id: 'merchant' }, from: '+12025550123',
        session: { session_data: { service_price: 100 } },
        supabase: { from: vi.fn(() => query) } } as any;
    }
    it('skips a disabled or policy-blocked referral without querying referrals', async () => {
      guard.mockResolvedValue({ allowed: false, reason: 'capability_disabled' });
      const ctx = context();
      expect(await getStep(flow, 'ask_referral_code').skipIf!(ctx)).toBe(true);
      expect(ctx.supabase.from).not.toHaveBeenCalled();
    });
    it('offers referral entry when current entitlement allows it', async () => {
      guard.mockResolvedValue({ allowed: true });
      const ctx = context();
      expect(await getStep(flow, 'ask_referral_code').skipIf!(ctx)).toBe(false);
      expect(guard).toHaveBeenCalledWith(ctx.supabase, {
        businessId: 'merchant', capability: 'referral', action: 'create_new',
      });
      expect(ctx.supabase.from).toHaveBeenCalledWith('referrals');
    });
  });
}

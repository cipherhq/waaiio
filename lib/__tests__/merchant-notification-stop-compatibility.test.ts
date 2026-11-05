import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasStoppedMerchantNotifications } from '@/lib/merchant-notifications/compatibility';

function database(result: { data: unknown; error: { code: string } | null }, reject = false) {
  const query = { select: vi.fn(), eq: vi.fn(), not: vi.fn(), limit: vi.fn() };
  query.select.mockReturnValue(query); query.eq.mockReturnValue(query); query.not.mockReturnValue(query);
  if (reject) query.limit.mockRejectedValue(new Error('unavailable'));
  else query.limit.mockResolvedValue(result);
  return { db: { from: vi.fn().mockReturnValue(query) }, query };
}

afterEach(() => vi.unstubAllEnvs());
describe('legacy merchant STOP compatibility', () => {
  it.each(['true', 'false'])('honors STOP with rollout %s, exact tenant and normalized number', async enabled => {
    vi.stubEnv('MERCHANT_NOTIFICATIONS_ENABLED', enabled);
    const { db, query } = database({ data: [{ id: 'removed-recipient-with-stop' }], error: null });
    expect(await hasStoppedMerchantNotifications(db as never, 'business-a', '+234 801-234-5678')).toBe(true);
    expect(db.from).toHaveBeenCalledWith('merchant_notification_recipients');
    expect(query.eq.mock.calls).toEqual([['business_id', 'business-a'], ['channel', 'whatsapp'], ['address', '+2348012345678']]);
    expect(query.not).toHaveBeenCalledWith('stopped_at', 'is', null);
    // Removed/disabled predecessors still carry the destination's explicit STOP.
    expect(query.eq.mock.calls.some(([key]) => key === 'enabled' || key === 'revoked_at')).toBe(false);
  });
  it('allows legacy delivery where no explicit STOP exists', async () => {
    const { db } = database({ data: [], error: null });
    expect(await hasStoppedMerchantNotifications(db as never, 'business-a', '2348012345678')).toBe(false);
  });
  it.each(['42P01', '42703', 'PGRST205', 'PGRST204'])('preserves legacy behavior for absent schema %s', async code => {
    const { db } = database({ data: null, error: { code } });
    expect(await hasStoppedMerchantNotifications(db as never, 'business-a', '+2348012345678')).toBe(false);
  });
  it('blocks legacy delivery when the STOP check fails for another database reason', async () => {
    const { db } = database({ data: null, error: { code: '42501' } });
    expect(await hasStoppedMerchantNotifications(db as never, 'business-a', '+2348012345678')).toBe(true);
  });
  it('blocks legacy delivery on transport exceptions', async () => {
    const { db } = database({ data: null, error: null }, true);
    expect(await hasStoppedMerchantNotifications(db as never, 'business-a', '+2348012345678')).toBe(true);
  });
});

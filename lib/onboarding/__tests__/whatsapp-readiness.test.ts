import { describe, expect, it, vi } from 'vitest';
import {
  allocateSharedChannelWithFallback,
  buildVerifiedWhatsAppLink,
  getSharedChannelFallbackPolicy,
  isAssignedWhatsAppChannelReady as ready,
  isCompatibleSharedChannelCountry,
} from '../whatsapp-readiness';

const biz = { id: 'biz-a', country_code: 'NG' };
const ghBiz = { id: 'biz-gh', country_code: 'GH' };
const shared = { channel_type: 'shared', is_active: true, connection_status: 'active', country_code: 'NG', business_id: null };

describe('admin WhatsApp channel readiness (tenant & country)', () => {
  it('accepts a verified active shared channel in the same country', () => {
    expect(ready(biz, shared)).toBe(true);
  });
  it('accepts the explicit GH -> NG shared channel regional fallback while rejecting unapproved cross-country pairs', () => {
    expect(isCompatibleSharedChannelCountry('GH', 'GH')).toBe(true);
    expect(isCompatibleSharedChannelCountry('GH', 'NG')).toBe(true);
    expect(isCompatibleSharedChannelCountry('GH', 'US')).toBe(false);
    expect(isCompatibleSharedChannelCountry('NG', 'GH')).toBe(false);
    expect(getSharedChannelFallbackPolicy('GH')).toBe('GH_TO_NG_SHARED');
    expect(getSharedChannelFallbackPolicy('NG')).toBe('EXACT_COUNTRY');
    expect(ready(ghBiz, shared)).toBe(true);
    expect(ready(ghBiz, { ...shared, country_code: 'US' })).toBe(false);
  });
  it('rejects country mismatch even when shared channel is active', () => {
    expect(ready(biz, { ...shared, country_code: 'US' })).toBe(false);
  });
  it('rejects inactive, unverified, or unknown channel types', () => {
    expect(ready(biz, { ...shared, is_active: false })).toBe(false);
    expect(ready(biz, { ...shared, connection_status: 'verifying' })).toBe(false);
    expect(ready(biz, { ...shared, channel_type: 'unexpected' })).toBe(false);
  });
  it('requires exact tenant binding for dedicated channels', () => {
    const owned = { ...shared, channel_type: 'dedicated', business_id: 'biz-a' };
    expect(ready(biz, owned)).toBe(true);
    expect(ready(biz, { ...owned, business_id: 'biz-b' })).toBe(false);
    expect(ready(biz, { ...owned, business_id: null })).toBe(false);
  });
  it('never treats missing assignment as ready', () => {
    expect(ready(null, shared)).toBe(false);
    expect(ready(biz, null)).toBe(false);
  });
  it('does not treat a shared channel assigned to a business as platform shared', () => {
    expect(ready(biz, { ...shared, business_id: 'biz-b' })).toBe(false);
  });
  it('only exposes a Get Started-style shared QR link for an active ready business (including GH -> NG shared fallback)', () => {
    const active = { ...biz, bot_code: 'EXACT-TEST', status: 'active' };
    const activeGh = { ...ghBiz, bot_code: 'ACCRA-1', status: 'active' };
    const channel = { ...shared, phone_number: '+234 916 325 9925' };
    expect(buildVerifiedWhatsAppLink(active, channel)).toBe('https://wa.me/2349163259925?text=EXACT-TEST');
    expect(buildVerifiedWhatsAppLink(activeGh, channel)).toBe('https://wa.me/2349163259925?text=ACCRA-1');
    expect(buildVerifiedWhatsAppLink({ ...active, status: 'pending' }, channel)).toBeNull();
    expect(buildVerifiedWhatsAppLink({ ...active, messaging_suspended: true }, channel)).toBeNull();
    expect(buildVerifiedWhatsAppLink(active, { ...channel, country_code: 'US' })).toBeNull();
  });
  it('does not put a bot code on a dedicated channel QR link', () => {
    const active = { ...biz, bot_code: 'CODE', status: 'active' };
    expect(buildVerifiedWhatsAppLink(active, { ...shared, channel_type: 'dedicated', business_id: biz.id, phone_number: '+2348012345678' })).toBe('https://wa.me/2348012345678');
    expect(buildVerifiedWhatsAppLink(active, { ...shared, phone_number: 'x' })).toBeNull();
  });
});

describe('allocateSharedChannelWithFallback', () => {
  it('allocates exact country first without fallback when available', async () => {
    const rpc = vi.fn().mockResolvedValueOnce({
      data: { allocated: true, channel_id: 'ch-ng-1', phone_number: '2349163259925' },
      error: null,
    });
    const service = { rpc } as any;
    const res = await allocateSharedChannelWithFallback(service, 'biz-ng', 'NG');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('allocate_shared_channel', {
      p_business_id: 'biz-ng',
      p_country_code: 'NG',
    });
    expect(res.data).toEqual({
      allocated: true,
      channel_id: 'ch-ng-1',
      phone_number: '2349163259925',
      channel_country: 'NG',
      fallback_used: false,
    });
  });

  it('falls back from GH to NG shared channel when GH has no local shared channel', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: { allocated: false, reason: 'no_shared_channel_for_country' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { allocated: true, channel_id: 'ch-ng-shared', phone_number: '2349163259925' },
        error: null,
      });
    const service = { rpc } as any;
    const res = await allocateSharedChannelWithFallback(service, 'biz-gh', 'GH');
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenNthCalledWith(1, 'allocate_shared_channel', {
      p_business_id: 'biz-gh',
      p_country_code: 'GH',
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'allocate_shared_channel', {
      p_business_id: 'biz-gh',
      p_country_code: 'NG',
    });
    expect(res.data).toEqual({
      allocated: true,
      channel_id: 'ch-ng-shared',
      phone_number: '2349163259925',
      channel_country: 'NG',
      fallback_used: true,
    });
  });

  it('does not fall back for countries without an approved regional fallback', async () => {
    const rpc = vi.fn().mockResolvedValueOnce({
      data: { allocated: false, reason: 'no_shared_channel_for_country' },
      error: null,
    });
    const service = { rpc } as any;
    const res = await allocateSharedChannelWithFallback(service, 'biz-us', 'US');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(res.data).toEqual({ allocated: false, reason: 'no_shared_channel_for_country' });
  });

  it('repairs a stale/inactive assigned shared channel via reassign_shared_channel when repairStaleSharedChannel is enabled', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: { allocated: true, channel_id: 'ch-stale', idempotent: true },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { reassigned: true, new_channel_id: 'ch-healthy' },
        error: null,
      });

    const from = vi.fn().mockImplementation(() => ({
      select: () => ({
        eq: (col: string, val: unknown) => {
          if (col === 'id' && val === 'ch-stale') {
            return {
              maybeSingle: () =>
                Promise.resolve({
                  data: {
                    id: 'ch-stale',
                    phone_number: '2340000000',
                    channel_type: 'shared',
                    is_active: false,
                    connection_status: 'disconnected',
                    country_code: 'NG',
                    business_id: null,
                  },
                  error: null,
                }),
            };
          }
          return {
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  is: () => ({
                    order: () => ({
                      limit: () =>
                        Promise.resolve({
                          data: [
                            {
                              id: 'ch-healthy',
                              phone_number: '2349163259925',
                              country_code: 'NG',
                              business_count: 3,
                              max_businesses: 500,
                            },
                          ],
                          error: null,
                        }),
                    }),
                  }),
                }),
              }),
            }),
          };
        },
      }),
    }));

    const service = { rpc, from } as any;
    const res = await allocateSharedChannelWithFallback(service, 'biz-ng', 'NG', {
      repairStaleSharedChannel: true,
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenNthCalledWith(2, 'reassign_shared_channel', {
      p_business_id: 'biz-ng',
      p_new_channel_id: 'ch-healthy',
    });
    expect(res.data).toEqual({
      allocated: true,
      channel_id: 'ch-healthy',
      phone_number: '2349163259925',
      channel_country: 'NG',
      fallback_used: false,
      repaired: true,
    });
  });
});


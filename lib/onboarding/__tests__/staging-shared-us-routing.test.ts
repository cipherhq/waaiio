/**
 * Staging shared-US routing policy tests.
 *
 * Validates the Owner-approved staging fallback: when WAAIIO_ENVIRONMENT === 'staging',
 * approved launch countries (NG, GH, GB, CA) can fall back to a US shared channel
 * after exhausting exact-country and production-approved cross-country candidates.
 *
 * Production behavior: only GH → NG fallback. Missing, malformed, or contradictory
 * WAAIIO_ENVIRONMENT values never enable staging fallbacks.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';

import { STAGING_APP_PROJECT_ID, STAGING_SUPABASE_URL } from '@/lib/staging-test-mode';

type WhatsAppReadiness = typeof import('../whatsapp-readiness');

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['WAAIIO_ENVIRONMENT', 'NEXT_PUBLIC_WAAIIO_ENVIRONMENT', 'VERCEL_PROJECT_ID', 'NEXT_PUBLIC_SUPABASE_URL'] as const;

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.resetModules();
});

function saveEnv() {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
}

async function loadModule(env?: string, stagingIdentity = false): Promise<WhatsAppReadiness> {
  saveEnv();
  if (env !== undefined) process.env.WAAIIO_ENVIRONMENT = env;
  else delete process.env.WAAIIO_ENVIRONMENT;
  if (stagingIdentity) {
    process.env.VERCEL_PROJECT_ID = STAGING_APP_PROJECT_ID;
    process.env.NEXT_PUBLIC_SUPABASE_URL = STAGING_SUPABASE_URL;
  } else {
    delete process.env.VERCEL_PROJECT_ID;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  }
  vi.resetModules();
  return import('../whatsapp-readiness');
}

// ─── Production behavior (default) ───────────────────────────────────────────

describe('production routing (WAAIIO_ENVIRONMENT unset)', () => {
  it('only allows GH → NG fallback', async () => {
    const mod = await loadModule(undefined);
    expect(mod.isCompatibleSharedChannelCountry('GH', 'NG')).toBe(true);
    expect(mod.isCompatibleSharedChannelCountry('GH', 'US')).toBe(false);
    expect(mod.isCompatibleSharedChannelCountry('NG', 'US')).toBe(false);
    expect(mod.isCompatibleSharedChannelCountry('GB', 'US')).toBe(false);
    expect(mod.isCompatibleSharedChannelCountry('CA', 'US')).toBe(false);
  });

  it('getSharedChannelFallbackPolicy returns EXACT_COUNTRY for non-GH', async () => {
    const mod = await loadModule(undefined);
    expect(mod.getSharedChannelFallbackPolicy('NG')).toBe('EXACT_COUNTRY');
    expect(mod.getSharedChannelFallbackPolicy('GB')).toBe('EXACT_COUNTRY');
    expect(mod.getSharedChannelFallbackPolicy('CA')).toBe('EXACT_COUNTRY');
    expect(mod.getSharedChannelFallbackPolicy('US')).toBe('EXACT_COUNTRY');
    expect(mod.getSharedChannelFallbackPolicy('GH')).toBe('GH_TO_NG_SHARED');
  });

  it('NG business + US shared channel is NOT ready', async () => {
    const mod = await loadModule(undefined);
    const ngBiz = { id: 'biz-ng', country_code: 'NG' };
    const usChannel = { channel_type: 'shared', is_active: true, connection_status: 'active', country_code: 'US', business_id: null };
    expect(mod.isAssignedWhatsAppChannelReady(ngBiz, usChannel)).toBe(false);
  });

  it('SHARED_CHANNEL_FALLBACK_COUNTRIES has only GH entry', async () => {
    const mod = await loadModule(undefined);
    expect(Object.keys(mod.SHARED_CHANNEL_FALLBACK_COUNTRIES)).toEqual(['GH']);
    expect(mod.SHARED_CHANNEL_FALLBACK_COUNTRIES['GH']).toEqual(['NG']);
  });
});

describe('production routing (WAAIIO_ENVIRONMENT=production)', () => {
  it('explicit production env does not enable US fallback', async () => {
    const mod = await loadModule('production');
    expect(mod.isCompatibleSharedChannelCountry('NG', 'US')).toBe(false);
    expect(mod.isCompatibleSharedChannelCountry('GB', 'US')).toBe(false);
    expect(mod.isCompatibleSharedChannelCountry('CA', 'US')).toBe(false);
    expect(mod.getSharedChannelFallbackPolicy('NG')).toBe('EXACT_COUNTRY');
    expect(Object.keys(mod.SHARED_CHANNEL_FALLBACK_COUNTRIES)).toEqual(['GH']);
  });
});

// ─── Security: malformed and contradictory values ────────────────────────────

describe('security: malformed WAAIIO_ENVIRONMENT never enables staging fallback', () => {
  it.each([
    'Staging',     // wrong case
    'STAGING',     // uppercase
    ' staging',    // leading space
    'staging ',    // trailing space
    'stagingg',    // typo
    'stage',       // abbreviation
    'development', // development env
    '',            // empty string
  ])('WAAIIO_ENVIRONMENT=%j does NOT enable US fallback', async (env) => {
    const mod = await loadModule(env);
    expect(mod.isCompatibleSharedChannelCountry('NG', 'US')).toBe(false);
    expect(mod.getSharedChannelFallbackPolicy('NG')).toBe('EXACT_COUNTRY');
  });

  it('does not check NEXT_PUBLIC_WAAIIO_ENVIRONMENT (client-side env is not authoritative)', async () => {
    saveEnv();
    delete process.env.WAAIIO_ENVIRONMENT;
    process.env.NEXT_PUBLIC_WAAIIO_ENVIRONMENT = 'staging';
    // Even with staging infrastructure, client-side env alone is not enough
    process.env.VERCEL_PROJECT_ID = STAGING_APP_PROJECT_ID;
    process.env.NEXT_PUBLIC_SUPABASE_URL = STAGING_SUPABASE_URL;
    vi.resetModules();
    const mod = await import('../whatsapp-readiness');
    expect(mod.isCompatibleSharedChannelCountry('NG', 'US')).toBe(false);
  });

  it('contradictory config: WAAIIO_ENVIRONMENT=staging but no infrastructure identity blocks fallback', async () => {
    // Simulates accidental WAAIIO_ENVIRONMENT=staging on a machine with no Vercel identity
    const mod = await loadModule('staging', false);
    expect(mod.isCompatibleSharedChannelCountry('NG', 'US')).toBe(false);
    expect(mod.SHARED_CHANNEL_FALLBACK_COUNTRIES['NG']).toBeUndefined();
  });

  it('contradictory config: staging env var + production Vercel project ID blocks fallback', async () => {
    saveEnv();
    process.env.WAAIIO_ENVIRONMENT = 'staging';
    process.env.VERCEL_PROJECT_ID = 'prj_PRODUCTION_PROJECT_ID';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://production.supabase.co';
    vi.resetModules();
    const mod = await import('../whatsapp-readiness');
    expect(mod.isCompatibleSharedChannelCountry('NG', 'US')).toBe(false);
  });
});

// ─── Staging behavior ────────────────────────────────────────────────────────

describe('staging routing (WAAIIO_ENVIRONMENT=staging)', () => {
  it('enables US fallback for all 4 approved staging countries', async () => {
    const mod = await loadModule('staging', true);
    for (const cc of ['NG', 'GH', 'GB', 'CA']) {
      expect(mod.isCompatibleSharedChannelCountry(cc, 'US')).toBe(true);
    }
  });

  it('GH preserves NG as first fallback, US as second', async () => {
    const mod = await loadModule('staging', true);
    const fallbacks = mod.SHARED_CHANNEL_FALLBACK_COUNTRIES['GH'];
    expect(fallbacks).toEqual(['NG', 'US']);
    // GH → NG still works
    expect(mod.isCompatibleSharedChannelCountry('GH', 'NG')).toBe(true);
    expect(mod.isCompatibleSharedChannelCountry('GH', 'US')).toBe(true);
  });

  it('NG, GB, CA have US as sole fallback', async () => {
    const mod = await loadModule('staging', true);
    expect(mod.SHARED_CHANNEL_FALLBACK_COUNTRIES['NG']).toEqual(['US']);
    expect(mod.SHARED_CHANNEL_FALLBACK_COUNTRIES['GB']).toEqual(['US']);
    expect(mod.SHARED_CHANNEL_FALLBACK_COUNTRIES['CA']).toEqual(['US']);
  });

  it('does NOT enable fallback for unapproved countries (KE, ZA, etc.)', async () => {
    const mod = await loadModule('staging', true);
    expect(mod.isCompatibleSharedChannelCountry('KE', 'US')).toBe(false);
    expect(mod.isCompatibleSharedChannelCountry('ZA', 'US')).toBe(false);
    expect(mod.isCompatibleSharedChannelCountry('IN', 'US')).toBe(false);
    expect(mod.SHARED_CHANNEL_FALLBACK_COUNTRIES['KE']).toBeUndefined();
    expect(mod.SHARED_CHANNEL_FALLBACK_COUNTRIES['ZA']).toBeUndefined();
  });

  it('US itself has no fallback (exact-country only)', async () => {
    const mod = await loadModule('staging', true);
    expect(mod.SHARED_CHANNEL_FALLBACK_COUNTRIES['US']).toBeUndefined();
    expect(mod.getSharedChannelFallbackPolicy('US')).toBe('EXACT_COUNTRY');
  });

  it('getSharedChannelFallbackPolicy returns EXACT_COUNTRY even on staging (MFA hash stability)', async () => {
    // The policy label is bound into the step-up MFA parameter hash (SEC-005).
    // Changing it would break the admin client/server hash contract.
    // Staging US fallbacks are transparent infrastructure — the label stays stable.
    const mod = await loadModule('staging', true);
    expect(mod.getSharedChannelFallbackPolicy('NG')).toBe('EXACT_COUNTRY');
    expect(mod.getSharedChannelFallbackPolicy('GB')).toBe('EXACT_COUNTRY');
    expect(mod.getSharedChannelFallbackPolicy('CA')).toBe('EXACT_COUNTRY');
    expect(mod.getSharedChannelFallbackPolicy('GH')).toBe('GH_TO_NG_SHARED');
    expect(mod.getSharedChannelFallbackPolicy('US')).toBe('EXACT_COUNTRY');
    expect(mod.getSharedChannelFallbackPolicy('KE')).toBe('EXACT_COUNTRY');
  });

  it('NG business + US shared channel IS ready on staging', async () => {
    const mod = await loadModule('staging', true);
    const ngBiz = { id: 'biz-ng', country_code: 'NG' };
    const usChannel = { channel_type: 'shared', is_active: true, connection_status: 'active', country_code: 'US', business_id: null };
    expect(mod.isAssignedWhatsAppChannelReady(ngBiz, usChannel)).toBe(true);
  });

  it('inactive US channel is NOT ready even on staging', async () => {
    const mod = await loadModule('staging', true);
    const ngBiz = { id: 'biz-ng', country_code: 'NG' };
    const inactiveUS = { channel_type: 'shared', is_active: false, connection_status: 'active', country_code: 'US', business_id: null };
    expect(mod.isAssignedWhatsAppChannelReady(ngBiz, inactiveUS)).toBe(false);
  });

  it('US channel with connection_status !== active is NOT ready on staging', async () => {
    const mod = await loadModule('staging', true);
    const ngBiz = { id: 'biz-ng', country_code: 'NG' };
    const disconnected = { channel_type: 'shared', is_active: true, connection_status: 'disconnected', country_code: 'US', business_id: null };
    expect(mod.isAssignedWhatsAppChannelReady(ngBiz, disconnected)).toBe(false);
  });

  it('buildVerifiedWhatsAppLink works for NG business on US channel in staging', async () => {
    const mod = await loadModule('staging', true);
    const active = { id: 'biz-ng', country_code: 'NG', bot_code: 'JANELUX', status: 'active' };
    const usChannel = { channel_type: 'shared', is_active: true, connection_status: 'active', country_code: 'US', business_id: null, phone_number: '+12404712139' };
    expect(mod.buildVerifiedWhatsAppLink(active, usChannel)).toBe('https://wa.me/12404712139?text=JANELUX');
  });
});

// ─── Staging allocation ──────────────────────────────────────────────────────

describe('staging allocation: NG business falls back to US channel', () => {
  it('tries NG first, then US on staging when NG has no shared channel', async () => {
    const mod = await loadModule('staging', true);
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: { allocated: false, reason: 'no_shared_channel_for_country' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { allocated: true, channel_id: 'ch-us-1', phone_number: '12404712139' },
        error: null,
      });
    const service = { rpc } as any;
    const res = await mod.allocateSharedChannelWithFallback(service, 'biz-ng', 'NG');
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenNthCalledWith(1, 'allocate_shared_channel', {
      p_business_id: 'biz-ng', p_country_code: 'NG',
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'allocate_shared_channel', {
      p_business_id: 'biz-ng', p_country_code: 'US',
    });
    expect(res.data).toEqual({
      allocated: true, channel_id: 'ch-us-1', phone_number: '12404712139',
      channel_country: 'US', fallback_used: true,
    });
  });

  it('GH tries GH → NG → US in order on staging', async () => {
    const mod = await loadModule('staging', true);
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { allocated: false, reason: 'no_shared_channel_for_country' }, error: null })
      .mockResolvedValueOnce({ data: { allocated: false, reason: 'all_channels_at_capacity' }, error: null })
      .mockResolvedValueOnce({ data: { allocated: true, channel_id: 'ch-us-1' }, error: null });
    const service = { rpc } as any;
    const res = await mod.allocateSharedChannelWithFallback(service, 'biz-gh', 'GH');
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc).toHaveBeenNthCalledWith(1, 'allocate_shared_channel', { p_business_id: 'biz-gh', p_country_code: 'GH' });
    expect(rpc).toHaveBeenNthCalledWith(2, 'allocate_shared_channel', { p_business_id: 'biz-gh', p_country_code: 'NG' });
    expect(rpc).toHaveBeenNthCalledWith(3, 'allocate_shared_channel', { p_business_id: 'biz-gh', p_country_code: 'US' });
    expect(res.data?.allocated).toBe(true);
    expect(res.data?.fallback_used).toBe(true);
  });

  it('GB and CA fall back to US on staging', async () => {
    const mod = await loadModule('staging', true);
    for (const cc of ['GB', 'CA']) {
      const rpc = vi.fn()
        .mockResolvedValueOnce({ data: { allocated: false, reason: 'no_shared_channel_for_country' }, error: null })
        .mockResolvedValueOnce({ data: { allocated: true, channel_id: `ch-us-${cc}` }, error: null });
      const service = { rpc } as any;
      const res = await mod.allocateSharedChannelWithFallback(service, `biz-${cc}`, cc);
      expect(rpc).toHaveBeenCalledTimes(2);
      expect(rpc).toHaveBeenNthCalledWith(2, 'allocate_shared_channel', { p_business_id: `biz-${cc}`, p_country_code: 'US' });
      expect(res.data?.allocated).toBe(true);
      expect(res.data?.fallback_used).toBe(true);
    }
  });

  it('capacity exhaustion: all channels at capacity returns failure', async () => {
    const mod = await loadModule('staging', true);
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { allocated: false, reason: 'no_shared_channel_for_country' }, error: null })
      .mockResolvedValueOnce({ data: { allocated: false, reason: 'all_channels_at_capacity' }, error: null });
    const service = { rpc } as any;
    const res = await mod.allocateSharedChannelWithFallback(service, 'biz-ng', 'NG');
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(res.data?.allocated).toBe(false);
    expect(res.data?.reason).toBe('all_channels_at_capacity');
  });

  it('exact country succeeds first — does NOT try US', async () => {
    const mod = await loadModule('staging', true);
    const rpc = vi.fn().mockResolvedValueOnce({
      data: { allocated: true, channel_id: 'ch-ng-direct' },
      error: null,
    });
    const service = { rpc } as any;
    const res = await mod.allocateSharedChannelWithFallback(service, 'biz-ng', 'NG');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(res.data?.channel_country).toBe('NG');
    expect(res.data?.fallback_used).toBe(false);
  });
});

// ─── JaneLux recovery scenario ───────────────────────────────────────────────

describe('JaneLux staging recovery: pending NG business with no channel', () => {
  it('allocates US channel for NG business when staging has only US shared channel', async () => {
    const mod = await loadModule('staging', true);
    // Simulates JaneLux: NG business, no NG shared channel, one US shared channel
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: { allocated: false, reason: 'no_shared_channel_for_country' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { allocated: true, channel_id: '1f3d8f48-acfb-4c4a-b788-5cc815f19173', phone_number: '12404712139' },
        error: null,
      });
    const service = { rpc } as any;
    const res = await mod.allocateSharedChannelWithFallback(
      service, 'c5454199-9d7a-45e0-bf33-5cbd8cc10ce0', 'NG',
    );
    expect(res.error).toBeNull();
    expect(res.data?.allocated).toBe(true);
    expect(res.data?.channel_country).toBe('US');
    expect(res.data?.fallback_used).toBe(true);
  });

  it('readiness check accepts US channel for NG business on staging', async () => {
    const mod = await loadModule('staging', true);
    const janeLux = { id: 'c5454199-9d7a-45e0-bf33-5cbd8cc10ce0', country_code: 'NG' };
    const usCh = { channel_type: 'shared', is_active: true, connection_status: 'active', country_code: 'US', business_id: null };
    expect(mod.isAssignedWhatsAppChannelReady(janeLux, usCh)).toBe(true);
  });

  it('WhatsApp link with bot code works after staging US allocation', async () => {
    const mod = await loadModule('staging', true);
    const janeLux = { id: 'c5454199', country_code: 'NG', bot_code: 'JANELUX', status: 'active' };
    const usCh = { channel_type: 'shared', is_active: true, connection_status: 'active', country_code: 'US', business_id: null, phone_number: '12404712139' };
    expect(mod.buildVerifiedWhatsAppLink(janeLux, usCh)).toBe('https://wa.me/12404712139?text=JANELUX');
  });

  it('JaneLux would NOT be recoverable on production (NG→US not permitted)', async () => {
    const mod = await loadModule('production');
    const janeLux = { id: 'c5454199-9d7a-45e0-bf33-5cbd8cc10ce0', country_code: 'NG' };
    const usCh = { channel_type: 'shared', is_active: true, connection_status: 'active', country_code: 'US', business_id: null };
    expect(mod.isAssignedWhatsAppChannelReady(janeLux, usCh)).toBe(false);
  });
});

// ─── Production allocation unchanged ─────────────────────────────────────────

describe('production allocation: NG does NOT fall back to US', () => {
  it('NG with no NG channel fails without trying US', async () => {
    const mod = await loadModule('production');
    const rpc = vi.fn().mockResolvedValueOnce({
      data: { allocated: false, reason: 'no_shared_channel_for_country' },
      error: null,
    });
    const service = { rpc } as any;
    const res = await mod.allocateSharedChannelWithFallback(service, 'biz-ng', 'NG');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(res.data?.allocated).toBe(false);
  });

  it('GH still falls back to NG on production (approved fallback preserved)', async () => {
    const mod = await loadModule('production');
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { allocated: false, reason: 'no_shared_channel_for_country' }, error: null })
      .mockResolvedValueOnce({ data: { allocated: true, channel_id: 'ch-ng' }, error: null });
    const service = { rpc } as any;
    const res = await mod.allocateSharedChannelWithFallback(service, 'biz-gh', 'GH');
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenNthCalledWith(2, 'allocate_shared_channel', { p_business_id: 'biz-gh', p_country_code: 'NG' });
    expect(res.data?.allocated).toBe(true);
    expect(res.data?.fallback_used).toBe(true);
  });

  it('GH does NOT try US on production', async () => {
    const mod = await loadModule('production');
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { allocated: false, reason: 'no_shared_channel_for_country' }, error: null })
      .mockResolvedValueOnce({ data: { allocated: false, reason: 'all_channels_at_capacity' }, error: null });
    const service = { rpc } as any;
    const res = await mod.allocateSharedChannelWithFallback(service, 'biz-gh', 'GH');
    expect(rpc).toHaveBeenCalledTimes(2); // GH + NG only, no US
    expect(res.data?.allocated).toBe(false);
  });
});

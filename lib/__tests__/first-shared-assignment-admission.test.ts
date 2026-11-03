/**
 * M507 first shared-number assignment — application admission.
 *
 * Proves ENABLE_FIRST_SHARED_ASSIGNMENT is a narrow, separate switch: it lets
 * signup give a business its first shared number, and it opens nothing else
 * (reassignment, repair, dedicated promotion, disconnect, admin changes stay
 * behind ENABLE_CHANNEL_ALLOCATION_OPERATIONS).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  user: vi.fn(), authFrom: vi.fn(), service: vi.fn(), from: vi.fn(), rpc: vi.fn(), fetch: vi.fn(), admin: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: m.user }, from: m.authFrom }) }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: m.service }));
vi.mock('@/lib/admin-auth', () => ({ requirePlatformAdmin: m.admin }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null, getRateLimitKey: () => 'fixture' }));

import { channelOperationsEnabled, firstSharedAssignmentEnabled } from '@/lib/channels/operation-admission';
import {
  allocateSharedChannelWithFallback, assignFirstSharedChannel, allocateSharedChannelForNewBusiness,
} from '@/lib/onboarding/whatsapp-readiness';
import { POST as onboardingVerify } from '@/app/api/onboarding/verify/route';
import { handleOnboardingComplete } from '@/app/api/whatsapp/flow-callback/onboarding';
import { POST as add } from '@/app/api/whatsapp/add-number/route';
import { POST as finish } from '@/app/api/whatsapp/add-number/finish/route';
import { POST as embedded } from '@/app/api/whatsapp/embedded-signup/route';
import { POST as callback } from '@/app/api/auth/facebook/callback/route';
import { POST as prepare } from '@/app/api/settings/whatsapp-channel/step-up/prepare/route';
import { POST as stepUpVerify } from '@/app/api/settings/whatsapp-channel/step-up/verify/route';
import { DELETE as disconnect } from '@/app/api/settings/whatsapp-channel/route';
import { GET as changeList } from '@/app/api/admin/channel-changes/route';
import { POST as preview } from '@/app/api/admin/channel-changes/preview/route';
import { POST as onboardingCreate } from '@/app/api/admin/onboarding/route';
import { POST as onboardingAction } from '@/app/api/admin/onboarding/[id]/route';
import { mutateChannelChange } from '@/lib/admin-channel-change';

const BIZ = '22222222-2222-4222-8222-222222222222';
const req = (action = '') => new NextRequest(`https://fixture.test/api/channel?action=${action}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action, stepUpId: 'step', previewHash: 'hash', business_id: BIZ }),
});
const verifyReq = () => new NextRequest('http://localhost/api/onboarding/verify', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ business_id: BIZ, plan: 'free' }),
});
function ownerRow(row: Record<string, unknown>) {
  const q: Record<string, unknown> = {};
  q.select = () => q; q.eq = () => q; q.single = async () => ({ data: row, error: null });
  return q;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ENABLE_CHANNEL_ALLOCATION_OPERATIONS', 'false');
  vi.stubEnv('ENABLE_FIRST_SHARED_ASSIGNMENT', 'false');
  vi.stubGlobal('fetch', m.fetch);
  m.user.mockResolvedValue({ data: { user: { id: 'owner' } } });
  m.admin.mockResolvedValue({ userId: 'admin', sessionId: 'session', role: 'admin' });
  m.service.mockReturnValue({ from: m.from, rpc: m.rpc });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('ENABLE_FIRST_SHARED_ASSIGNMENT switch', () => {
  it.each([undefined, '', 'false', 'TRUE', '1'])('is off for server value %s, even with a public flag', value => {
    vi.stubEnv('ENABLE_FIRST_SHARED_ASSIGNMENT', value);
    vi.stubEnv('NEXT_PUBLIC_ENABLE_FIRST_SHARED_ASSIGNMENT', 'true');
    expect(firstSharedAssignmentEnabled()).toBe(false);
  });
  it('requires the exact server opt-in and does not turn on broad channel operations', () => {
    vi.stubEnv('ENABLE_FIRST_SHARED_ASSIGNMENT', 'true');
    expect(firstSharedAssignmentEnabled()).toBe(true);
    expect(channelOperationsEnabled()).toBe(false);
  });
});

describe('with only first assignment on, every other channel operation stays unavailable', () => {
  beforeEach(() => vi.stubEnv('ENABLE_FIRST_SHARED_ASSIGNMENT', 'true'));

  it.each([
    ['add-number', add], ['add-number finish', finish], ['embedded signup', embedded], ['facebook callback', callback],
    ['step-up prepare', prepare], ['step-up verify', stepUpVerify], ['disconnect', disconnect],
    ['admin change preview', preview], ['admin change list', changeList], ['admin onboarding create', onboardingCreate],
  ] as const)('%s returns 503 before any service/provider work', async (_name, handler) => {
    const r = await handler(req());
    expect(r.status).toBe(503);
    expect(m.service).not.toHaveBeenCalled();
    expect(m.fetch).not.toHaveBeenCalled();
  });
  it.each(['ensure_shared_channel', 'retry'])('admin onboarding %s (repair path) stays unavailable', async action => {
    expect((await onboardingAction(req(action), { params: Promise.resolve({ id: 'invite' }) })).status).toBe(503);
    expect(m.from).not.toHaveBeenCalled();
  });
  it.each(['create', 'approve', 'refresh', 'execute'] as const)('admin channel change %s stays unavailable', async action => {
    expect((await mutateChannelChange(req(), action, 'approval')).status).toBe(503);
    expect(m.service).not.toHaveBeenCalled();
  });
  it('WhatsApp Flows onboarding stays unavailable (M507 covers register/verify only)', async () => {
    const r = await handleOnboardingComplete('token:2348000000000', { email: 'owner@example.com', business_name: 'X' });
    expect(r.success).toBe(false);
    expect(m.service).not.toHaveBeenCalled();
    expect(m.from).not.toHaveBeenCalled();
  });
  it('the M430 allocation/repair helper stays unavailable', async () => {
    const result = await allocateSharedChannelWithFallback({ rpc: m.rpc } as never, BIZ, 'NG', { repairStaleSharedChannel: true });
    expect(result.data).toMatchObject({ allocated: false, unavailable: true });
    expect(m.rpc).not.toHaveBeenCalled();
  });
});

describe('assignFirstSharedChannel', () => {
  it('does no database work when the switch is off', async () => {
    const result = await assignFirstSharedChannel({ rpc: m.rpc } as never, BIZ);
    expect(result.data).toMatchObject({ allocated: false, unavailable: true, reason: 'CHANNEL_OPERATIONS_UNAVAILABLE' });
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it('calls only assign_first_shared_channel with the business id (country is never caller input)', async () => {
    vi.stubEnv('ENABLE_FIRST_SHARED_ASSIGNMENT', 'true');
    m.rpc.mockResolvedValue({ data: { allocated: true, idempotent: false, channel_id: 'ch-ng' }, error: null });
    const result = await assignFirstSharedChannel({ rpc: m.rpc } as never, BIZ);
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(m.rpc).toHaveBeenCalledWith('assign_first_shared_channel', { p_business_id: BIZ });
    expect(result).toEqual({ data: { allocated: true, idempotent: false, channel_id: 'ch-ng' }, error: null });
  });
  it('passes database errors through and treats an empty result as not allocated', async () => {
    vi.stubEnv('ENABLE_FIRST_SHARED_ASSIGNMENT', 'true');
    m.rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    expect(await assignFirstSharedChannel({ rpc: m.rpc } as never, BIZ)).toEqual({ data: null, error: { message: 'boom' } });
    m.rpc.mockResolvedValueOnce({ data: null, error: null });
    expect((await assignFirstSharedChannel({ rpc: m.rpc } as never, BIZ)).data).toEqual({ allocated: false, reason: 'empty_rpc_response' });
  });
});

describe('allocateSharedChannelForNewBusiness picks the path from the switches', () => {
  it('broad channel operations (staging) keep the existing M430 path', async () => {
    vi.stubEnv('ENABLE_CHANNEL_ALLOCATION_OPERATIONS', 'true');
    vi.stubEnv('ENABLE_FIRST_SHARED_ASSIGNMENT', 'true');
    m.rpc.mockResolvedValue({ data: { allocated: true, idempotent: false, channel_id: 'ch' }, error: null });
    await allocateSharedChannelForNewBusiness({ rpc: m.rpc } as never, BIZ, 'NG');
    expect(m.rpc.mock.calls.map(c => c[0])).toEqual(['allocate_shared_channel']);
  });
  it('first assignment only (production) uses the M507 function', async () => {
    vi.stubEnv('ENABLE_FIRST_SHARED_ASSIGNMENT', 'true');
    m.rpc.mockResolvedValue({ data: { allocated: true, idempotent: false, channel_id: 'ch' }, error: null });
    await allocateSharedChannelForNewBusiness({ rpc: m.rpc } as never, BIZ, 'NG');
    expect(m.rpc.mock.calls.map(c => c[0])).toEqual(['assign_first_shared_channel']);
  });
  it('neither switch: unavailable, no database work', async () => {
    const r = await allocateSharedChannelForNewBusiness({ rpc: m.rpc } as never, BIZ, 'NG');
    expect(r.data).toMatchObject({ allocated: false, unavailable: true });
    expect(m.rpc).not.toHaveBeenCalled();
  });
});

describe('onboarding verify gate for a shared business with no number', () => {
  beforeEach(() => {
    m.authFrom.mockImplementation(() => ownerRow({ owner_id: 'owner', subscription_tier: 'free', wa_method: 'shared', assigned_channel_id: null }));
  });

  it('both switches off: unchanged 503 CHANNEL_OPERATIONS_UNAVAILABLE, no database work', async () => {
    const r = await onboardingVerify(verifyReq());
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe('CHANNEL_OPERATIONS_UNAVAILABLE');
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.from).not.toHaveBeenCalled();
  });

  it('first assignment on but no eligible number: 503 WHATSAPP_NUMBER_UNAVAILABLE, nothing activated', async () => {
    vi.stubEnv('ENABLE_FIRST_SHARED_ASSIGNMENT', 'true');
    m.rpc.mockResolvedValue({ data: { allocated: false, reason: 'no_shared_channel_for_country' }, error: null });
    const r = await onboardingVerify(verifyReq());
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe('WHATSAPP_NUMBER_UNAVAILABLE');
    expect(m.rpc).toHaveBeenCalledWith('assign_first_shared_channel', { p_business_id: BIZ });
    expect(m.from).not.toHaveBeenCalled();
  });

  it('first assignment on and a number assigned: continues past the gate to setup checks', async () => {
    vi.stubEnv('ENABLE_FIRST_SHARED_ASSIGNMENT', 'true');
    m.rpc.mockResolvedValue({ data: { allocated: true, idempotent: false, channel_id: 'ch-ng' }, error: null });
    m.from.mockImplementation((table: string) => {
      // First service read after the gate is the setup-complete capability check.
      expect(table).toBe('business_capabilities');
      throw new Error('stop-after-gate');
    });
    const r = await onboardingVerify(verifyReq());
    expect(m.rpc).toHaveBeenCalledWith('assign_first_shared_channel', { p_business_id: BIZ });
    expect(m.from).toHaveBeenCalledWith('business_capabilities');
    expect(r.status).not.toBe(503);
  });

  it('a business that already has a number skips assignment entirely', async () => {
    vi.stubEnv('ENABLE_FIRST_SHARED_ASSIGNMENT', 'true');
    m.authFrom.mockImplementation(() => ownerRow({ owner_id: 'owner', subscription_tier: 'free', wa_method: 'shared', assigned_channel_id: 'ch-ng' }));
    m.from.mockImplementation(() => { throw new Error('stop-after-gate'); });
    await onboardingVerify(verifyReq());
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('another owner cannot trigger assignment', async () => {
    vi.stubEnv('ENABLE_FIRST_SHARED_ASSIGNMENT', 'true');
    m.authFrom.mockImplementation(() => ownerRow({ owner_id: 'someone-else', subscription_tier: 'free', wa_method: 'shared', assigned_channel_id: null }));
    const r = await onboardingVerify(verifyReq());
    expect(r.status).toBe(403);
    expect(m.rpc).not.toHaveBeenCalled();
  });
});

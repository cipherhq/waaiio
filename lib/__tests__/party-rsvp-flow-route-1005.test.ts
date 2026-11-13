import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// #1005 PR 3c: the admin publish route. Platform admins or the cron secret only, with no local
// bypass; the platform account from server env; rate limited; never cached.
const mocks = vi.hoisted(() => ({ admin: vi.fn(), publish: vi.fn(), status: vi.fn(), limited: vi.fn(), assets: vi.fn() }));
vi.mock('@/lib/admin-auth', () => ({ requirePlatformAdmin: mocks.admin }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: mocks.limited }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ db: true }) }));
vi.mock('@/lib/channels/meta-cloud', () => ({ MetaCloudService: class { partyRsvpFlowAssets = mocks.assets; } }));
vi.mock('@/lib/parties/rsvp-flow-publisher', () => ({ publishPartyRsvpFlow: mocks.publish, partyRsvpFlowPublicationStatus: mocks.status }));
import { GET, POST } from '@/app/api/admin/party-rsvp-flow/route';

const req = (method: string, headers: Record<string, string> = {}, body?: unknown) =>
  new Request('http://x/api/admin/party-rsvp-flow', { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }) as never;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('META_CLOUD_WABA_ID', '555000'); vi.stubEnv('META_CLOUD_ACCESS_TOKEN', 'token-value');
  vi.stubEnv('CRON_SECRET', 'c'.repeat(32));
  mocks.limited.mockResolvedValue(null);
  mocks.assets.mockReturnValue({ assets: true });
  mocks.publish.mockResolvedValue({ status: 'published', publicationId: 'p', metaFlowId: '9', alreadyPublished: false });
  mocks.status.mockResolvedValue({ enabled: true, revision: 'r', publication: null });
});
afterEach(() => vi.unstubAllEnvs());

describe('/api/admin/party-rsvp-flow', () => {
  it('refuses anyone who is not a platform admin or the cron secret, and never touches Meta', async () => {
    mocks.admin.mockResolvedValue(null);
    expect((await POST(req('POST', { authorization: 'Bearer wrong' }))).status).toBe(403);
    expect((await GET(req('GET'))).status).toBe(403);
    expect(mocks.admin).toHaveBeenCalledWith(expect.anything(), { requiredRole: 'admin' });
    expect(mocks.publish).not.toHaveBeenCalled(); expect(mocks.status).not.toHaveBeenCalled();
  });

  it('has no local bypass when the cron secret is unset', async () => {
    vi.stubEnv('CRON_SECRET', ''); mocks.admin.mockResolvedValue(null);
    expect((await POST(req('POST'))).status).toBe(403);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('the cron secret or an admin publishes on the platform account; resume only when asked', async () => {
    const res = await POST(req('POST', { authorization: `Bearer ${'c'.repeat(32)}` }));
    expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('no-store');
    expect(mocks.assets).toHaveBeenCalledWith('555000');
    expect(mocks.publish).toHaveBeenCalledWith({ db: true }, '555000', { assets: true }, { resume: false });
    mocks.admin.mockResolvedValue({ id: 'admin' });
    await POST(req('POST', { authorization: 'Bearer admin-jwt' }, { resume: true }));
    expect(mocks.publish).toHaveBeenLastCalledWith({ db: true }, '555000', { assets: true }, { resume: true });
    await POST(req('POST', { authorization: 'Bearer admin-jwt' }, { resume: 'yes' }));
    expect(mocks.publish).toHaveBeenLastCalledWith({ db: true }, '555000', { assets: true }, { resume: false });
  });

  it('maps outcomes to status codes and is rate limited', async () => {
    mocks.admin.mockResolvedValue({ id: 'admin' });
    mocks.publish.mockResolvedValueOnce({ status: 'needs_review', publicationId: 'p', reason: 'x' });
    expect((await POST(req('POST'))).status).toBe(409);
    mocks.publish.mockResolvedValueOnce({ status: 'not_enabled' });
    expect((await POST(req('POST'))).status).toBe(503);
    mocks.limited.mockResolvedValueOnce(new Response('slow down', { status: 429 }));
    expect((await POST(req('POST'))).status).toBe(429);
    expect(mocks.limited).toHaveBeenLastCalledWith('party-rsvp-flow-publish:555000', 3, 60_000);
  });

  it('needs the platform account configured; GET is read-only status', async () => {
    mocks.admin.mockResolvedValue({ id: 'admin' });
    const status = await GET(req('GET'));
    expect(await status.json()).toEqual({ enabled: true, revision: 'r', publication: null });
    expect(mocks.publish).not.toHaveBeenCalled(); expect(mocks.assets).not.toHaveBeenCalled();
    vi.stubEnv('META_CLOUD_WABA_ID', '');
    expect((await POST(req('POST'))).status).toBe(503);
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});

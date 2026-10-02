/**
 * Issue #512: Site Announcement optimistic concurrency.
 *
 * Regression coverage for the lost-update bug where a stale Admin form could
 * overwrite newer fields in platform_settings.site_announcement, plus the
 * staging regression where a cached GET version made fresh forms look stale.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: vi.fn(),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(),
}));

const BASE_CONFIG = {
  enabled: true,
  type: 'launch_countdown',
  headline: 'Waaiio is launching October 30 🎉',
  message: 'Waaiio is almost here.',
  target_date: '2026-10-30T16:00:00.000Z',
  cta_text: 'Get Launch Updates',
  cta_link: '/get-started',
  style: 'brand',
} as const;

const EXPECTED_VERSION = '2026-10-02T10:43:29.454Z';
const NEXT_VERSION = '2026-10-02T11:00:00.000Z';

async function setupAdmin() {
  const { requirePlatformAdmin } = await import('@/lib/admin-auth');
  vi.mocked(requirePlatformAdmin).mockResolvedValue({
    id: 'admin-uuid',
    userId: 'admin-uuid',
    email: 'admin@test.com',
    role: 'admin',
  } as any);
}

async function setupCasResult(data: unknown, error: unknown = null) {
  const { createServiceClient } = await import('@/lib/supabase/service');

  const maybeSingle = vi.fn().mockResolvedValue({ data, error });
  const select = vi.fn().mockReturnValue({ maybeSingle });
  const eqUpdatedAt = vi.fn().mockReturnValue({ select });
  const eqKey = vi.fn().mockReturnValue({ eq: eqUpdatedAt });
  const update = vi.fn().mockReturnValue({ eq: eqKey });
  const from = vi.fn().mockReturnValue({ update });

  vi.mocked(createServiceClient).mockReturnValue({ from } as any);

  return { from, update, eqKey, eqUpdatedAt, select, maybeSingle };
}

function createGetClient(data: unknown, error: unknown = null) {
  const single = vi.fn().mockResolvedValue({ data, error });
  const eq = vi.fn().mockReturnValue({ single });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  return { client: { from } as any, from, select, eq, single };
}

function makeGetRequest() {
  return new Request('http://localhost/api/admin/site-announcement', {
    method: 'GET',
  });
}

function makePutRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/admin/site-announcement', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Issue #512: Site Announcement route optimistic concurrency', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('fresh GET bypasses the data cache and observes a newer DB version on the next read', async () => {
    await setupAdmin();
    const { createServiceClient } = await import('@/lib/supabase/service');

    const first = createGetClient({
      value: BASE_CONFIG,
      updated_at: EXPECTED_VERSION,
    });
    const second = createGetClient({
      value: { ...BASE_CONFIG, message: 'Updated elsewhere.' },
      updated_at: NEXT_VERSION,
    });

    vi.mocked(createServiceClient)
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);

    const route = await import('@/app/api/admin/site-announcement/route');

    const firstResponse = await route.GET(makeGetRequest() as any);
    expect(firstResponse.status).toBe(200);
    expect(await firstResponse.json()).toEqual({
      config: BASE_CONFIG,
      updated_at: EXPECTED_VERSION,
    });

    const secondResponse = await route.GET(makeGetRequest() as any);
    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.json()).toEqual({
      config: { ...BASE_CONFIG, message: 'Updated elsewhere.' },
      updated_at: NEXT_VERSION,
    });

    expect(createServiceClient).toHaveBeenNthCalledWith(1, { noStore: true });
    expect(createServiceClient).toHaveBeenNthCalledWith(2, { noStore: true });
    expect(route.fetchCache).toBe('force-no-store');
    expect(route.revalidate).toBe(0);
  });

  it('fresh save uses expected_updated_at as an atomic predicate and returns canonical config + new version', async () => {
    await setupAdmin();
    const canonicalConfig = { ...BASE_CONFIG, message: 'Canonical saved message.' };
    const mocks = await setupCasResult({
      value: canonicalConfig,
      updated_at: NEXT_VERSION,
    });

    const { PUT } = await import('@/app/api/admin/site-announcement/route');
    const response = await PUT(makePutRequest({
      ...BASE_CONFIG,
      expected_updated_at: EXPECTED_VERSION,
    }) as any);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      success: true,
      config: canonicalConfig,
      updated_at: NEXT_VERSION,
    });

    expect(mocks.from).toHaveBeenCalledWith('platform_settings');
    expect(mocks.eqKey).toHaveBeenCalledWith('key', 'site_announcement');
    expect(mocks.eqUpdatedAt).toHaveBeenCalledWith('updated_at', EXPECTED_VERSION);
    expect(mocks.select).toHaveBeenCalledWith('value, updated_at');
    expect(mocks.maybeSingle).toHaveBeenCalledTimes(1);
  });

  it('stale save returns 409 and never reports success', async () => {
    await setupAdmin();
    await setupCasResult(null, null);

    const { PUT } = await import('@/app/api/admin/site-announcement/route');
    const response = await PUT(makePutRequest({
      ...BASE_CONFIG,
      headline: 'Stale headline',
      expected_updated_at: EXPECTED_VERSION,
    }) as any);

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe('STALE_WRITE');
    expect(body.error).toContain('updated elsewhere');
    expect(body.success).not.toBe(true);
  });

  it('fails closed when expected_updated_at is missing', async () => {
    await setupAdmin();
    const { createServiceClient } = await import('@/lib/supabase/service');

    const { PUT } = await import('@/app/api/admin/site-announcement/route');
    const response = await PUT(makePutRequest({ ...BASE_CONFIG }) as any);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('expected_updated_at');
    expect(createServiceClient).not.toHaveBeenCalled();
  });

  it('fails closed when expected_updated_at is invalid', async () => {
    await setupAdmin();
    const { createServiceClient } = await import('@/lib/supabase/service');

    const { PUT } = await import('@/app/api/admin/site-announcement/route');
    const response = await PUT(makePutRequest({
      ...BASE_CONFIG,
      expected_updated_at: 'not-a-timestamp',
    }) as any);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('valid timestamp');
    expect(createServiceClient).not.toHaveBeenCalled();
  });

  it('returns 500 on database failure rather than treating it as a stale conflict', async () => {
    await setupAdmin();
    await setupCasResult(null, { message: 'database unavailable' });

    const { PUT } = await import('@/app/api/admin/site-announcement/route');
    const response = await PUT(makePutRequest({
      ...BASE_CONFIG,
      expected_updated_at: EXPECTED_VERSION,
    }) as any);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('Failed to update announcement');
  });
});

describe('Issue #512: Admin client version contract', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'admin/src/pages/SiteAnnouncement.tsx'),
    'utf8',
  );

  it('stores updated_at returned by GET', () => {
    expect(source).toContain("setVersion(typeof json.updated_at === 'string' ? json.updated_at : null)");
  });

  it('sends expected_updated_at on every persistence call', () => {
    expect(source).toContain('expected_updated_at: version');
  });

  it('adopts canonical config and the new version after successful persistence', () => {
    expect(source).toContain('setConfig(result.config)');
    expect(source).toContain('setVersion(result.updatedAt)');
  });

  it('does not silently retry without a version token', () => {
    expect(source).toContain('Unable to verify the current announcement version. Reload the page before saving.');
  });
});

describe('Issue #512: no-store service client contract', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'lib/supabase/service.ts'),
    'utf8',
  );

  it('forces cache no-store when a route opts into fresh service reads', () => {
    expect(source).toContain("cache: 'no-store'");
  });
});

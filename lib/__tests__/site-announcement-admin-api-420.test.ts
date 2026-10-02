import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { updateCalls, requirePlatformAdminMock } = vi.hoisted(() => {
  const updateCalls: unknown[] = [];
  const requirePlatformAdminMock = vi.fn();
  return { updateCalls, requirePlatformAdminMock };
});

vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: requirePlatformAdminMock,
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: vi.fn(() => ({
      update: vi.fn((payload: unknown) => {
        updateCalls.push(payload);
        const p = payload as Record<string, unknown>;
        return {
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              select: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: { value: p.value, updated_at: new Date().toISOString() },
                  error: null,
                })),
              })),
            })),
          })),
        };
      }),
    })),
  }),
}));

import { PUT } from '@/app/api/admin/site-announcement/route';

function request(body: unknown) {
  return new NextRequest('http://localhost/api/admin/site-announcement', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('#420 Admin site announcement API activation safety', () => {
  beforeEach(() => {
    updateCalls.length = 0;
    requirePlatformAdminMock.mockReset();
    requirePlatformAdminMock.mockResolvedValue({ userId: 'admin-420' });
  });

  it('rejects enabling a countdown with no target/headline and performs no update', async () => {
    const response = await PUT(request({
      enabled: true,
      type: 'launch_countdown',
      headline: '',
      message: '',
      target_date: null,
      cta_text: null,
      cta_link: null,
      style: 'brand',
    }));

    expect(response.status).toBe(400);
    expect(updateCalls).toHaveLength(0);
    const body = await response.json();
    expect(body.error).toMatch(/Headline is required|target date\/time is required/i);
  });

  it('rejects CTA text/link mismatch before persistence', async () => {
    const response = await PUT(request({
      enabled: false,
      type: 'general',
      headline: 'Draft',
      message: '',
      target_date: null,
      cta_text: 'Learn More',
      cta_link: null,
      style: 'brand',
    }));

    expect(response.status).toBe(400);
    expect(updateCalls).toHaveLength(0);
    expect((await response.json()).error).toContain('CTA text and CTA link');
  });

  it('persists a valid future countdown without changing its UTC target', async () => {
    const target = '2099-10-11T16:00:00.000Z';
    const response = await PUT(request({
      enabled: true,
      type: 'launch_countdown',
      headline: 'Waaiio launches soon',
      message: 'Launch updates',
      target_date: target,
      cta_text: 'Get Updates',
      cta_link: '/launch',
      style: 'brand',
      expected_updated_at: '2026-10-02T10:00:00.000Z',
    }));

    expect(response.status).toBe(200);
    expect(updateCalls).toHaveLength(1);
    const payload = updateCalls[0] as { value: { target_date: string; enabled: boolean } };
    expect(payload.value.target_date).toBe(target);
    expect(payload.value.enabled).toBe(true);
  });

  it('fails closed for non-admin callers', async () => {
    requirePlatformAdminMock.mockResolvedValueOnce(null);

    const response = await PUT(request({ enabled: false }));

    expect(response.status).toBe(403);
    expect(updateCalls).toHaveLength(0);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ admin: vi.fn(), client: vi.fn(), readiness: vi.fn(), actual: vi.fn(), deliver: vi.fn(), counts: vi.fn(), load: vi.fn(), send: vi.fn() }));
vi.mock('@/lib/admin-auth', () => ({ requirePlatformAdmin: m.admin }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: m.client }));
vi.mock('@/lib/launch/template-readiness', () => ({ assertLaunchReadiness: m.readiness, assertLaunchTemplate: m.actual }));
vi.mock('@/lib/launch/delivery', async (original) => ({ ...await original<typeof import('../delivery')>(), getDeliveryReadiness: m.counts, loadDeliveryConfig: m.load, deliverLaunchNotifications: m.deliver, metaCloudSendTemplate: m.send }));
import { GET, POST } from '@/app/api/admin/launch-notify/route';
import { LaunchConfigError } from '../delivery';
const insert = vi.fn(); const rpc = vi.fn();
const req = (post = false) => new NextRequest('https://example.test/api/admin/launch-notify?retryOnly=true&limit=5', post ? { method: 'POST', body: JSON.stringify({ confirmToken: 'token', retryOnly: true, limit: 5 }) } : undefined);
beforeEach(() => {
  vi.resetAllMocks();
  m.admin.mockResolvedValue({ userId: 'admin' });
  m.load.mockResolvedValue({ templateName: 'launch', templateLanguage: 'en_US', templateParams: [], campaignVersion: 'v1' });
  m.counts.mockResolvedValue({ eligible: 5, pending: 5, sent: 0, failed: 5, skipped: 0, opted_out: 0 });
  insert.mockReturnValue({ select: () => ({ single: async () => ({ data: { token: 'token' } }) }) });
  rpc.mockResolvedValue({ data: { consumed: true, retry_only: true, send_limit: 5 } });
  m.client.mockReturnValue({ from: () => ({ insert }), rpc });
  m.deliver.mockResolvedValue({ total: 5, sent: 5, failed: 0, skipped: 0 });
});
describe('launch route readiness gates', () => {
  it('blocks preview before confirmation insert when template is absent', async () => {
    m.readiness.mockRejectedValue(new LaunchConfigError('Missing approved template'));
    expect((await GET(req())).status).toBe(422);
    expect(insert).not.toHaveBeenCalled(); expect(m.deliver).not.toHaveBeenCalled();
  });
  it('creates scoped confirmation on approved readiness and exposes retry count', async () => {
    const response = await GET(req());
    expect(response.status).toBe(200);
    expect((await response.json()).readiness.pending).toBe(5);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ retry_only: true, send_limit: 5, pending_count: 5 }));
  });
  it('rechecks provider readiness after preview and blocks delivery if it changed', async () => {
    expect((await GET(req())).status).toBe(200);
    m.readiness.mockRejectedValue(new LaunchConfigError('No longer approved'));
    expect((await POST(req(true))).status).toBe(422);
    expect(m.deliver).not.toHaveBeenCalled(); expect(m.send).not.toHaveBeenCalled();
  });
  it('delivers only after confirmation and readiness, with actual-sender validation', async () => {
    expect((await POST(req(true))).status).toBe(200);
    const send = m.deliver.mock.calls[0][2];
    m.actual.mockRejectedValue(new LaunchConfigError('Sender changed'));
    await expect(send({}, 'recipient', 'launch', 'en_US', [])).rejects.toThrow('Sender changed');
    expect(m.send).not.toHaveBeenCalled();
    m.actual.mockResolvedValue(undefined);
    await send({}, 'recipient', 'launch', 'en_US', []);
    expect(m.send).toHaveBeenCalledTimes(1);
  });
  it('denies unauthenticated requests before database or provider access', async () => {
    m.admin.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(403); expect((await POST(req(true))).status).toBe(403);
    expect(m.client).not.toHaveBeenCalled(); expect(m.readiness).not.toHaveBeenCalled();
  });
  it('does not reach readiness or delivery for invalid confirmation', async () => {
    rpc.mockResolvedValue({ data: { consumed: false, reason: 'wrong_admin' } });
    expect((await POST(req(true))).status).toBe(403);
    expect(m.readiness).not.toHaveBeenCalled(); expect(m.deliver).not.toHaveBeenCalled();
  });
});

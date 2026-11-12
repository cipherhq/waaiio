import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
const mocks = vi.hoisted(() => ({ catalog: vi.fn() }));
vi.mock('@/lib/channels/meta-cloud', () => ({ MetaCloudService: class { getTemplates = mocks.catalog; } }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
import { assertLaunchTemplate } from '../template-readiness';
import { getLaunchCandidates, getDeliveryReadiness, claimAndSendToSubscriber } from '../delivery';
const config = { templateName: 'launch', templateLanguage: 'en_US', templateParams: [], campaignVersion: 'v1' };
const credentials = { phone_number_id: 'sender', meta_access_token: 'secret', waba_id: 'account', phone_number: '123' };
const approved = { name: 'launch', language: 'en_US', status: 'APPROVED' };
beforeEach(() => vi.clearAllMocks());
describe('provider template readiness', () => {
  it('accepts only the exact approved template', async () => {
    mocks.catalog.mockResolvedValue({ data: [approved] });
    await expect(assertLaunchTemplate(credentials, config)).resolves.toBeUndefined();
  });
  it.each([{ data: [] }, { data: [{ ...approved, language: 'en' }] }, { data: [{ ...approved, status: 'PAUSED' }] }, { data: [{ ...approved, name: 'other' }] }])('blocks mismatched catalog %j', async (entry) => {
    mocks.catalog.mockResolvedValue(entry);
    await expect(assertLaunchTemplate(credentials, config)).rejects.toThrow('missing or not approved');
  });
  it('follows pagination', async () => {
    mocks.catalog.mockResolvedValueOnce({ data: [], paging: { next: 'next', cursors: { after: 'cursor' } } }).mockResolvedValueOnce({ data: [approved] });
    await assertLaunchTemplate(credentials, config);
    expect(mocks.catalog).toHaveBeenLastCalledWith(expect.objectContaining({ after: 'cursor' }));
  });
  it('fails closed without exposing provider errors', async () => {
    mocks.catalog.mockRejectedValue(new Error('secret token'));
    await expect(assertLaunchTemplate(credentials, config)).rejects.toThrow('Unable to verify');
    await expect(assertLaunchTemplate(credentials, config)).rejects.not.toThrow('secret');
  });
  it('rejects repeated pagination cursors', async () => {
    mocks.catalog.mockResolvedValue({ data: [], paging: { next: 'next', cursors: { after: 'same' } } });
    await expect(assertLaunchTemplate(credentials, config)).rejects.toThrow('Unable to verify');
    expect(mocks.catalog).toHaveBeenCalledTimes(2);
  });
});
function database(rows: Record<string, unknown>[], error: unknown = null) {
  const limits: number[] = [];
  const db = { from: vi.fn(() => {
    let selected = rows; let limit = Infinity;
    const query: any = {
      select: () => query,
      eq: (key: string, value: unknown) => { selected = selected.filter(r => r[key] === value); return query; },
      in: (key: string, values: unknown[]) => { selected = selected.filter(r => values.includes(r[key])); return query; },
      order: () => query,
      limit: (n: number) => { limit = n; limits.push(n); return query; },
      then: (resolve: (v: unknown) => void) => resolve({ data: selected.slice(0, limit), error }),
    }; return query;
  }) };
  return { db: db as unknown as SupabaseClient, limits };
}
describe('preview and delivery candidates', () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => ({ id: String(i), receiving_number: 'sender', opt_in_status: 'active', notification_status: 'failed', campaign_version: 'v1' })),
    { id: 'sent', opt_in_status: 'active', notification_status: 'sent', campaign_version: 'v1' },
    { id: 'out', opt_in_status: 'opted_out', notification_status: 'failed', campaign_version: 'v1' },
    { id: 'old', opt_in_status: 'active', notification_status: 'failed', campaign_version: 'old' },
  ];
  it('includes all five same-campaign failures in retry preview, excluding sent/opted-out/other campaigns', async () => {
    const { db } = database(rows);
    expect((await getDeliveryReadiness(db, 'v1', { retryOnly: true })).pending).toBe(5);
    expect((await getLaunchCandidates(db, 'v1', { retryOnly: true })).map(r => r.id)).toEqual(['0', '1', '2', '3', '4']);
  });
  it('enforces explicit and default limits', async () => {
    const { db, limits } = database(rows);
    expect(await getLaunchCandidates(db, 'v1', { limit: 2 })).toHaveLength(2);
    await getLaunchCandidates(db, 'v1');
    expect(limits).toEqual([2, 100]);
  });
  it('does not interpret database errors as an empty audience', async () => {
    const { db } = database([], { message: 'private details' });
    await expect(getLaunchCandidates(db, 'v1')).rejects.toThrow('Unable to verify');
  });
  it('completes a claimed recipient as failed if sender lookup fails, without sending', async () => {
    const query: any = { select: () => query, eq: () => query, limit: () => query, maybeSingle: async () => ({ data: null, error: { message: 'private' } }) };
    const rpc = vi.fn().mockResolvedValueOnce({ data: { claimed: true, claim_token: 'claim', wa_number: 'recipient', receiving_number: 'sender' } }).mockResolvedValue({ data: { completed: true } });
    const send = vi.fn();
    const result = await claimAndSendToSubscriber({ from: () => query, rpc } as unknown as SupabaseClient, 'subscriber', config, send);
    expect(result.status).toBe('failed');
    expect(send).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenLastCalledWith('complete_launch_delivery', expect.objectContaining({ p_claim_token: 'claim', p_status: 'failed' }));
  });
});

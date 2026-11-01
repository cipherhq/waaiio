import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHash } from 'crypto';
const mocks = vi.hoisted(() => ({ admin: vi.fn(), service: vi.fn(), prepare: vi.fn() }));
vi.mock('@/lib/admin-auth', () => ({ requirePlatformAdmin: mocks.admin }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: mocks.service }));
vi.mock('@/lib/admin-audit', () => ({ logAdminAudit: vi.fn() }));
vi.mock('@/lib/admin-step-up', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/admin-step-up')>(), prepareStepUp: mocks.prepare }));
import { POST as preview } from '@/app/api/admin/channel-changes/preview/route';
import { GET, POST as create } from '@/app/api/admin/channel-changes/route';
import { POST as approve } from '@/app/api/admin/channel-changes/[id]/approve/route';
import { POST as refresh } from '@/app/api/admin/channel-changes/[id]/re-request/route';
import { POST as execute } from '@/app/api/admin/channel-changes/[id]/execute/route';
import { POST as reject } from '@/app/api/admin/channel-changes/[id]/reject/route';
import { POST as prepare } from '@/app/api/admin/step-up/prepare/route';
import { hashOperationParams, stableStringify } from '@/lib/admin-step-up';

const admin = { userId: 'admin-a', sessionId: 'private-session', role: 'admin', aal: 'aal2' };
const details = { request_type: 'recovery', target_action: 'promote_candidate', target_candidate_id: 'candidate-1', reason: 'Réverification ✓' };
const operation = {
  business_id: 'business-1', request_version: 1, ...details,
  target_snapshot: { phone_number_normalized: '+234123456789', status: 'ready', access_token: 'never-show-token' },
  verification_record: { owner_reverified: true, notes: 'private-notes', evidence_refs: [{ type: 'business_document', document_id: 'doc-1', snapshot: { status: 'approved', file_url: 'private-url', source_fingerprint: 'private-fingerprint' } }] },
};
let rpc: ReturnType<typeof vi.fn>;
let descriptorFailure = false;
let mutationFailure = false;
let version = 1;
let selected = '';
let filters: Array<[string, unknown]> = [];
let updateBody: unknown;
function descriptor(args: Record<string, unknown>) {
  return { action: args.p_action, actor_user_id: args.p_actor_id, session_id: args.p_session_id, approval_id: args.p_approval_id,
    prior_version: args.p_action === 'refresh' ? 1 : null, review_confirmed: args.p_action === 'approve', operation: { ...operation, request_version: version } };
}
function req(body: unknown, method = 'POST') {
  return new NextRequest('https://waaiio.test/api/admin/channel-changes', { method, headers: { 'Content-Type': 'application/json', Origin: 'https://admin.waaiio.com' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
}
const context = { params: Promise.resolve({ id: 'approval-1' }) };
async function previewFor(action = 'create') {
  const input = { action, ...(action === 'create' ? { business_id: 'business-1' } : { approval_id: 'approval-1' }), details: action === 'approve' ? { review_confirmed: true } : details };
  const response = await preview(req(input));
  return { input, data: await response.json(), response };
}
beforeEach(() => {
  vi.clearAllMocks(); descriptorFailure = false; mutationFailure = false; version = 1; selected = ''; filters = []; updateBody = undefined;
  mocks.admin.mockResolvedValue(admin);
  mocks.prepare.mockResolvedValue({ stepUpId: 'step-1', challengeId: 'challenge-1', factorId: 'factor-1' });
  rpc = vi.fn(async (name, args) => {
    if (name === 'channel_change_action_descriptor') return { data: descriptorFailure ? null : descriptor(args), error: descriptorFailure ? { message: 'secret internal error' } : null };
    return { data: mutationFailure ? null : { ok: true, id: 'approval-1', new_channel_id: 'channel-1' }, error: mutationFailure ? { message: 'step_up_stale private-session' } : null };
  });
  mocks.service.mockReturnValue({ rpc, from: vi.fn(() => {
    const query = { select: vi.fn((columns: string) => { selected = columns; return query; }), order: vi.fn(() => query), limit: vi.fn(() => query), eq: vi.fn((key, value) => { filters.push([key, value]); return query; }), in: vi.fn(() => query), update: vi.fn(value => { updateBody = value; return query; }), maybeSingle: async () => ({ data: { id: 'approval-1', request_type: 'recovery', business_id: 'business-1' }, error: null }), then: (resolve: (result: unknown) => unknown) => Promise.resolve({ data: [{ id: 'approval-1', ...operation }], error: null }).then(resolve) };
    return query;
  }) });
});

describe('channel change actual HTTP handlers', () => {
  it.each(['preview', 'create', 'approve', 'refresh', 'execute', 'reject', 'list'])('denies unauthenticated %s before service access', async route => {
    mocks.admin.mockResolvedValue(null);
    const response = route === 'list' ? await GET(req(null, 'GET')) : await ({ preview, create, approve, refresh, execute, reject }[route as 'preview'])(req({}), context);
    expect(response.status).toBe(403); expect(mocks.service).not.toHaveBeenCalled();
  });
  it('preview uses verified actor/session and returns only safe evidence and destination', async () => {
    const response = await preview(req({ action: 'create', business_id: 'business-1', details, actor_id: 'attacker', session_id: 'attacker-session' }));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.operation.target_candidate_id).toBe('candidate-1');
    expect(data.operation.verification_record.evidence_refs[0].snapshot.status).toBe('approved');
    expect(JSON.stringify(data)).not.toMatch(/private-session|never-show-token|private-url|private-fingerprint|private-notes/);
    expect(rpc).toHaveBeenCalledWith('channel_change_action_descriptor', expect.objectContaining({ p_actor_id: 'admin-a', p_session_id: 'private-session' }));
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://admin.waaiio.com');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it.each(['create', 'approve', 'refresh', 'execute'])('prepares and atomically executes the same UTF8 serialized %s envelope', async action => {
    const { input, data } = await previewFor(action);
    const prepared = await prepare(req({ actionType: data.actionType, targetId: data.targetId, params: { channel_change: input, previewHash: data.previewHash } }));
    expect(prepared.status).toBe(200);
    const envelope = mocks.prepare.mock.calls[0][3];
    const response = action === 'create' ? await create(req({ ...details, business_id: 'business-1', stepUpId: 'step-1', previewHash: data.previewHash }))
      : await ({ approve, refresh, execute }[action as 'approve'])(req({ stepUpId: 'step-1', previewHash: data.previewHash, review_confirmed: true }), context);
    expect(response.status).toBe(200);
    const call = rpc.mock.calls.at(-1)!;
    expect(call[0]).toBe(action === 'execute' ? 'execute_channel_change_approval' : 'mutate_channel_change_approval');
    const text = call[1][action === 'execute' ? 'p_executor_authorized_text' : 'p_authorized_text'];
    expect(text).toBe(stableStringify(envelope));
    expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(hashOperationParams(envelope));
    expect(call[1]).not.toHaveProperty('p_executor_params_hash');
    expect(mocks.service().from).not.toHaveBeenCalled();
  });
  it('denies stale preview before MFA prepare or mutation', async () => {
    const { input, data } = await previewFor(); version = 2;
    const response = await prepare(req({ actionType: data.actionType, targetId: data.targetId, params: { channel_change: input, previewHash: data.previewHash } }));
    expect(response.status).toBe(409); expect(mocks.prepare).not.toHaveBeenCalled();
    expect((await create(req({ ...details, business_id: 'business-1', stepUpId: 'step-1', previewHash: data.previewHash }))).status).toBe(409);
    expect(rpc.mock.calls.every(call => call[0] === 'channel_change_action_descriptor')).toBe(true);
  });
  it('returns a reload conflict for expired SQL authorization without exposing SQL text', async () => {
    const { data } = await previewFor('execute'); mutationFailure = true;
    const response = await execute(req({ stepUpId: 'step-1', previewHash: data.previewHash }), context);
    expect(response.status).toBe(409); expect(JSON.stringify(await response.json())).not.toContain('private-session');
  });
  it('denies missing session, missing step-up, and failed descriptor', async () => {
    mocks.admin.mockResolvedValue({ ...admin, sessionId: undefined });
    expect((await preview(req({ action: 'create' }))).status).toBe(403);
    mocks.admin.mockResolvedValue(admin);
    expect((await create(req({}))).status).toBe(403);
    descriptorFailure = true;
    expect((await previewFor()).response.status).toBe(409);
  });
  it('lists explicit display fields and sanitizes verification snapshots', async () => {
    const response = await GET(req(null, 'GET'));
    expect(response.status).toBe(200);
    expect(selected).not.toMatch(/\*|session_id|authorized_text|operation_descriptor/);
    expect(JSON.stringify(await response.json())).not.toMatch(/private-url|private-notes|private-fingerprint/);
  });
  it('scopes cancellation to the requester and returns admin CORS headers', async () => {
    const response = await reject(req({ action: 'cancel' }), context);
    expect(response.status).toBe(200);
    expect(filters).toContainEqual(['requester_admin_id', 'admin-a']);
    expect(updateBody).toEqual({ status: 'cancelled' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://admin.waaiio.com');
  });
  it('rejects unknown terminal actions without a write', async () => {
    expect((await reject(req({ action: 'execute' }), context)).status).toBe(400);
    expect(updateBody).toBeUndefined();
  });
  it('preserves existing generic step-up consumers', async () => {
    const params = { amount: 100 };
    expect((await prepare(req({ actionType: 'payout_approve', targetId: 'payout', params }))).status).toBe(200);
    expect(mocks.prepare).toHaveBeenCalledWith(admin, 'payout_approve', 'payout', params);
    expect(rpc).not.toHaveBeenCalled();
  });
});

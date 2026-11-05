import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ fetch: vi.fn(), token: 'initial', userId: 'admin-b', rows: [] as Array<Record<string, unknown>>, badCode: false, conflict: false }));
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => ({ userId: f.userId }) }));
vi.mock('@/lib/supabase', () => ({ supabase: { auth: {
  getSession: async () => ({ data: { session: { access_token: f.token } } }),
  setSession: async () => { f.token = 'rotated'; return { error: null }; },
} } }));
import ChannelChanges from '@/pages/ChannelChanges';
const operation = { business_id: 'business-1', target_action: 'promote_candidate', target_channel_id: null,
  target_candidate_id: 'candidate-1', reason: 'Lost access', request_version: 1,
  target_snapshot: { phone_number_normalized: '+234123456789', country_code: 'NG' },
  verification_record: { owner_reverified: true, verification_method: 'manual_document_review', evidence_refs: [{ type: 'business_document', document_id: 'doc-1', snapshot: { status: 'approved' } }] },
};
const row = { ...operation, id: 'approval-1', request_type: 'recovery', status: 'pending', requester_admin_id: 'admin-a', approver_admin_id: null, requester_step_up_verified_at: new Date().toISOString(), approver_step_up_verified_at: null };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => {
  f.fetch.mockReset(); f.token = 'initial'; f.userId = 'admin-b'; f.rows = [{ ...row, requester_step_up_verified_at: new Date().toISOString() }]; f.badCode = false; f.conflict = false;
  f.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    if (init.method === 'GET') return json({ requests: f.rows });
    const body = JSON.parse(String(init.body));
    if (url.endsWith('/preview')) return json({ previewHash: 'safe-hash', actionType: body.action === 'execute' ? 'channel_change_execute' : 'messaging_config', targetId: body.action === 'approve' || body.action === 'execute' ? 'approval-1' : 'business-1', operation });
    if (url.endsWith('/prepare')) return json({ stepUpId: 'step-1', factorId: 'factor-1', challengeId: 'challenge-1' });
    if (url.endsWith('/verify')) {
      if (f.badCode) { f.badCode = false; return json({ error: 'Invalid code' }, 400); }
      return json({ session: { access_token: 'rotated', refresh_token: 'rotated-refresh' } });
    }
    if (f.conflict) return json({ error: 'Approval expired. Reload and review.' }, 409);
    f.rows = []; return json({ success: true });
  });
  vi.stubGlobal('fetch', f.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const calls = (suffix: string) => f.fetch.mock.calls.filter(call => String(call[0]).endsWith(suffix));
async function review(button = 'Review and approve') {
  await userEvent.click(await screen.findByRole('button', { name: button }));
  const panel = await screen.findByRole('region', { name: 'Review exact channel change' });
  expect(within(panel).getByText('candidate-1')).toBeInTheDocument();
  expect(within(panel).getByText(/234123456789/)).toBeInTheDocument();
  expect(within(panel).getByText(/doc-1/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Confirm with MFA' })).toBeDisabled();
  await userEvent.click(within(panel).getByRole('checkbox'));
  await userEvent.click(screen.getByRole('button', { name: 'Confirm with MFA' }));
  await screen.findByPlaceholderText('000000');
}
async function code() {
  await userEvent.type(screen.getByPlaceholderText('000000'), '123456');
  await userEvent.click(screen.getByRole('button', { name: 'Authorize', exact: true }));
}
describe('channel changes mounted UI and actual step-up hook', () => {
  it('requires explicit second review then uses preview hash and rotated session to approve', async () => {
    render(<ChannelChanges />); await review(); expect(calls('/approve')).toHaveLength(0);
    expect(JSON.parse(String(calls('/prepare')[0][1].body)).params).toMatchObject({ previewHash: 'safe-hash', channel_change: { action: 'approve', approval_id: 'approval-1', details: { review_confirmed: true } } });
    await code(); await screen.findByText('Channel change action completed.');
    const mutation = calls('/approve')[0][1];
    expect(mutation.headers.Authorization).toBe('Bearer rotated');
    expect(JSON.parse(String(mutation.body))).toEqual({ review_confirmed: true, previewHash: 'safe-hash', stepUpId: 'step-1' });
  });
  it('allows invalid TOTP retry without losing the authorized callback', async () => {
    f.badCode = true; render(<ChannelChanges />); await review(); await code();
    await screen.findByText('Invalid code'); expect(calls('/approve')).toHaveLength(0);
    await code(); await screen.findByText('Channel change action completed.'); expect(calls('/approve')).toHaveLength(1);
  });
  it('requester can refresh expired approval and sees second-review requirement', async () => {
    f.userId = 'admin-a'; f.rows[0].requester_step_up_verified_at = '2020-01-01T00:00:00Z';
    render(<ChannelChanges />); await review('Refresh authorization'); await code();
    await screen.findByText('Authorization refreshed. A second admin must review and approve again.');
    expect(JSON.parse(String(calls('/prepare')[0][1].body)).params.channel_change.action).toBe('refresh'); expect(calls('/re-request')).toHaveLength(1);
  });
  it('allows requester execution after a distinct second admin approved', async () => {
    f.userId = 'admin-a'; f.rows[0].status = 'approved'; f.rows[0].approver_admin_id = 'admin-b';
    render(<ChannelChanges />); await review('Review and execute'); await code();
    await screen.findByText('Channel change action completed.'); expect(calls('/execute')).toHaveLength(1);
  });
  it('reloads and dismisses stale preview on execution conflict', async () => {
    f.conflict = true; render(<ChannelChanges />); await review(); await code(); await screen.findByRole('alert');
    expect(screen.queryByRole('region', { name: 'Review exact channel change' })).not.toBeInTheDocument();
    expect(f.fetch.mock.calls.filter(call => call[1].method === 'GET').length).toBeGreaterThan(1);
  });
  it('requires owner reverification and includes explicit shared destination in create preview', async () => {
    render(<ChannelChanges />); await userEvent.click(screen.getByRole('button', { name: 'Create Request' }));
    await userEvent.type(screen.getByLabelText('Business ID'), 'business-1'); await userEvent.type(screen.getByLabelText('Shared destination channel ID'), 'shared-1');
    await userEvent.type(screen.getByLabelText('Reason'), 'Lost access'); await userEvent.type(screen.getByLabelText('Evidence ID'), 'doc-1');
    expect(screen.getByRole('button', { name: 'Preview request' })).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /manually reverified/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Preview request' })); await screen.findByRole('region', { name: 'Review exact channel change' });
    expect(JSON.parse(String(calls('/preview')[0][1].body)).details).toMatchObject({ target_channel_id: 'shared-1', target_candidate_id: null, verification_record: { owner_reverified: true, evidence_refs: [{ type: 'business_document', document_id: 'doc-1' }] } });
  });
});

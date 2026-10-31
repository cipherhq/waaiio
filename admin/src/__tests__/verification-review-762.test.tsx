import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  token: 'initial-token' as string | null, fetch: vi.fn(), prepare: vi.fn(), mutation: vi.fn(),
  saved: false, readError: false, queries: [] as string[],
}));
const businessId = '00000000-0000-0000-0000-000000000001';
const docA = '00000000-0000-0000-0000-000000000011';
const docB = '00000000-0000-0000-0000-000000000012';
const request = (id = 'request-a', name = 'Alpha Shop') => ({
  id, business_id: id === 'request-a' ? businessId : '00000000-0000-0000-0000-000000000002',
  requested_level: 'standard', documents_required: [], status: 'pending', created_at: '2026-01-01',
  businesses: { name, owner_id: 'owner', country_code: 'NG', verification_level: 'basic', verification_status: 'unverified' },
});
vi.mock('@/lib/supabase', () => {
  const from = (table: string) => {
    let columns = '';
    let id = 'request-a';
    const rows = () => table === 'verification_requests' ? [request(), request('request-b', 'Beta Shop')] :
      table === 'business_documents' ? [{ id: docB, status: 'pending', type: 'id', uploaded_at: '2026-01-01' }, { id: docA, status: 'pending', type: 'id', uploaded_at: '2026-01-01' }] : [];
    const chain = {
      select: (value: string) => { columns = value; return chain; },
      eq: (key: string, value: string) => { if (key === 'id') id = value; return chain; },
      order: () => chain, gte: () => chain,
      single: async () => {
        f.queries.push(columns);
        if (columns === 'status') return { data: { status: 'pending' }, error: null };
        return { data: { ...request(id), status: f.saved ? 'completed' : 'pending',
          businesses: { ...request(id).businesses, verification_level: 'standard', verification_status: 'verified' } },
          error: f.readError ? { message: 'read failed' } : null };
      },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows(), count: 0, error: null }).then(resolve),
    };
    return chain;
  };
  return { adminDb: { from }, supabase: { auth: {
    getSession: async () => ({ data: { session: f.token ? { access_token: f.token } : null } }),
    setSession: async () => { f.token = 'rotated-token'; return { error: null }; },
  } } };
});
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/formatters', () => ({ fmtDate: () => 'date', fmtDateTime: () => 'date', fmtCurrency: () => 'amount' }));
import Verification from '@/pages/Verification';
beforeEach(() => {
  f.token = 'initial-token'; f.saved = false; f.readError = false; f.queries.length = 0;
  f.prepare.mockReset(); f.mutation.mockReset(); f.fetch.mockReset();
  f.mutation.mockImplementation(async () => { f.saved = true; return new Response('{"success":true}'); });
  f.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith('/prepare')) { const response = await f.prepare(body); if (response) return response; return new Response('{"stepUpId":"00000000-0000-0000-0000-000000000762","factorId":"factor","challengeId":"challenge"}'); }
    if (url.endsWith('/verify')) return new Response('{"session":{"access_token":"rotated-token","refresh_token":"synthetic-refresh"}}');
    if (url.endsWith('/verification/review')) return f.mutation(body, init);
    throw new Error('Unexpected request');
  });
  vi.stubGlobal('fetch', f.fetch);
  vi.stubGlobal('alert', vi.fn(() => { throw new Error('Native alert unsupported'); }));
  vi.stubGlobal('prompt', vi.fn(() => { throw new Error('Native prompt unsupported'); }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function open(name = 'Alpha Shop') { await userEvent.click(await screen.findByText(name)); }
async function start(action: string) {
  if (action === 'approve') {
    await userEvent.type(screen.getByRole('textbox', { name: 'Review notes' }), '  Notes  ');
    await userEvent.click(screen.getByRole('button', { name: /Approve — Set to/ }));
  } else {
    await userEvent.type(screen.getByRole('textbox', { name: 'Rejection reason' }), '  Reason  ');
    await userEvent.click(screen.getByRole('button', { name: 'Reject Verification' }));
  }
}
async function confirm() {
  await userEvent.click(screen.getByRole('button', { name: 'Confirm and authorize' }));
  await screen.findByPlaceholderText('000000');
}
async function authorize() {
  await userEvent.type(screen.getByPlaceholderText('000000'), '123456');
  await userEvent.click(screen.getByRole('button', { name: 'Authorize' }));
}
describe('Verification actual mounted review and MFA flow', () => {
  it.each(['approve', 'reject'])('%s binds fields/documents and reads persisted result after rotated token', async action => {
    render(<Verification />); await open(); await start(action);
    expect(f.mutation).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
    await confirm();
    expect(f.prepare).toHaveBeenCalledWith({ actionType: 'commercial_config', targetId: businessId, params: {
      scope: 'business_verification_review', action, document_ids: [docA, docB],
      ...(action === 'approve' ? { level: 'standard', notes: 'Notes' } : { reason: 'Reason' }),
    } });
    expect(f.mutation).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Review notes' })).toBeDisabled();
    await authorize();
    await screen.findByText('Review saved. The displayed status is the server result.');
    expect(f.mutation).toHaveBeenCalledTimes(1);
    expect(f.mutation.mock.calls[0][1].headers.Authorization).toBe('Bearer rotated-token');
    expect(f.mutation.mock.calls[0][0].stepUpId).toBe('00000000-0000-0000-0000-000000000762');
    expect(screen.queryByRole('button', { name: 'Reject Verification' })).not.toBeInTheDocument();
    expect(f.queries.some(value => value.startsWith('*, businesses'))).toBe(true);
  });
  it('requires a reason for rejection but permits empty approval notes', async () => {
    render(<Verification />); await open();
    expect(screen.getByRole('button', { name: 'Reject Verification' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /Approve — Set to/ })); await confirm();
    expect(f.prepare.mock.calls[0][0].params.notes).toBeNull();
  });
  it.each(['before-prepare', 'before-authorize'])('cancel %s makes no mutation', async when => {
    render(<Verification />); await open(); await start('approve');
    if (when === 'before-authorize') {
      await confirm(); await userEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
    } else await userEvent.click(screen.getByRole('button', { name: 'Cancel review' }));
    expect(f.mutation).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Review notes' })).not.toBeDisabled();
  });
  it('missing token is visible and makes no mutation or prepare request', async () => {
    f.token = null; render(<Verification />); await open(); await start('reject');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm and authorize' }));
    await screen.findByText('Session expired');
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.mutation).not.toHaveBeenCalled();
  });
  it('displays mutation failure without successful status or automatic replay', async () => {
    f.mutation.mockResolvedValue(new Response('{"error":"Synthetic review failed"}', { status: 500 }));
    render(<Verification />); await open(); await start('reject'); await confirm(); await authorize();
    await screen.findByText('Synthetic review failed');
    expect(f.mutation).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Review saved. The displayed status is the server result.')).not.toBeInTheDocument();
  });
  it('reports saved-but-readback-failed separately', async () => {
    f.readError = true; render(<Verification />); await open(); await start('approve'); await confirm(); await authorize();
    await screen.findByText('Review saved, but readback failed. Close and reload before another attempt.');
    expect(f.mutation).toHaveBeenCalledTimes(1);
  });
  it('blocks duplicate confirmation and ignores a late response after selection changes', async () => {
    let resolve!: (response: Response) => void;
    f.mutation.mockReturnValue(new Promise<Response>(done => { resolve = done; }));
    render(<Verification />); await open(); await start('approve');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and authorize' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and authorize' }));
    await screen.findByPlaceholderText('000000');
    expect(f.prepare).toHaveBeenCalledTimes(1); await authorize();
    await waitFor(() => expect(f.mutation).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: 'Close', exact: true })); await open('Beta Shop');
    await act(async () => resolve(new Response('{"success":true}')));
    expect(screen.getByRole('button', { name: 'Reject Verification' })).toBeInTheDocument();
    expect(screen.queryByText('Review saved. The displayed status is the server result.')).not.toBeInTheDocument();
  });
});

describe('Verification deferred preparation lifecycle', () => {
  it.each(['resolve', 'reject'])('blocks newer preparation until cancelled request settles (%s)', async outcome => {
    let resolve!: (value: Response) => void;
    let reject!: (error: Error) => void;
    f.prepare.mockReturnValueOnce(new Promise<Response>((yes, no) => { resolve = yes; reject = no; }));
    render(<Verification />); await open(); await start('approve');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm and authorize' }));
    await waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: 'Close', exact: true })); await open('Beta Shop');
    expect(screen.getByRole('button', { name: /Approve — Set to/ })).toBeDisabled();
    await act(async () => outcome === 'resolve'
      ? resolve(new Response('{"stepUpId":"00000000-0000-0000-0000-000000000762","factorId":"factor","challengeId":"challenge"}'))
      : reject(new Error('late failure')));
    await waitFor(() => expect(screen.getByRole('button', { name: /Approve — Set to/ })).not.toBeDisabled());
    expect(screen.queryByPlaceholderText('000000')).not.toBeInTheDocument();
    await start('approve'); await confirm();
    expect(f.prepare).toHaveBeenCalledTimes(2);
    expect(f.prepare.mock.calls[1][0].targetId).toBe('00000000-0000-0000-0000-000000000002');
    await authorize(); await screen.findByText('Review saved. The displayed status is the server result.');
    expect(f.mutation).toHaveBeenCalledTimes(1);
    expect(f.mutation.mock.calls[0][0].business_id).toBe('00000000-0000-0000-0000-000000000002');
  });
});

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  fetch: vi.fn(), execute: vi.fn(), role: 'admin',
  authorized: null as null | ((id: string) => Promise<void>),
  directWrite: vi.fn(),
}));
const biz = (id: string, name: string) => ({ id, name, category: 'restaurant', city: 'Lagos', country_code: 'NG', subscription_tier: 'free', status: 'active', created_at: '2026-01-01', verification_level: 'basic' });
vi.mock('@/lib/supabase', () => {
  const from = (table: string) => {
    const run = async () => ({ data: table === 'businesses' ? [biz('a', 'Alpha'), biz('b', 'Beta')] : [], error: null });
    const q = { select: () => q, eq: () => q, in: () => q, is: () => q, order: () => q, limit: () => q, gt: () => q,
      update: (...args: unknown[]) => { f.directWrite(...args); return q; }, maybeSingle: run,
      then: (resolve: (value: Awaited<ReturnType<typeof run>>) => unknown) => run().then(resolve),
    }; return q;
  };
  return { adminDb: { from }, supabase: { from, auth: { getSession: async () => ({ data: { session: { access_token: 'synthetic' } } }) } } };
});
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => ({ role: f.role }) }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn() }));
vi.mock('@/hooks/useStepUp', () => ({ useStepUp: () => ({
  execute: f.execute, reset: vi.fn(), submitCode: vi.fn(), isActive: false, state: { phase: 'idle' },
}) }));
vi.mock('@/components/StepUpDialog', () => ({ StepUpDialog: () => null }));
import Businesses from '@/pages/Businesses';
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let save: () => Promise<Response>;
beforeEach(() => {
  f.fetch.mockReset(); f.execute.mockReset(); f.directWrite.mockClear(); f.role = 'admin'; f.authorized = null;
  f.execute.mockImplementation(async (options: { onAuthorized: (id: string) => Promise<void> }) => { f.authorized = options.onAuthorized; });
  save = async () => response({ business: { id: 'a', name: 'Persisted name', status: 'pending' }, auditRecorded: true });
  f.fetch.mockImplementation((url: string) => /\/(profile|status)$/.test(url) ? save() : Promise.resolve(response({ capabilities: [], overrides: [] })));
  vi.stubEnv('VITE_API_URL', 'https://staging.example'); vi.stubGlobal('fetch', f.fetch); vi.stubGlobal('alert', vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function open(name = 'Alpha') { await userEvent.click((await screen.findAllByText(name)).find(e => e.closest('tr'))!); }
async function edit(field = 'name', value = 'Draft') {
  await userEvent.click(screen.getByRole('button', { name: 'Edit ' + field }));
  const input = screen.getByRole('textbox', { name: 'Edit ' + field });
  await userEvent.clear(input); await userEvent.type(input, value);
  await userEvent.click(within(input.parentElement!).getByRole('button', { name: 'Save' }));
}
async function changeStatus() {
  const label = screen.getByText('Status', { selector: 'label' });
  const box = label.parentElement!;
  await userEvent.selectOptions(within(box).getByRole('combobox'), 'pending');
  await userEvent.click(within(box).getByRole('button', { name: 'Save' }));
}
function deferred() { let resolve!: (value: Response) => void; const promise = new Promise<Response>(done => { resolve = done; }); return { promise, resolve }; }
function saves() { return f.fetch.mock.calls.filter(([url]) => /\/(profile|status)$/.test(url)); }
describe('persisted admin save truth', () => {
  it('renders returned profile value rather than submitted draft, and uses authenticated API', async () => {
    render(<Businesses />); await open(); await edit();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Persisted name' })).toBeInTheDocument());
    expect(screen.queryByRole('textbox', { name: 'Edit name' })).not.toBeInTheDocument();
    expect(saves()[0][1].headers.Authorization).toBe('Bearer synthetic');
    expect(JSON.parse(saves()[0][1].body)).toEqual({ field: 'name', value: 'Draft' });
    expect(f.directWrite).not.toHaveBeenCalled();
  });
  it.each([409, 500])('retains draft and persisted display on HTTP %s', async status => {
    save = async () => response({ error: 'Not saved' }, status);
    render(<Businesses />); await open(); await edit();
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Not saved'));
    expect(screen.getByRole('textbox', { name: 'Edit name' })).toHaveValue('Draft');
    expect(screen.getByRole('heading', { name: 'Alpha' })).toBeInTheDocument();
  });
  it('rejects a success response without a persisted row', async () => {
    save = async () => response({}); render(<Businesses />); await open(); await edit();
    await waitFor(() => expect(alert).toHaveBeenCalled()); expect(screen.getByRole('textbox', { name: 'Edit name' })).toHaveValue('Draft');
  });
  it('shows saved value plus audit warning, without inviting a duplicate write', async () => {
    save = async () => response({ business: { id: 'a', name: 'Persisted name' }, auditRecorded: false });
    render(<Businesses />); await open(); await edit();
    await waitFor(() => expect(alert).toHaveBeenCalledWith(expect.stringContaining('Change saved')));
    expect(screen.getByRole('heading', { name: 'Persisted name' })).toBeInTheDocument(); expect(saves()).toHaveLength(1);
  });
  it('does not apply late profile response to another merchant or retain its edit draft', async () => {
    const late = deferred(); save = () => late.promise; render(<Businesses />); await open(); await edit();
    await open('Beta'); await act(async () => late.resolve(response({ business: { id: 'a', name: 'Late' } })));
    expect(screen.getByRole('heading', { name: 'Beta' })).toBeInTheDocument(); expect(screen.queryByRole('textbox', { name: 'Edit name' })).not.toBeInTheDocument();
  });
  it('requires exact status step-up before saving and renders the persisted result', async () => {
    render(<Businesses />); await open(); await changeStatus();
    expect(saves()).toHaveLength(0); expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ actionType: 'business_status', targetId: 'a', params: { business_id: 'a', previous_status: 'active', status: 'pending' } }));
    await act(async () => f.authorized!('grant'));
    expect(JSON.parse(saves()[0][1].body)).toEqual({ previous_status: 'active', status: 'pending', stepUpId: 'grant' });
    expect(screen.getAllByText('Alpha').find(e => e.closest('tr'))!.closest('tr')).toHaveTextContent('pending');
    expect(f.directWrite).not.toHaveBeenCalled();
  });
  it('status failure keeps table and summary state unchanged', async () => {
    save = async () => response({ error: 'Conflict' }, 409); render(<Businesses />); await open(); await changeStatus();
    await act(async () => { await expect(f.authorized!('grant')).rejects.toThrow('Conflict'); });
    expect(alert).toHaveBeenCalledWith('Conflict');
    expect(screen.getAllByText('Alpha').find(e => e.closest('tr'))!.closest('tr')).toHaveTextContent('active');
  });
  it('ignores late status result after switching merchant', async () => {
    const late = deferred(); save = () => late.promise; render(<Businesses />); await open(); await changeStatus();
    let pending!: Promise<void>; act(() => { pending = f.authorized!('grant'); }); await open('Beta');
    await act(async () => { late.resolve(response({ business: { id: 'a', status: 'pending' } })); await pending; });
    expect(screen.getByRole('heading', { name: 'Beta' })).toBeInTheDocument();
    expect(screen.getAllByText('Beta').find(e => e.closest('tr'))!.closest('tr')).toHaveTextContent('active');
  });
  it('does not dispatch an obsolete status authorization after selection changes', async () => {
    render(<Businesses />); await open(); await changeStatus(); const authorize = f.authorized!; await open('Beta');
    await act(async () => authorize('grant')); expect(saves()).toHaveLength(0);
  });
  it('disables profile edits for support', async () => { f.role = 'support'; render(<Businesses />); await open(); expect(screen.getByRole('button', { name: 'Edit name' })).toBeDisabled(); });
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  fetch: vi.fn(),
  business: { id: 'qa-business', name: 'QA Business' },
  templates: [{ id: 'qa-template', title: 'QA Template', body: 'QA', fields: [], is_active: true,
    require_before_booking: false, token: 'qa-token', pdf_url: null,
    created_at: '2026-01-01', updated_at: '2026-01-01' }],
}));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => fixture.business }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({
  from: (table: string) => {
    if (!['waiver_templates', 'signed_waivers'].includes(table)) throw new Error('Unexpected table');
    const result = { data: table === 'waiver_templates' ? fixture.templates : [], error: null };
    const chain = {
      select: () => chain, eq: () => chain, order: () => chain,
      then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
    };
    return chain;
  },
}) }));
import WaiversPage from '../page';

const signed = [{ id: 'qa-signed', template_id: 'qa-template', customer_name: 'QA Signer',
  customer_phone: null, customer_email: null, signature_url: null, signed_at: '2026-01-01T12:00:00Z',
  metadata: {}, audit_trail: {}, access_token: null,
  waiver_templates: { title: 'QA Template', token: 'qa-token' } }];
const response = (data: unknown = signed, status = 200) => new Response(JSON.stringify(data), { status });
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(r => { resolve = r; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture.fetch.mockResolvedValue(response());
  vi.stubGlobal('fetch', fixture.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function openSigned() {
  render(<WaiversPage />);
  await screen.findByText('QA Template', { selector: 'h3' });
  fireEvent.click(screen.getByRole('button', { name: 'Signed Waivers' }));
}
function search(value: string) {
  fireEvent.change(screen.getByPlaceholderText('Search by name, phone, or email...'), { target: { value } });
}

it.each([401, 500])('shows a recoverable error instead of false empty results for HTTP%s', async status => {
  fixture.fetch.mockResolvedValue(response({ error: 'private backend detail' }, status));
  await openSigned();
  expect((await screen.findByRole('alert')).textContent).toContain('Unable to load signed waivers');
  expect(screen.queryByText('No signed waivers yet')).toBeNull();
  expect(screen.queryByText(/private backend detail/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
});
it('shows a transport error without claiming there are no signatures', async () => {
  fixture.fetch.mockRejectedValue(new Error('network failed'));
  await openSigned();
  await screen.findByRole('alert');
  expect(screen.queryByText('No signed waivers yet')).toBeNull();
});
it('keeps successful empty results distinct from read failures', async () => {
  fixture.fetch.mockResolvedValue(response([]));
  await openSigned();
  await screen.findByText('No signed waivers yet');
  expect(screen.queryByRole('alert')).toBeNull();
});
it('hides a previous result on filtered failure and retries the same search/template scope', async () => {
  await openSigned();
  await screen.findByText('QA Signer');
  fixture.fetch.mockResolvedValue(response({}, 500));
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'qa-template' } });
  await screen.findByRole('alert');
  search('QA');
  await waitFor(() => expect(fixture.fetch.mock.calls.at(-1)?.[0]).toContain('search=QA'));
  await screen.findByRole('alert');
  expect(screen.queryByText('QA Signer')).toBeNull();
  fixture.fetch.mockResolvedValue(response());
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('QA Signer');
  expect(screen.queryByRole('alert')).toBeNull();
  const url = new URL(fixture.fetch.mock.calls.at(-1)![0], 'https://example.invalid');
  expect(Object.fromEntries(url.searchParams)).toEqual({ business_id: 'qa-business', search: 'QA', template_id: 'qa-template' });
  expect(fixture.fetch.mock.calls.every(call => call[1] === undefined)).toBe(true);
});
it('does not let an older successful request overwrite the latest failed search', async () => {
  const old = deferred();
  fixture.fetch.mockReturnValueOnce(old.promise).mockResolvedValue(response({}, 500));
  await openSigned();
  await screen.findByRole('status', { name: 'Loading signed waivers' });
  search('new search');
  await screen.findByRole('alert');
  await act(async () => { old.resolve(response()); });
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(screen.queryByText('QA Signer')).toBeNull();
});
it('does not let an older failed request clear the latest successful search', async () => {
  const old = deferred();
  fixture.fetch.mockReturnValueOnce(old.promise).mockResolvedValue(response());
  await openSigned();
  await screen.findByRole('status', { name: 'Loading signed waivers' });
  search('new search');
  await screen.findByText('QA Signer');
  await act(async () => { old.resolve(response({}, 500)); });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('QA Signer')).toBeTruthy();
});
it('reports a malformed success payload as a read failure', async () => {
  fixture.fetch.mockResolvedValue(response({ unexpected: true }));
  await openSigned();
  await screen.findByRole('alert');
  expect(screen.queryByText('No signed waivers yet')).toBeNull();
});

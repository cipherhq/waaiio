// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({ business: { id: 'business-a', subscription_tier: 'growth' }, client: vi.fn() }));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => state.business }));
vi.mock('@/lib/supabase/client', () => ({ createClient: state.client }));
vi.mock('@/components/dashboard/PageHeader', () => ({ PageHeader: ({ title, children }: any) => <header><h1>{title}</h1>{children}</header> }));
import PollsPage from '@/app/dashboard/polls/page';
import SurveysPage from '@/app/dashboard/surveys/page';

const phone = '+12025550123';
const request = vi.fn();
let recipients: (url: string) => Promise<Response>;
const item = (id: string) => ({ id, question: 'Program question', title: 'Program survey', status: 'active',
  options: ['Yes', 'No'], questions: [], total_votes: 0, total_responses: 0, created_at: '2026-11-01T00:00:00Z' });

beforeEach(() => {
  state.business = { id: 'business-a', subscription_tier: 'growth' };
  state.client.mockReset().mockImplementation(() => { throw new Error('Contact selection must use the scoped consent API'); });
  recipients = async () => Response.json({ recipients: [{ phone, name: null }], truncated: false });
  request.mockReset().mockImplementation(async (url: string) => {
    if (url.startsWith('/api/broadcasts/recipients?')) return recipients(url);
    if (url.includes('/send')) return Response.json({ sent: 1, failed: 0 });
    if (url.startsWith('/api/polls?')) return Response.json({ polls: [item(state.business.id)] });
    if (url.startsWith('/api/surveys?')) return Response.json({ surveys: [item(state.business.id)] });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', request);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe.each([['polls', PollsPage], ['surveys', SurveysPage]] as const)('%s consent audience', (resource, Page) => {
  it('offers consent-only numbers without a bot session or profile and sends only the selected API recipients', async () => {
    render(<Page />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send', exact: true }));
    expect(await screen.findByLabelText(phone)).toBeTruthy();
    expect(state.client).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith('/api/broadcasts/recipients?businessId=business-a', expect.objectContaining({ cache: 'no-store' }));
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Send to 1 contact' }));
    // The existing send routes use this exact value for bot_sessions lookups.
    await waitFor(() => expect(request).toHaveBeenCalledWith(`/api/${resource}/business-a/send`, expect.objectContaining({ body: JSON.stringify({ phones: [phone.slice(1)] }) })));
  });

  it('leaves sending disabled when contacts cannot be loaded', async () => {
    recipients = async () => Response.json({ error: 'Unavailable' }, { status: 503 });
    render(<Page />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send', exact: true }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Could not load opted-in contacts. Reopen Send to try again.');
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect((screen.getByRole('button', { name: 'Send to 0 contacts' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not invent recipients when nobody has eligible consent', async () => {
    recipients = async () => Response.json({ recipients: [], truncated: false });
    render(<Page />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send', exact: true }));
    expect(await screen.findByText(/No opted-in contacts yet/)).toBeTruthy();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('clears previous selection and ignores a late response after the business changes', async () => {
    let resolveOld!: (response: Response) => void;
    recipients = url => url.endsWith('business-a') ? new Promise(resolve => { resolveOld = resolve; })
      : Promise.resolve(Response.json({ recipients: [], truncated: false }));
    const view = render(<Page />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send', exact: true }));
    await screen.findByText('Loading opted-in contacts…');
    const oldCall = request.mock.calls.find(([url]) => url.includes('broadcasts/recipients'))!;
    state.business = { ...state.business, id: 'business-b' };
    view.rerender(<Page />);
    await act(async () => { resolveOld(Response.json({ recipients: [{ phone, name: null }] })); });
    expect(oldCall[1].signal.aborted).toBe(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Send', exact: true }));
    await screen.findByText(/No opted-in contacts yet/);
    expect(screen.queryByLabelText(phone)).toBeNull();
    expect((screen.getByRole('button', { name: 'Send to 0 contacts' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('reports incomplete lists and caps the selected batch at the existing server limit', async () => {
    const many = Array.from({ length: 501 }, (_, index) => ({ phone: `+1202555${String(index).padStart(4, '0')}`, name: null }));
    recipients = async () => Response.json({ recipients: many, truncated: true });
    render(<Page />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send', exact: true }));
    await screen.findByText(/This list is incomplete/);
    expect(screen.getAllByRole('checkbox')).toHaveLength(500);
    fireEvent.click(screen.getByRole('button', { name: 'Send to 500 contacts' }));
    await waitFor(() => expect(request.mock.calls.some(([url]) => url === `/api/${resource}/business-a/send`)).toBe(true));
    const send = request.mock.calls.find(([url]) => url === `/api/${resource}/business-a/send`)!;
    expect(JSON.parse(send[1].body).phones).toEqual(many.slice(0, 500).map(contact => contact.phone.slice(1)));
  });
});

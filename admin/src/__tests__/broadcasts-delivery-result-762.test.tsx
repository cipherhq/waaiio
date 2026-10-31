import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Broadcasts from '../pages/Broadcasts';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(), fetch: vi.fn(), insert: vi.fn(), profiles: vi.fn(),
  businesses: vi.fn(), history: vi.fn(), audit: vi.fn(), role: 'admin',
}));
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: mocks.getSession } },
  adminDb: { from: (table: string) => {
    if (table === 'admin_broadcasts') return {
      insert: mocks.insert, select: () => ({ order: mocks.history }),
    };
    if (table === 'businesses') return { select: mocks.businesses };
    if (table === 'profiles') return { select: () => ({
      not: mocks.profiles, in: () => ({ not: mocks.profiles }),
    }) };
    throw new Error('Unexpected table');
  } },
}));
vi.mock('@/components/AdminLayout', () => ({
  useAdminSession: () => ({ userId: 'synthetic-admin', role: mocks.role }),
}));
vi.mock('@/lib/auditLog', () => ({ logAudit: mocks.audit }));

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function sendButton() { return screen.getByRole('button', { name: 'Send Broadcast' }); }
function compose(audience = 'all_users') {
  render(<Broadcasts />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: audience } });
  if (audience === 'specific') fireEvent.change(screen.getByPlaceholderText('user1@example.com, user2@example.com'), {
    target: { value: 'one@example.com, two@example.com' },
  });
  fireEvent.change(screen.getByPlaceholderText('Email subject line'), { target: { value: 'Synthetic subject' } });
  fireEvent.change(screen.getByPlaceholderText('Write your message...'), { target: { value: 'Synthetic message' } });
}
function draftPreserved() {
  expect(screen.getByPlaceholderText('Email subject line')).toHaveValue('Synthetic subject');
  expect(screen.getByPlaceholderText('Write your message...')).toHaveValue('Synthetic message');
}
async function expectNoSubmission() {
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Nothing was submitted'));
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.insert).not.toHaveBeenCalled();
  draftPreserved();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.role = 'admin';
  vi.stubGlobal('fetch', mocks.fetch);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  mocks.getSession.mockResolvedValue({ data: { session: { user: { id: 'synthetic-admin' }, access_token: 'synthetic-token' } }, error: null });
  mocks.profiles.mockResolvedValue({ data: [{ email: 'one@example.com' }, { email: null }, { email: 'two@example.com' }], error: null });
  mocks.businesses.mockResolvedValue({ data: [{ owner_id: 'owner-one' }, { owner_id: 'owner-one' }], error: null });
  mocks.history.mockResolvedValue({ data: [], error: null });
  mocks.insert.mockResolvedValue({ error: null });
  mocks.audit.mockResolvedValue(undefined);
  mocks.fetch.mockResolvedValue(reply({ success: true }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Broadcast submission and recorded history (#762)', () => {
  it('waits for acknowledgement before history, counts submitted emails and clears an acknowledged draft', async () => {
    const pending = deferred<Response>();
    mocks.fetch.mockReturnValue(pending.promise);
    compose();
    fireEvent.click(sendButton());
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    expect(mocks.insert).not.toHaveBeenCalled();
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(url).toMatch(/\/api\/email\/send$/);
    expect(options.headers.Authorization).toBe('Bearer synthetic-token');
    expect(JSON.parse(options.body)).toEqual({ to: ['one@example.com', 'two@example.com'], subject: 'Synthetic subject', html: 'Synthetic message' });
    pending.resolve(reply({ success: true }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('history recorded'));
    expect(mocks.insert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ recipient_count: 2, status: 'sent', sender_id: 'synthetic-admin' }));
    expect(screen.getByPlaceholderText('Write your message...')).toHaveValue('');
    expect(screen.getByRole('status')).toHaveTextContent('not confirmation of recipient delivery');
  });

  it.each([
    ['non-2xx', () => Promise.resolve(reply({ success: true }, 500)), 'did not acknowledge'],
    ['failed body', () => Promise.resolve(reply({ success: false })), 'did not acknowledge'],
    ['missing acknowledgement', () => Promise.resolve(reply({})), 'did not acknowledge'],
    ['rejected request', () => Promise.reject(new Error('synthetic network failure')), 'outcome is unknown'],
    ['invalid JSON', () => Promise.resolve(new Response('invalid', { status: 200 })), 'outcome is unknown'],
  ])('%s preserves the draft without a sent record or duplicate request', async (_name, response, message) => {
    mocks.fetch.mockImplementation(response);
    compose('specific');
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(message));
    draftPreserved();
    expect(screen.getByPlaceholderText('user1@example.com, user2@example.com')).toHaveValue('one@example.com, two@example.com');
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(sendButton()).toBeDisabled();
    fireEvent.click(sendButton());
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing token', { data: { session: { user: { id: 'synthetic-admin' } } }, error: null }],
    ['missing session', { data: { session: null }, error: null }],
    ['returned session error', { data: { session: null }, error: { message: 'synthetic error' } }],
  ])('%s prevents submission', async (_name, session) => {
    mocks.getSession.mockResolvedValue(session);
    compose(); fireEvent.click(sendButton()); await expectNoSubmission();
  });
  it('thrown session error prevents submission', async () => {
    mocks.getSession.mockRejectedValue(new Error('synthetic'));
    compose(); fireEvent.click(sendButton()); await expectNoSubmission();
  });

  it.each(['all_users', 'all_businesses', 'specific'])('empty %s audience prevents submission', async audience => {
    mocks.profiles.mockResolvedValue({ data: [], error: null });
    mocks.businesses.mockResolvedValue({ data: [], error: null });
    compose(audience);
    if (audience === 'specific') fireEvent.change(screen.getByPlaceholderText('user1@example.com, user2@example.com'), { target: { value: ' , ' } });
    fireEvent.click(sendButton()); await expectNoSubmission();
  });

  it.each([
    ['all_users', 'returned'], ['all_users', 'thrown'],
    ['all_businesses', 'returned'], ['all_businesses', 'thrown'],
  ])('%s recipient query %s error prevents submission', async (audience, mode) => {
    const query = audience === 'all_users' ? mocks.profiles : mocks.businesses;
    if (mode === 'returned') query.mockResolvedValue({ data: [], error: { message: 'synthetic' } });
    else query.mockRejectedValue(new Error('synthetic'));
    compose(audience); fireEvent.click(sendButton()); await expectNoSubmission();
  });
  it.each(['returned', 'thrown'])('business owner email query %s error prevents submission', async mode => {
    if (mode === 'returned') mocks.profiles.mockResolvedValue({ data: [], error: { message: 'synthetic' } });
    else mocks.profiles.mockRejectedValue(new Error('synthetic'));
    compose('all_businesses'); fireEvent.click(sendButton()); await expectNoSubmission();
  });
  it('uses resolved owner emails rather than number of businesses', async () => {
    compose('all_businesses'); fireEvent.click(sendButton());
    await waitFor(() => expect(mocks.insert).toHaveBeenCalled());
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ recipient_count: 2, audience: 'all_businesses' }));
  });
  it.each(['returned', 'thrown'])('accepted submission with %s history failure is held without resend', async mode => {
    if (mode === 'returned') mocks.insert.mockResolvedValue({ error: { message: 'synthetic history failure' } });
    else mocks.insert.mockRejectedValue(new Error('synthetic history failure'));
    compose('specific'); fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('API accepted submission for 2 recipient(s), but history could not be saved'));
    draftPreserved();
    expect(sendButton()).toBeDisabled();
    fireEvent.click(sendButton());
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('blocks concurrent clicks while session validation is pending', async () => {
    const pending = deferred<unknown>();
    mocks.getSession.mockReturnValue(pending.promise);
    compose();
    const button = sendButton();
    fireEvent.click(button); fireEvent.click(button);
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    pending.resolve({ data: { session: null }, error: null });
    await expectNoSubmission();
  });
  it('keeps unavailable channels disabled and blocks empty and unauthorized submission', () => {
    mocks.role = 'support';
    render(<Broadcasts />);
    expect(screen.getByRole('button', { name: /WhatsApp/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /SMS/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Email' })).toBeEnabled();
    expect(sendButton()).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('Email subject line'), { target: { value: 'Subject' } });
    fireEvent.change(screen.getByPlaceholderText('Write your message...'), { target: { value: 'Message' } });
    expect(sendButton()).toBeDisabled();
    fireEvent.click(sendButton());
    expect(mocks.getSession).not.toHaveBeenCalled();
  });
  it('does not submit when confirmation is cancelled', () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    compose(); fireEvent.click(sendButton());
    expect(mocks.getSession).not.toHaveBeenCalled();
  });
  it('labels historical sent records without certifying delivery', async () => {
    mocks.history.mockResolvedValue({ data: [{
      id: 'synthetic-history', sender_id: 'synthetic-admin', channel: 'email',
      audience: 'all_users', subject: 'Old subject', message: 'Old message', status: 'sent',
      recipient_count: 1, sent_at: null, created_at: '2026-01-01T00:00:00Z',
    }], error: null });
    render(<Broadcasts />);
    await waitFor(() => expect(screen.getByText('Recorded as sent')).toBeInTheDocument());
    expect(screen.getByText(/including historical sent records/)).toHaveTextContent('does not confirm recipient delivery');
  });
});

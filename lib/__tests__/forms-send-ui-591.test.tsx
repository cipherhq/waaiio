// @vitest-environment jsdom
/**
 * #591 — rendered UI for the public form opt-in box and the Forms send panel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useParams: () => ({ token: 'tokA' }) }));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('@/components/ReturnToWhatsApp', () => ({ ReturnToWhatsApp: () => null }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));

import PublicFormPage from '@/app/form/[token]/page';
import { FormSendPanel } from '@/components/dashboard/forms/FormSendPanel';

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); globalThis.fetch = fetchMock as unknown as typeof fetch; });
afterEach(() => cleanup());
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

const publicForm = (optIn: boolean) => ({
  title: 'Guest list', description: null, business_name: 'Ada Salon', business_phone: null, business_logo: null,
  fields: [{ id: 'p', label: 'Phone', type: 'phone', required: false }],
  marketing_opt_in: optIn,
});

describe('public form "Yes, send me updates" box', () => {
  it('is hidden unless the merchant turned it on', async () => {
    fetchMock.mockImplementation(() => json(publicForm(false)));
    render(<PublicFormPage />);
    await screen.findByText('Guest list');
    expect(screen.queryByTestId('marketing-opt-in')).toBeNull();
  });

  it('is unticked by default and sends false unless the customer ticks it', async () => {
    fetchMock.mockImplementation((url: string) => url.includes('/api/forms/public/') ? json(publicForm(true)) : json({ success: true }));
    render(<PublicFormPage />);
    const box = await screen.findByTestId('marketing-opt-in') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText(/Yes, send me updates from Ada Salon on WhatsApp/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ marketing_opt_in: false });
  });

  it('asks for a number before recording a ticked opt-in', async () => {
    fetchMock.mockImplementation(() => json(publicForm(true)));
    render(<PublicFormPage />);
    fireEvent.click(await screen.findByTestId('marketing-opt-in'));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Add your WhatsApp number to get updates')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Forms send panel', () => {
  function route(sendResponse: unknown) {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/forms/recipients')) return json({ contacts: [{ phone: '+2348031111111', name: 'Ada' }, { phone: '+2348032222222', name: null }], truncated: false });
      if (url.startsWith('/api/engage/segments')) return json({ error: 'Forbidden' }, 403);
      if (url.startsWith('/api/whatsapp/templates')) return json({ data: [
        { name: 'feedback_request', status: 'APPROVED', language: 'en_US', category: 'MARKETING', components: [{ type: 'BODY', text: '{{1}} would like your feedback! {{2}}' }] },
        { name: 'draft_one', status: 'PENDING', language: 'en_US', category: 'MARKETING', components: [{ type: 'BODY', text: '{{1}} {{2}}' }] },
        { name: 'three_slots', status: 'APPROVED', language: 'en_US', category: 'MARKETING', components: [{ type: 'BODY', text: '{{1}} {{2}} {{3}}' }] },
        { name: 'login_code', status: 'APPROVED', language: 'en_US', category: 'AUTHENTICATION', components: [{ type: 'BODY', text: '{{1}} {{2}}' }] },
      ] });
      return json(sendResponse);
    });
  }

  it('sends picked opted-in contacts with the chosen template and shows who was skipped and why', async () => {
    route({ success: true, sent: 1, failed: 1, skipped: 0, results: [
      { phone: '+2348031111111', status: 'sent', via: 'template' },
      { phone: '+2348032222222', status: 'failed', reason: 'provider_error' },
    ] });
    render(<FormSendPanel businessId="biz-a" formId="form-a" onClose={() => {}} />);
    fireEvent.click(await screen.findByText(/Select all \(2\)/));
    await screen.findByRole('option', { name: /feedback_request/ });
    for (const hidden of [/draft_one/, /three_slots/, /login_code/]) expect(screen.queryByRole('option', { name: hidden })).toBeNull();
    fireEvent.change(screen.getByLabelText('WhatsApp template'), { target: { value: 'feedback_request' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
    expect(await screen.findByText('Sent 1 · Failed 1 · Skipped 0')).toBeTruthy();
    expect(screen.getByText(/WhatsApp did not confirm it accepted the message/)).toBeTruthy();
    const sendCall = fetchMock.mock.calls.find(c => c[0] === '/api/forms/send')!;
    expect(JSON.parse(sendCall[1].body)).toEqual({
      formId: 'form-a', businessId: 'biz-a', phones: ['+2348031111111', '+2348032222222'], templateName: 'feedback_request',
    });
    // The selection is cleared so a second click cannot resend to the same people.
    expect((screen.getByRole('button', { name: 'Send now' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('blocks more than 100 people and warns when results cannot be read', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/forms/recipients')) return json({ contacts: [], truncated: false });
      if (url === '/api/forms/send') return Promise.resolve(new Response('<html>timeout</html>', { status: 504 }));
      return json({}, 404);
    });
    render(<FormSendPanel businessId="biz-a" formId="form-a" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Type numbers' }));
    const many = Array.from({ length: 101 }, (_, i) => `0803${String(i).padStart(7, '0')}`).join('\n');
    fireEvent.change(screen.getByLabelText('Phone numbers'), { target: { value: many } });
    expect(screen.getByText(/at most 100 people at a time. You picked 101/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Send now' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Phone numbers'), { target: { value: '08031111111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
    expect(await screen.findByText(/Some messages may already have been sent/)).toBeTruthy();
  });

  it('typed numbers go through the same consent checks and skip reasons are shown', async () => {
    route({ success: false, sent: 0, failed: 0, skipped: 1, results: [{ phone: '+2348039999999', status: 'skipped', reason: 'no_consent' }] });
    render(<FormSendPanel businessId="biz-a" formId="form-a" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Type numbers' }));
    fireEvent.change(screen.getByLabelText('Phone numbers'), { target: { value: '08039999999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
    expect(await screen.findByText(/Skipped — Has not opted in, and has not messaged you in the last 24 hours/)).toBeTruthy();
  });

  it('shows people who messaged in the last 24 hours as their own group, with time left, and sends to the ones picked', async () => {
    const lastMessageAt = new Date(Date.now() - 2 * 60 * 60_000 - 5 * 60_000).toISOString(); // 2h05m ago
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/forms/recipients')) return json({
        contacts: [{ phone: '+2348031111111', name: 'Ada' }], truncated: false,
        recentChats: [{ phone: '+2348037777777', name: 'Chidi', lastMessageAt }, { phone: '+2348038888888', name: null, lastMessageAt }],
        recentChatsTruncated: false,
      });
      if (url === '/api/forms/send') return json({ success: true, sent: 2, failed: 0, skipped: 0, results: [] });
      return json({}, 404);
    });
    render(<FormSendPanel businessId="biz-a" formId="form-a" onClose={() => {}} />);
    const recent = await screen.findByRole('group', { name: 'Messaged you in the last 24 hours (can get a form now)' });
    expect(within(recent).getByText('Chidi')).toBeTruthy();
    expect(within(recent).getAllByText(/^21h \d+m left$/)).toHaveLength(2);
    expect(within(screen.getByRole('group', { name: 'Opted in to updates' })).getByText('Ada')).toBeTruthy();
    expect(screen.getByText(/People who messaged you in the last 24 hours can also get it/)).toBeTruthy();
    fireEvent.click(within(recent).getByText(/Select all \(2\)/));
    fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(c => c[0] === '/api/forms/send')).toBe(true));
    const body = JSON.parse(fetchMock.mock.calls.find(c => c[0] === '/api/forms/send')![1].body);
    expect(body.phones).toEqual(['+2348037777777', '+2348038888888']);
  });

  it('schedules for later, shows the summary, and lets the owner cancel a scheduled send', async () => {
    const sends = [
      { id: 's1', status: 'scheduled', scheduled_at: '2026-12-01T09:00:00.000Z', sent_count: 0, failed_count: 0, skipped_count: 0, error_message: null },
      { id: 's0', status: 'sent', scheduled_at: '2026-11-01T09:00:00.000Z', sent_count: 1, failed_count: 0, skipped_count: 1, error_message: null,
        results: [{ phone: '+2348031111111', status: 'sent', via: 'template' }, { phone: '+2348032222222', status: 'skipped', reason: 'opted_out' }] },
    ];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/forms/recipients')) return json({ contacts: [{ phone: '+2348031111111', name: 'Ada' }], truncated: false });
      if (url.startsWith('/api/forms/sends') && init?.method === 'DELETE') return json({ cancelled: true });
      if (url.startsWith('/api/forms/sends')) return json({ sends });
      if (url === '/api/forms/send') return json({ scheduled: true, id: 's1', scheduledAt: '2026-12-01T09:00:00.000Z', recipients: 1, skipped: 0, results: [] });
      return json({}, 404);
    });
    render(<FormSendPanel businessId="biz-a" formId="form-a" onClose={() => {}} />);
    fireEvent.click(await screen.findByText(/Select all \(1\)/));
    fireEvent.click(screen.getByLabelText('Later'));
    expect((screen.getByRole('button', { name: 'Schedule' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Send at'), { target: { value: '2026-12-01T10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(await screen.findByText(/Scheduled for .*: 1 person · Skipped 0/)).toBeTruthy();
    const body = JSON.parse(fetchMock.mock.calls.find(c => c[0] === '/api/forms/send')![1].body);
    expect(body.scheduledAt).toBe(new Date('2026-12-01T10:00').toISOString());
    // Past sends say who was not sent and why.
    fireEvent.click(await screen.findByText('Who wasn’t sent'));
    expect(screen.getByText(/\+2348032222222: Opted out of messages/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(c => c[1]?.method === 'DELETE')).toBe(true));
    const del = fetchMock.mock.calls.find(c => c[1]?.method === 'DELETE')!;
    expect(JSON.parse(del[1].body)).toEqual({ id: 's1', businessId: 'biz-a' });
  });

  it('shows that no audiences are available when the account cannot read them', async () => {
    route({});
    render(<FormSendPanel businessId="biz-a" formId="form-a" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Audience' }));
    expect(await screen.findByText(/No saved audiences/)).toBeTruthy();
  });
});

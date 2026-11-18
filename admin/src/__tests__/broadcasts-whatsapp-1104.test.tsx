// #1104: the rendered Broadcasts page with WhatsApp on, through the real
// WhatsAppBroadcastForm, useStepUp hook and StepUpDialog. Only fetch and the
// Supabase client are stubbed. Covers template choice, filters, preview with
// skips and the Waaiio cost estimate, a step-up bound to the previewed values,
// the single send, a retry that returns the first result, and the role gate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const m = vi.hoisted(() => ({
  role: 'admin', fetch: vi.fn(), setSession: vi.fn(), history: vi.fn(),
  sendStatus: 200, sendFails: false, statusBody: {} as Record<string, unknown>,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: {
    getSession: async () => ({ data: { session: { user: { id: 'admin-1' }, access_token: 'token' } }, error: null }),
    setSession: m.setSession,
  } },
  adminDb: { from: (table: string) => {
    if (table !== 'admin_broadcasts') throw new Error(`unexpected table ${table}`);
    return { select: () => ({ order: m.history }), insert: () => { throw new Error('the page must not write WhatsApp history'); } };
  } },
}));
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => ({ userId: 'admin-1', role: m.role }) }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn() }));
import Broadcasts from '../pages/Broadcasts';

const TEMPLATE = { name: 'waaiio_news', language: 'en_US', category: 'marketing', bodyText: 'Hi from Waaiio: {{1}}', paramCount: 1 };
const DESCRIPTOR = { templateName: 'waaiio_news', language: 'en_US', audience: 'all_businesses', country: 'NG', plan: 'growth', phones: [], params: ['New feature'] };
const PREVIEW = {
  template: { ...TEMPLATE, rendered: 'Hi from Waaiio: New feature' },
  counts: { matched: 5, withoutNumber: 1, eligible: 3, noSender: 0, optedOut: 1, suspended: 1, unverified: 0 },
  estimate: { byCurrency: [{ currency: 'NGN', amountMinor: 6000, recipients: 3 }], unpriced: 0 },
  maxRecipients: 500,
  descriptor: DESCRIPTOR,
};
const SENT = { replayed: false, status: 'sent', sent: 3, failed: 0, unknown: 0, skipped: { optedOut: 1, suspended: 1, unverified: 0 } };

const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));
const calls = (suffix: string, method = 'POST') => m.fetch.mock.calls.filter(([url, init]) =>
  String(url).endsWith(suffix) && ((init as RequestInit | undefined)?.method || 'GET') === method);
const wa = () => calls('/api/admin/broadcasts/whatsapp');

beforeEach(() => {
  m.role = 'admin'; m.sendStatus = 200; m.sendFails = false; m.statusBody = { ...SENT, replayed: true };
  m.history.mockReset();
  m.history.mockResolvedValue({ data: [], error: null });
  m.setSession.mockResolvedValue({ error: null });
  m.fetch.mockReset();
  m.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/admin/broadcasts/whatsapp') && m.role !== 'admin') return Response.json({ error: 'Unauthorized' }, { status: 403 });
    if (url.endsWith('/api/admin/broadcasts/whatsapp') && (init?.method || 'GET') === 'GET') return Response.json({ templates: [TEMPLATE] });
    if (url.endsWith('/api/admin/broadcasts/whatsapp')) {
      const body = JSON.parse(String(init!.body));
      if (body.mode === 'preview') return Response.json(PREVIEW);
      if (body.mode === 'status') return Response.json(m.statusBody);
      if (m.sendFails) throw new TypeError('Failed to fetch');
      return m.sendStatus === 200 ? Response.json(SENT) : Response.json({ error: 'Template is paused' }, { status: m.sendStatus });
    }
    if (url.endsWith('/step-up/prepare')) return Response.json({ stepUpId: 'grant-1', factorId: 'factor', challengeId: '' });
    if (url.endsWith('/step-up/verify')) return Response.json({ session: { access_token: 'after-mfa', refresh_token: 'r' } });
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', m.fetch);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function composeAndPreview() {
  render(<Broadcasts />);
  fireEvent.click(screen.getByRole('button', { name: 'WhatsApp' }));
  await screen.findByRole('option', { name: /waaiio_news/ });
  fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'waaiio_news|en_US' } });
  fireEvent.change(screen.getByLabelText('Value for {{1}}'), { target: { value: 'New feature' } });
  fireEvent.change(screen.getByLabelText('Country (optional)'), { target: { value: 'ng' } });
  fireEvent.change(screen.getByLabelText('Plan (optional)'), { target: { value: 'growth' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview recipients and cost' }));
  await screen.findByLabelText('WhatsApp broadcast preview');
}

function authorize() {
  fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
}

describe('Admin Broadcasts: WhatsApp (#1104)', () => {
  it('turns WhatsApp on and keeps SMS coming soon', () => {
    render(<Broadcasts />);
    expect(screen.getByRole('button', { name: 'WhatsApp' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /SMS — coming soon/ })).toBeDisabled();
  });

  it('previews recipients, skips and the Waaiio cost before anything is sent', async () => {
    await composeAndPreview();
    expect(bodyOf(wa()[0])).toEqual({ mode: 'preview', ...DESCRIPTOR });
    const preview = screen.getByRole('region', { name: 'WhatsApp broadcast preview' });
    expect(preview).toHaveTextContent('Hi from Waaiio: New feature');
    expect(preview).toHaveTextContent('3 will be sent (marketing)');
    expect(preview).toHaveTextContent('1 skipped: opted out of Waaiio messages');
    expect(preview).toHaveTextContent('1 skipped: suspended');
    expect(preview).toHaveTextContent('1 have no valid WhatsApp number');
    expect(preview).toHaveTextContent(/Estimate at Waaiio's per-message rates: .*60.*No merchant credit is used/);
    expect(wa().filter(c => bodyOf(c).mode === 'send')).toHaveLength(0);
  });

  it('sends once, through a step-up bound to the previewed values, and refreshes history', async () => {
    await composeAndPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Send WhatsApp Broadcast' }));
    await screen.findByPlaceholderText('000000');
    const [prepare] = calls('/step-up/prepare');
    const prepared = bodyOf(prepare);
    expect(prepared).toMatchObject({ actionType: 'admin_broadcast', params: DESCRIPTOR });
    expect(prepared.targetId).toMatch(/^[0-9a-f-]{36}$/);
    expect(wa().filter(c => bodyOf(c).mode === 'send')).toHaveLength(0);

    authorize();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('3 accepted by WhatsApp'));
    const sends = wa().filter(c => bodyOf(c).mode === 'send');
    expect(sends).toHaveLength(1);
    expect(bodyOf(sends[0])).toEqual({ mode: 'send', requestId: prepared.targetId, stepUpId: 'grant-1', ...DESCRIPTOR });
    expect(screen.getByRole('status')).toHaveTextContent('2 skipped');
    expect(screen.getByRole('status')).toHaveTextContent('No merchant credit was used');
    expect(m.history).toHaveBeenCalledTimes(2);
    // The preview is used up: a second send needs a fresh preview.
    expect(screen.getByRole('button', { name: 'Send WhatsApp Broadcast' })).toBeDisabled();
  });

  it('after a lost response, Check result reads the recorded result for the same request id and never sends', async () => {
    await composeAndPreview();
    m.sendFails = true;
    fireEvent.click(screen.getByRole('button', { name: 'Send WhatsApp Broadcast' }));
    await screen.findByPlaceholderText('000000');
    authorize();
    await screen.findByRole('button', { name: 'Check result' });
    expect(screen.getByRole('status')).toHaveTextContent('never sends twice');
    expect(screen.getByLabelText('Template')).toBeDisabled();
    const sendId = bodyOf(wa().find(c => bodyOf(c).mode === 'send')!).requestId;

    // Still running (or cut off): the page stays in the unknown state.
    m.statusBody = { replayed: true, status: 'sending', sent: 1, failed: 0, unknown: 1, notProcessed: 1, skipped: { optedOut: 0, suspended: 0, unverified: 0 } };
    fireEvent.click(screen.getByRole('button', { name: 'Check result' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('still sending, or was cut off'));
    expect(screen.getByRole('status')).toHaveTextContent('1 not reached yet');
    expect(screen.getByRole('button', { name: 'Check result' })).toBeInTheDocument();

    m.statusBody = { ...SENT, replayed: true };
    fireEvent.click(screen.getByRole('button', { name: 'Check result' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('This broadcast was already sent'));
    const statusCalls = wa().filter(c => bodyOf(c).mode === 'status');
    expect(statusCalls.map(c => bodyOf(c))).toEqual([{ mode: 'status', requestId: sendId }, { mode: 'status', requestId: sendId }]);
    expect(wa().filter(c => bodyOf(c).mode === 'send')).toHaveLength(1);
    expect(calls('/step-up/prepare')).toHaveLength(1);
  });

  it('a refusal before anything was sent clears the unknown state', async () => {
    await composeAndPreview();
    m.sendStatus = 403;
    fireEvent.click(screen.getByRole('button', { name: 'Send WhatsApp Broadcast' }));
    await screen.findByPlaceholderText('000000');
    authorize();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Template is paused'));
    expect(screen.queryByRole('button', { name: 'Check result' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Send WhatsApp Broadcast' })).toBeEnabled();
  });

  it('changing the draft discards the preview', async () => {
    await composeAndPreview();
    fireEvent.change(screen.getByLabelText('Value for {{1}}'), { target: { value: 'Other text' } });
    expect(screen.queryByLabelText('WhatsApp broadcast preview')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send WhatsApp Broadcast' })).toBeDisabled();
  });

  it('a support admin cannot load templates or send (the server refuses)', async () => {
    m.role = 'support';
    render(<Broadcasts />);
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Unauthorized');
    expect(screen.getByRole('button', { name: 'Preview recipients and cost' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send WhatsApp Broadcast' })).toBeDisabled();
  });

  it('shows the API error when a send is refused', async () => {
    await composeAndPreview();
    m.sendStatus = 422;
    fireEvent.click(screen.getByRole('button', { name: 'Send WhatsApp Broadcast' }));
    await screen.findByPlaceholderText('000000');
    authorize();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Template is paused'));
    expect(screen.getByRole('status')).not.toHaveTextContent('accepted');
  });
});

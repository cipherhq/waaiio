// #1131: the rendered Broadcasts page with SMS on, through the real
// SmsBroadcastForm, useStepUp hook and StepUpDialog. Only fetch and the
// Supabase client are stubbed. Covers the preview (pages, Unicode, skips,
// Waaiio's own cost), the step-up bound to the previewed values, a single
// send that never uses merchant credit, quiet hours and the switched-off state.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const m = vi.hoisted(() => ({
  fetch: vi.fn(), setSession: vi.fn(), history: vi.fn(),
  preview: {} as Record<string, unknown>,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: {
    getSession: async () => ({ data: { session: { user: { id: 'admin-1' }, access_token: 'token' } }, error: null }),
    setSession: m.setSession,
  } },
  adminDb: { from: (table: string) => {
    if (table !== 'admin_broadcasts') throw new Error(`unexpected table ${table}`);
    return { select: () => ({ order: m.history }), insert: () => { throw new Error('the page must not write SMS history'); } };
  } },
}));
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => ({ userId: 'admin-1', role: 'admin' }) }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn() }));
import Broadcasts from '../pages/Broadcasts';

const DESCRIPTOR = { audience: 'all_businesses', country: 'NG', plan: null, phones: [], message: 'Ẹ ku àbọ̀ to Waaiio' };
const PREVIEW = {
  configured: true,
  sms: { pages: 1, unicode: true, characters: 20, perPage: 70 },
  counts: { matched: 6, withoutNumber: 1, notSmsCountry: 1, eligible: 2, optedOut: 1, suspended: 1, unverified: 0 },
  quietHoursNow: false,
  estimate: { byCurrency: [{ currency: 'NGN', amountMinor: 1396, recipients: 2 }], unpriced: 0 },
  maxRecipients: 250,
  descriptor: DESCRIPTOR,
};
const SENT = { replayed: false, status: 'sent', sent: 2, failed: 0, unknown: 0, skipped: { optedOut: 1, suspended: 1, unverified: 0 } };

const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));
const sms = () => m.fetch.mock.calls.filter(([url]) => String(url).endsWith('/api/admin/broadcasts/sms'));

beforeEach(() => {
  m.preview = PREVIEW;
  m.history.mockReset();
  m.history.mockResolvedValue({ data: [], error: null });
  m.setSession.mockResolvedValue({ error: null });
  m.fetch.mockReset();
  m.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/admin/broadcasts/sms')) {
      const body = JSON.parse(String(init!.body));
      if (body.mode === 'preview') return Response.json(m.preview);
      return Response.json(SENT);
    }
    if (url.endsWith('/step-up/prepare')) return Response.json({ stepUpId: 'grant-1', factorId: 'factor', challengeId: '' });
    if (url.endsWith('/step-up/verify')) return Response.json({ session: { access_token: 'after-mfa', refresh_token: 'r' } });
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', m.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function composeAndPreview() {
  render(<Broadcasts />);
  fireEvent.click(screen.getByRole('button', { name: 'SMS' }));
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: DESCRIPTOR.message } });
  fireEvent.change(screen.getByLabelText('Country (optional)'), { target: { value: 'NG' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview recipients and cost' }));
  await screen.findByLabelText('SMS broadcast preview');
}

describe('Admin Broadcasts: SMS (#1131)', () => {
  it('previews pages, accents, skips and Waaiio\'s own cost before anything is sent', async () => {
    await composeAndPreview();
    expect(bodyOf(sms()[0])).toEqual({ mode: 'preview', ...DESCRIPTOR });
    const preview = screen.getByRole('region', { name: 'SMS broadcast preview' });
    expect(preview).toHaveTextContent('1 SMS page per person');
    expect(preview).toHaveTextContent('Accented letters or emoji make each page shorter');
    expect(preview).toHaveTextContent('2 will be sent');
    expect(preview).toHaveTextContent('1 skipped: opted out');
    expect(preview).toHaveTextContent('1 skipped: suspended');
    expect(preview).toHaveTextContent('1 not reachable: SMS goes to Nigeria and Ghana only');
    expect(preview).toHaveTextContent(/Waaiio's cost .*13\.96.*No merchant credit is used/);
    expect(sms().filter(c => bodyOf(c).mode === 'send')).toHaveLength(0);
  });

  it('sends once through a step-up bound to the previewed values; no merchant credit is used', async () => {
    await composeAndPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Send SMS Broadcast' }));
    await screen.findByPlaceholderText('000000');
    const prepare = m.fetch.mock.calls.find(([url]) => String(url).endsWith('/step-up/prepare'))!;
    const prepared = bodyOf(prepare);
    expect(prepared).toMatchObject({ actionType: 'admin_broadcast', params: DESCRIPTOR });
    fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('2 accepted by the SMS provider'));
    expect(screen.getByRole('status')).toHaveTextContent('no merchant credit was used');
    const sends = sms().filter(c => bodyOf(c).mode === 'send');
    expect(sends).toHaveLength(1);
    expect(bodyOf(sends[0])).toEqual({ mode: 'send', requestId: prepared.targetId, stepUpId: 'grant-1', ...DESCRIPTOR });
  });

  it('cannot send during quiet hours or while SMS is switched off', async () => {
    m.preview = { ...PREVIEW, quietHoursNow: true };
    await composeAndPreview();
    expect(screen.getByRole('alert')).toHaveTextContent('between 8pm and 8am');
    expect(screen.getByRole('button', { name: 'Send SMS Broadcast' })).toBeDisabled();
    cleanup();
    m.preview = { ...PREVIEW, configured: false };
    await composeAndPreview();
    expect(screen.getByRole('alert')).toHaveTextContent('SMS is not switched on');
    expect(screen.getByRole('button', { name: 'Send SMS Broadcast' })).toBeDisabled();
  });
});

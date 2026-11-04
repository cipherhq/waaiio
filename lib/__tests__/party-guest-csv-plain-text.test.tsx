// @vitest-environment jsdom
// The Parties guest-list export writes free-text cells as plain text.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import PartiesPage from '@/app/dashboard/parties/page';
import { plainTextCell } from '@/lib/parties/csv-cell';

const mocks = vi.hoisted(() => ({ client: vi.fn(), fetch: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ createClient: mocks.client }));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => ({ id: 'business', name: 'Business', subscription_tier: 'growth', country_code: 'NG' }) }));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => null }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/components/auth/PhoneInput', () => ({ PhoneInput: () => null }));
vi.mock('@/components/ui/PlacesAutocomplete', () => ({ default: () => null }));

const party = { id: 'party', name: 'Wedding', date: '2027-01-01', status: 'active', allow_plus_ones: true,
  max_plus_ones: 3, ask_dietary: true, slug: 'wedding', created_at: '2026-10-01' };
const invite = (id: string, extra: Record<string, unknown>) => ({
  id, guest_phone: '+15550000001', guest_name: id, status: 'accepted', plus_ones: 0, dietary_notes: null, invite_token: 'token',
  responded_at: null, reminder_sent: false, tags: [], table_id: null, seat_number: null, seating_group_id: null,
  seating_pinned: false, created_at: '2026-10-01', ...extra,
});
let invites: Record<string, unknown>[];

beforeEach(() => {
  vi.clearAllMocks();
  invites = [];
  mocks.client.mockReturnValue({ from: (table: string) => {
    const q: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'order', 'is', 'in', 'update', 'insert', 'delete', 'contains']) q[method] = () => q;
    q.then = (resolve: (v: unknown) => unknown) => resolve({
      data: table === 'parties' ? [party] : table === 'event_invites' ? invites : [], error: null,
    });
    return q;
  } });
  mocks.fetch.mockImplementation(async (url: string) => url.endsWith('/questions')
    ? new Response(JSON.stringify({ questions: [], revision: 0, responses: [] }))
    : new Response(JSON.stringify({ snapshot: { fingerprint: 'f', tables: [], guests: [], groups: [] } })));
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function exportCsv(): Promise<string[]> {
  let blob: Blob | null = null;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => { blob = b as Blob; return 'blob:x'; });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  render(<PartiesPage />);
  fireEvent.click(await screen.findByText('Wedding'));
  fireEvent.click(await screen.findByRole('button', { name: 'Export Guest List' }));
  expect(blob).not.toBeNull();
  return (await blob!.text()).split('\n');
}

describe('Parties guest-list export: free text is plain text', () => {
  it('prefixes name, tags and dietary notes that a spreadsheet would run as formulas', async () => {
    invites = [invite('=HYPERLINK("x","y")', { tags: ['+VIP'], dietary_notes: '@SUM(1)' })];
    const lines = await exportCsv();
    expect(lines[0]).toBe('"Name","Phone","Status","Plus Ones","Tags","Dietary Notes","Responded At"');
    expect(lines[1]).toBe(`"'=HYPERLINK(""x"",""y"")","+15550000001","accepted","0","'+VIP","'@SUM(1)",""`);
  });

  it('leaves ordinary values and the phone column exactly as before', async () => {
    invites = [invite('Ada Lovelace', { tags: ['Family', 'VIP'], dietary_notes: 'No nuts - thanks', status: 'declined', plus_ones: 2 })];
    const lines = await exportCsv();
    expect(lines[1]).toBe('"Ada Lovelace","+15550000001","declined","0","Family; VIP","No nuts - thanks",""');
  });

  it('covers every formula start character, and only at the start', () => {
    for (const start of ['=', '+', '-', '@', '\t', '\r']) expect(plainTextCell(`${start}1`)).toBe(`'${start}1`);
    expect(plainTextCell('')).toBe('');
    expect(plainTextCell('a=1')).toBe('a=1');
    expect(plainTextCell(' =1')).toBe(' =1');
  });
});

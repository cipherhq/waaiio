// @vitest-environment jsdom
// #874 PR B, T8: rendered Parties dashboard with tag questions, reserved tables, answers and CSV.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import PartiesPage from '@/app/dashboard/parties/page';
import { planSeating, type SeatingSnapshot } from '@/lib/parties/seating-planner';
import type { PartyQuestion } from '@/lib/parties/rsvp-questions';

const mocks = vi.hoisted(() => ({ client: vi.fn(), fetch: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ createClient: mocks.client }));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => ({ id: 'business', name: 'Business', subscription_tier: 'growth', country_code: 'NG' }) }));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => null }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/components/auth/PhoneInput', () => ({ PhoneInput: () => null }));
vi.mock('@/components/ui/PlacesAutocomplete', () => ({ default: () => null }));

const GROOM = "Groom's family", BRIDE = "Bride's family";
const party = { id: 'party', name: 'Wedding', date: '2027-01-01', status: 'active', allow_plus_ones: true,
  max_plus_ones: 3, ask_dietary: false, slug: 'wedding', created_at: '2026-10-01' };
const sideQuestion = (tag: boolean): PartyQuestion => ({ id: 'side', label: 'Which side?', type: 'single_choice', required: true,
  options: [{ id: 'groom', label: GROOM }, { id: 'bride', label: BRIDE }], ...(tag ? { tag_answers: true } : {}) });
const mealQuestion: PartyQuestion = { id: 'meal', label: 'Meal?', type: 'short_text', required: false };

let snapshot: SeatingSnapshot;
let questions: PartyQuestion[];
let updates: { table: string; values: Record<string, unknown>; id: unknown }[];
let savedQuestions: PartyQuestion[] | null;
let answers: Record<string, Record<string, string>>;
let inviteReads: number;

beforeEach(() => {
  vi.clearAllMocks(); updates = []; savedQuestions = null; inviteReads = 0;
  questions = [sideQuestion(true), mealQuestion];
  answers = { ada: { side: 'groom', meal: '=SUM(1)' }, ben: { side: 'bride' } };
  snapshot = {
    fingerprint: 'initial', groups: [],
    tables: [{ id: 't1', name: 'Table 1', capacity: 1, reserved_tag: GROOM }, { id: 't2', name: 'Table 2', capacity: 4, reserved_tag: null }],
    guests: [
      { id: 'ada', guest_name: 'Ada', status: 'accepted', plus_ones: 0, table_id: null, seating_pinned: false, seating_group_id: null, tags: [GROOM, 'VIP'] },
      { id: 'ben', guest_name: 'Ben', status: 'accepted', plus_ones: 0, table_id: 't1', seating_pinned: true, seating_group_id: null, tags: [BRIDE] },
      { id: 'cy', guest_name: 'Cy', status: 'accepted', plus_ones: 0, table_id: null, seating_pinned: false, seating_group_id: null, tags: [GROOM] },
    ],
  };
  mocks.client.mockReturnValue({ from: (table: string) => {
    let columns = '';
    const filters: Record<string, unknown> = {};
    let pending: Record<string, unknown> | null = null;
    const q: Record<string, unknown> = {};
    q.select = (value: string) => { columns = value; return q; };
    q.eq = (key: string, value: unknown) => { filters[key] = value; return q; };
    q.update = (values: Record<string, unknown>) => { pending = values; return q; };
    for (const method of ['order', 'is', 'in', 'insert', 'delete', 'contains']) q[method] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
      const read = async () => {
        if (pending) {
          updates.push({ table, values: pending, id: filters.id });
          if (table === 'party_tables') snapshot = { ...snapshot, tables: snapshot.tables.map(t => t.id === filters.id ? { ...t, ...pending } : t) };
          return { data: null, error: null };
        }
        if (table === 'event_invites' && columns !== 'plus_ones') inviteReads++;
        if (table === 'event_invites' && columns === 'plus_ones')
          return { data: snapshot.guests.filter(g => g.table_id === filters.table_id).map(g => ({ plus_ones: g.plus_ones })), error: null };
        const data = table === 'parties' ? [party] : table === 'party_tables' ? snapshot.tables.map(t => ({ ...t, sort_order: 0 })) :
          snapshot.guests.map(g => ({ ...g, guest_phone: `+1${g.id}`, invite_token: 'token', reminder_sent: false, created_at: '2026-10-01',
            responded_at: null, dietary_notes: null, answer_tag: g.id === 'ada' ? GROOM : g.id === 'ben' ? BRIDE : null,
            custom_answers: answers[g.id] || {}, saved_question_snapshot: questions }));
        return { data, error: null };
      };
      return read().then(resolve, reject);
    };
    return q;
  } });
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/questions')) {
      if (init?.method === 'PUT') { savedQuestions = JSON.parse(String(init.body)).questions; questions = savedQuestions!; }
      return new Response(JSON.stringify({ questions, revision: 1, responses: [] }));
    }
    const input = init?.body ? JSON.parse(String(init.body)) : { op: 'snapshot' };
    if (input.op === 'preview') return new Response(JSON.stringify({ snapshot, plan: planSeating(snapshot, input.seed), seed: input.seed, planHash: 'reviewed' }));
    return new Response(JSON.stringify({ snapshot, success: true }));
  });
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function open() {
  render(<PartiesPage />);
  fireEvent.click(await screen.findByText('Wedding'));
  await screen.findByRole('columnheader', { name: 'RSVP answers' });
  await waitFor(() => expect(within(screen.getByRole('region', { name: 'Seating plan' })).queryByRole('status')).toBeNull());
}

describe('rendered Parties dashboard: seating by tag #874', () => {
  it('questions editor (M537): several choice and yes/no questions tag guests; yes/no needs a tag for Yes', async () => {
    const veg = { id: 'veg', label: 'Vegetarian?', type: 'yes_no' as const, required: false };
    questions = [sideQuestion(false), { ...sideQuestion(false), id: 'diet', label: 'Diet?' }, mealQuestion, veg];
    await open();
    const boxes = await screen.findAllByLabelText('Tag guests with their answer');
    expect(boxes).toHaveLength(3); // two choice questions and the yes/no question; not the text question
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    fireEvent.click(boxes[1]);
    fireEvent.click(boxes[1]);
    fireEvent.click(boxes[2]);
    expect(boxes.map(b => (b as HTMLInputElement).checked)).toEqual([true, true, true]);
    fireEvent.click(screen.getByRole('button', { name: 'Save questions' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Add a tag for Yes: Vegetarian?');
    expect(savedQuestions).toBeNull();
    fireEvent.change(screen.getByLabelText('Question 4 tag for Yes'), { target: { value: 'Vegetarian' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save questions' }));
    await waitFor(() => expect(savedQuestions).not.toBeNull());
    expect(savedQuestions!.map(q => q.tag_answers)).toEqual([true, true, undefined, true]);
    expect(savedQuestions![3]).toMatchObject({ yes_tag: 'Vegetarian' });
    expect(Object.keys(savedQuestions![2])).not.toContain('tag_answers');
  });

  it('questions editor: saving reloads the re-tagged guest list once; a type change drops the flag', async () => {
    await open();
    await waitFor(() => expect(inviteReads).toBeGreaterThan(0));
    const before = inviteReads;
    // The database re-tags guests on save (M514 D3); the reloaded list must show it.
    mocks.fetch.mockImplementationOnce(async (_url: string, init?: RequestInit) => {
      savedQuestions = JSON.parse(String(init!.body)).questions;
      snapshot = { ...snapshot, guests: snapshot.guests.map(g => g.id === 'cy' ? { ...g, tags: ['Friends'] } : g) };
      return new Response(JSON.stringify({ questions: savedQuestions, revision: 2, responses: [] }));
    });
    fireEvent.change(screen.getByLabelText('Question 1 type'), { target: { value: 'short_text' } });
    expect(screen.queryAllByLabelText('Tag guests with their answer')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Save questions' }));
    await waitFor(() => expect(inviteReads).toBe(before + 1));
    expect(savedQuestions![0]).not.toHaveProperty('tag_answers');
    const cyRow = await waitFor(() => {
      const row = screen.getByLabelText('RSVP answers for Cy').closest('tr') as HTMLElement;
      expect(within(row).getByText('Friends')).toBeTruthy();
      return row;
    });
    expect(cyRow).toBeTruthy();
    await new Promise(r => setTimeout(r, 50));
    expect(inviteReads).toBe(before + 1);
  });

  it('tables: "Reserved for" offers the question options and tags, saves the choice, and limits "+ tag"', async () => {
    await open();
    const reserve = screen.getByLabelText('Reserved for (Table 2)') as HTMLSelectElement;
    expect([...reserve.options].map(o => o.textContent)).toEqual(['Anyone', BRIDE, GROOM, 'VIP']);
    fireEvent.change(reserve, { target: { value: BRIDE } });
    await waitFor(() => expect(updates).toContainEqual({ table: 'party_tables', values: { reserved_tag: BRIDE }, id: 't2' }));
    await waitFor(() => expect((screen.getByLabelText('Reserved for (Table 2)') as HTMLSelectElement).value).toBe(BRIDE));
    const card = screen.getByLabelText('Reserved for (Table 2)').closest('div.rounded-lg') as HTMLElement;
    const plusTags = within(card).getAllByRole('button').map(b => b.textContent).filter(t => t?.startsWith('+ '));
    expect(plusTags).toEqual([`+ ${BRIDE}`]);
    fireEvent.change(screen.getByLabelText('Reserved for (Table 2)'), { target: { value: '' } });
    await waitFor(() => expect(updates).toContainEqual({ table: 'party_tables', values: { reserved_tag: null }, id: 't2' }));
  });

  it('guest list: shows RSVP answers, marks the tag from the RSVP, and blocks reserved tables for other guests', async () => {
    snapshot.tables = [{ ...snapshot.tables[0], capacity: 4 }, { ...snapshot.tables[1], reserved_tag: BRIDE }];
    await open();
    const ada = screen.getByLabelText('RSVP answers for Ada');
    expect(ada.textContent).toBe(`Which side?: ${GROOM}Meal?: =SUM(1)`);
    const row = ada.closest('tr') as HTMLElement;
    expect(within(row).getAllByText('(from RSVP)')).toHaveLength(1);
    expect(within(row).getByText('(from RSVP)').parentElement?.textContent).toContain(GROOM);
    const option = (name: string, table: string) => {
      const guestRow = screen.getByLabelText(`RSVP answers for ${name}`).closest('tr') as HTMLElement;
      return [...(within(guestRow).getByRole('combobox') as HTMLSelectElement).options].find(o => o.value === table)!;
    };
    expect(option('Ada', 't1').disabled).toBe(false);
    expect(option('Ada', 't2').disabled).toBe(true);
    expect(option('Ada', 't2').textContent).toBe(`Table 2 (0/4) · ${BRIDE}`);
    expect(option('Cy', 't2').disabled).toBe(true);
    expect(option('Ben', 't2').disabled).toBe(false);
    expect(option('Ben', 't1').disabled).toBe(false);
  });

  it('preview: lists guests who do not fit per tag and warns about pinned guests at reserved tables', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Randomize and preview' }));
    await screen.findByText('Review seating');
    expect(screen.getByText(`Table 1 (${GROOM}): 1 / 1 seats`)).toBeTruthy();
    expect(screen.getByText(`Ben stays at Table 1 (pinned), which is reserved for ${GROOM}.`)).toBeTruthy();
    expect(screen.getByText(new RegExp(`^${GROOM}: 2 guests don't fit at ${GROOM} tables — add seats or a table\\. Not placed: (Ada, Cy|Cy, Ada)\\.$`))).toBeTruthy();
  });

  it('CSV export adds one column per question and exports guest text as plain text', async () => {
    let blob: Blob | null = null;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => { blob = b as Blob; return 'blob:x'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Export Guest List' }));
    expect(blob).not.toBeNull();
    const lines = (await blob!.text()).split('\n');
    expect(lines[0]).toBe('"Name","Phone","Status","Plus Ones","Tags","Dietary Notes","Responded At","Which side?","Meal?"');
    expect(lines.find(l => l.startsWith('"Ada"'))).toBe(`"Ada","+1ada","accepted","0","${GROOM}; VIP","","","${GROOM}","'=SUM(1)"`);
  });
});

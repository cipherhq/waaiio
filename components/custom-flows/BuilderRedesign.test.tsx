// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FlowBuilder } from './FlowBuilder';
import { FlowSetup } from './FlowSetup';
import { WALKTHROUGH_KEY } from './Walkthrough';
import { createTemplate, FESTIVAL_TABLES } from '@/lib/custom-flow-builder/templates';

// Rendered tests for the #1107 builder redesign. Traffic is mocked at fetch
// with a small in-memory store; every request asserted is an existing action.
const FLOW_ID = '22222222-2222-4222-8222-222222222222';
type Flow = { id: string; version: number; definition: any; published_definition: any; published_version: number | null };
type Table = { id: string; name: string; columns: any[]; editor_schema_version: number; updated_at: string };
type Row = { id: string; row_code: string; data: Record<string, unknown>; position: number; hidden: boolean; updated_at: string };
let flow: Flow;
let tables: Table[];
let rows: Record<string, Row[]>;
let posts: Array<{ url: string; body: Record<string, any> }>;
let stamp = 0;

function festivalFlow(): Flow {
  const { definition } = createTemplate({ id: FLOW_ID, businessId: 'business', template: 'festival_info', name: 'AfroPlus 2027', keyword: 'AFROPLUS', language: 'en', timezone: 'Africa/Lagos', currency: 'NGN', bindings: [] });
  return { id: FLOW_ID, version: 1, definition: { ...definition, greeting: 'Welcome to AfroPlus' }, published_definition: null, published_version: null };
}

beforeEach(() => {
  try { window.localStorage.setItem(WALKTHROUGH_KEY, 'done'); } catch { /* ignore */ }
  flow = festivalFlow();
  tables = FESTIVAL_TABLES.map(table => ({ id: `t-${table.name}`, name: table.name, columns: structuredClone(table.columns) as any[], editor_schema_version: 1, updated_at: 'v0' }));
  rows = { 't-artists': [{ id: 'a1', row_code: 'TEMS', data: { name: 'Tems', day: 'Friday', stage: 'Lagoon stage', start_time: '8pm' }, position: 0, hidden: false, updated_at: 'r0' }] };
  posts = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(body) });
    if (!options?.method) {
      if (url.startsWith('/api/custom-flows/data')) {
        const tableId = new URL(url, 'http://x').searchParams.get('tableId');
        return ok({ tables, rows: tableId ? rows[tableId] ?? [] : [] });
      }
      return ok({ flows: [flow] });
    }
    const body = JSON.parse(String(options.body)); posts.push({ url, body });
    if (url === '/api/custom-flows/setup') {
      const made = createTemplate({ id: body.id, businessId: 'business', template: body.template, name: body.name, keyword: body.keyword, language: body.language, timezone: 'Africa/Lagos', currency: 'NGN', bindings: body.bindings });
      flow = { id: body.id, version: 1, definition: made.definition, published_definition: null, published_version: null };
      return ok({ flow }, 201);
    }
    if (url === '/api/custom-flows/data') {
      const list = rows[body.tableId] ??= [];
      if (body.action === 'create_table') { tables.push({ id: body.id, name: body.name, columns: body.columns, editor_schema_version: 1, updated_at: 'v0' }); return ok({ data: { id: body.id } }); }
      if (body.action === 'save_table') { const table = tables.find(t => t.id === body.tableId)!; table.columns = body.columns; table.updated_at = `v${++stamp}`; return ok({ data: table }); }
      if (body.action === 'create_row') { list.push({ id: body.id, row_code: body.rowCode, data: body.data, position: body.position, hidden: body.hidden, updated_at: `r${++stamp}` }); return ok({ data: { id: body.id } }); }
      if (body.action === 'save_row') { const row = list.find(r => r.id === body.id)!; Object.assign(row, { row_code: body.rowCode, data: body.data, hidden: body.hidden, updated_at: `r${++stamp}` }); return ok({ data: row }); }
      if (body.action === 'delete_row') { rows[body.tableId] = list.filter(r => r.id !== body.id); return ok({ data: { id: body.id } }); }
    }
    if (body.action === 'save') { flow = { ...flow, definition: body.definition, version: flow.version + 1 }; return ok({ flow }); }
    return ok({ messages: [] });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); try { window.localStorage.clear(); } catch { /* ignore */ } });

async function openFlow() {
  render(<FlowBuilder businessId="business" />);
  fireEvent.click(await screen.findByRole('option', { name: flow.definition.name }));
}
const card = (heading: string) => screen.getByRole('heading', { level: 3, name: heading }).closest('li')!;
const dataPosts = () => posts.filter(post => post.url === '/api/custom-flows/data').map(post => post.body);

describe('Start screen: what people can do (#1107)', () => {
  it('builds buttons, steps and empty lists from the ticks, with the existing requests only', async () => {
    const created = vi.fn();
    render(<FlowSetup businessId="business" template="blank" onCreated={created} onCancel={vi.fn()} />);
    expect(screen.getByRole('group', { name: 'What should people be able to do?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /Find an artist/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Getting here/ }));
    fireEvent.change(screen.getByLabelText('Add your own button'), { target: { value: 'Lost and found' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect((screen.getByRole('checkbox', { name: /Lost and found/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText('Flow name'), { target: { value: 'My fest' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create flow' }));
    await waitFor(() => expect(created).toHaveBeenCalledOnce());
    expect(posts.map(post => [post.url, post.body.action ?? post.body.template])).toEqual([
      ['/api/custom-flows/setup', 'blank'], ['/api/custom-flows/data', 'create_table'], ['/api/custom-flows/data', 'create_table'], ['/api/custom-flows', 'save'],
    ]);
    expect(posts[1].body).toMatchObject({ name: 'Artists', columns: [{ name: 'name' }, { name: 'day' }, { name: 'time' }, { name: 'stage' }, { name: 'about' }] });
    expect(posts[2].body).toMatchObject({ name: 'Lost and found', columns: [{ name: 'name' }, { name: 'details' }] });
    const saved = posts[3].body.definition;
    expect(saved.nodes[0].options).toEqual([{ label: 'Artists', next: 'lookup_artists' }, { label: 'Getting here', next: 'info_getting_here' }, { label: 'Lost and found', next: 'lookup_custom_1' }]);
    expect(saved.nodes.map((node: { id: string; type: string }) => `${node.id}:${node.type}`)).toEqual(['main_menu:menu', 'lookup_artists:lookup', 'info_getting_here:message', 'lookup_custom_1:lookup']);
    expect(saved.nodes[1]).toMatchObject({ table: 'Artists', next: 'main_menu' });
    expect(saved.nodes.some((node: object) => 'mode' in node)).toBe(false);
  });

  it('festival ticks as they come send only the setup; unticking a section turns it off the existing way', async () => {
    const created = vi.fn();
    const first = render(<FlowSetup businessId="business" template="festival_info" onCreated={created} onCancel={vi.fn()} />);
    for (const name of ['Find an artist', 'Find a vendor', 'Badge pickup', 'News', 'FAQs']) expect((screen.getByRole('checkbox', { name: new RegExp(name) }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Create flow' }));
    await waitFor(() => expect(created).toHaveBeenCalledOnce());
    expect(posts.map(post => post.url)).toEqual(['/api/custom-flows/setup']);
    first.unmount(); posts = []; created.mockReset();

    render(<FlowSetup businessId="business" template="festival_info" onCreated={created} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /^News/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Buy tickets/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create flow' }));
    await waitFor(() => expect(created).toHaveBeenCalledOnce());
    expect(posts.map(post => post.body.action ?? post.body.template)).toEqual(['festival_info', 'save']);
    const saved = posts[1].body.definition;
    expect(saved.guided.sections.find((s: { id: string }) => s.id === 'news').enabled).toBe(false);
    expect(saved.nodes[0].options.map((o: { label: string }) => o.label)).toEqual(['Artists', 'Vendors', 'Ticket Types', 'FAQs', 'Buy tickets']);
    expect(saved.nodes.at(-1)).toEqual({ id: 'tickets_tickets', type: 'handoff', capability: 'ticketing' });
  });
});

describe('Inline entries on a list step (#1107)', () => {
  it('adds with Save and add another, edits and deletes after a confirmation, through the existing data actions', async () => {
    await openFlow();
    const artists = () => card('2. Search Artists');
    await within(artists()).findByText('Tems');
    fireEvent.click(within(artists()).getByRole('button', { name: '+ Add artist' }));
    const form = within(artists()).getByRole('group', { name: 'Add artist' });
    expect(document.activeElement).toBe(within(form).getByLabelText(/^Name/));
    fireEvent.change(within(form).getByLabelText(/^Name/), { target: { value: 'Wizkid' } });
    fireEvent.change(within(form).getByLabelText(/^Day/), { target: { value: 'Saturday' } });
    fireEvent.change(within(form).getByLabelText(/^Stage/), { target: { value: 'Main stage' } });
    fireEvent.change(within(form).getByLabelText(/^Start time/), { target: { value: '9pm' } });
    // The header shows there is unsaved work while the form has changes.
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    fireEvent.click(within(form).getByRole('button', { name: 'Save and add another' }));
    await within(artists()).findByText('Wizkid');
    expect(dataPosts().at(-1)).toMatchObject({ action: 'create_row', tableId: 't-artists', rowCode: 'WIZKID', hidden: false, data: { name: 'Wizkid', day: 'Saturday', stage: 'Main stage', start_time: '9pm' } });
    // A fresh form, focused, for the next artist.
    const next = within(artists()).getByRole('group', { name: 'Add artist' });
    expect((within(next).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(within(next).getByLabelText(/^Name/));
    fireEvent.click(within(next).getByRole('button', { name: 'Cancel' }));

    fireEvent.click(within(artists()).getByRole('button', { name: 'Edit Wizkid' }));
    const edit = within(artists()).getByRole('group', { name: 'Edit Wizkid' });
    fireEvent.change(within(edit).getByLabelText(/^Stage/), { target: { value: 'Lagoon stage' } });
    fireEvent.click(within(edit).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(dataPosts().at(-1)).toMatchObject({ action: 'save_row', rowCode: 'WIZKID', data: { stage: 'Lagoon stage' } }));
    expect(dataPosts().at(-1)!.updatedAt).toMatch(/^r\d+$/);

    await within(artists()).findByText(/Saturday · Lagoon stage/);
    fireEvent.click(within(artists()).getByRole('button', { name: 'Delete Wizkid' }));
    const confirm = within(artists()).getByRole('group', { name: 'Delete Wizkid?' });
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Keep' }));
    const before = dataPosts().length;
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep' }));
    expect(dataPosts()).toHaveLength(before);
    fireEvent.click(within(artists()).getByRole('button', { name: 'Delete Wizkid' }));
    fireEvent.click(within(artists()).getByRole('button', { name: 'Yes, delete' }));
    await waitFor(() => expect(within(artists()).queryByText('Wizkid')).toBeNull());
    expect(dataPosts().at(-1)).toMatchObject({ action: 'delete_row', tableId: 't-artists' });
    expect(posts.some(post => post.body.action === 'publish')).toBe(false);
  });

  it('renames a field label without changing the column name', async () => {
    await openFlow();
    const artists = () => card('2. Search Artists');
    await within(artists()).findByText('Tems');
    fireEvent.click(within(artists()).getByRole('button', { name: 'Rename fields' }));
    fireEvent.change(within(artists()).getByLabelText('Field 4'), { target: { value: 'Set time' } });
    fireEvent.click(within(artists()).getByRole('button', { name: 'Save field names' }));
    await waitFor(() => expect(dataPosts().at(-1)).toMatchObject({ action: 'save_table', name: 'artists' }));
    expect(dataPosts().at(-1)!.columns.map((c: { name: string; label: string }) => `${c.name}:${c.label}`)).toEqual(['name:Name', 'day:Day', 'stage:Stage', 'start_time:Set time']);
  });

  it('shows why an entry is not shown to people yet', async () => {
    rows['t-artists'].push({ id: 'a2', row_code: 'BURNA', data: { name: 'Burna Boy', day: 'Sunday' }, position: 1, hidden: false, updated_at: 'r0' });
    await openFlow();
    expect(await within(card('2. Search Artists')).findByText('Not shown yet: add Stage, Start time')).toBeTruthy();
  });
});

describe('Everything editable in a guided flow (#1107)', () => {
  it('renames a button and its step in place, keeps structure locked, and the section toggle still works', async () => {
    await openFlow();
    // Structure stays behind the advanced editor.
    expect(screen.queryByRole('heading', { name: 'Step order' })).toBeNull();
    // The first step opens on load, ready to edit, as in every other flow.
    expect(screen.getByRole('button', { name: 'Edit 1. Show buttons' }).getAttribute('aria-expanded')).toBe('true');
    const editor = screen.getByRole('group', { name: 'Editing step 1 · Show buttons' });
    expect(within(editor).queryByRole('button', { name: 'Add a button' })).toBeNull();
    expect(within(editor).queryByRole('button', { name: 'Remove button' })).toBeNull();
    expect(within(editor).queryByRole('button', { name: 'Remove this step' })).toBeNull();
    const artistButton = within(editor).getAllByLabelText('Button text')[0] as HTMLInputElement;
    expect(artistButton.value).toBe('Artists');
    fireEvent.change(artistButton, { target: { value: 'Line-up' } });
    fireEvent.change(within(editor).getByLabelText('Message above the buttons'), { target: { value: 'What do you need?' } });
    expect(screen.getByRole('heading', { level: 3, name: '2. Search Line-up' })).toBeTruthy();
    fireEvent.click(within(editor).getByRole('button', { name: 'Done' }));

    // A step reached by a button is renamed from the step itself too.
    fireEvent.click(screen.getByRole('button', { name: 'Edit 3. Search Vendors' }));
    const vendors = screen.getByRole('group', { name: 'Editing step 3 · Search Vendors' });
    expect(within(vendors).queryByLabelText('Which list')).toBeNull();
    expect(within(vendors).queryByLabelText('Then go to')).toBeNull();
    fireEvent.change(within(vendors).getByLabelText('Button name'), { target: { value: 'Food & drink' } });
    fireEvent.change(within(vendors).getByLabelText('Question we ask'), { target: { value: 'What are you hungry for?' } });
    fireEvent.click(within(vendors).getByRole('radio', { name: /Both/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts.some(post => post.body.action === 'save')).toBe(true));
    const saved = posts.find(post => post.body.action === 'save')!.body.definition;
    expect(saved.nodes[0].text).toBe('What do you need?');
    expect(saved.nodes[0].options.slice(0, 2)).toEqual([{ label: 'Line-up', next: 'lookup_artists' }, { label: 'Food & drink', next: 'lookup_vendors' }]);
    expect(saved.guided.sections.slice(0, 2).map((s: { label: string }) => s.label)).toEqual(['Line-up', 'Food & drink']);
    expect(saved.nodes[2]).toMatchObject({ prompt: 'What are you hungry for?', mode: 'both', table: 'vendors', next: 'main_menu' });

    // The existing section protection still accepts the renamed section.
    await screen.findByText('Saved.');
    const sections = screen.getByRole('heading', { name: 'Sections' }).parentElement!;
    fireEvent.click(within(sections).getAllByRole('button', { name: 'Turn section off' })[0]);
    expect(screen.queryByText(/custom connections/)).toBeNull();
    fireEvent.click(within(sections).getByRole('button', { name: 'Turn on Line-up' }));
    expect(screen.queryByText(/custom connections/)).toBeNull();
    expect(screen.getAllByText('Line-up').length).toBeGreaterThan(0);
  });
});

describe('Live preview follows the entries (#1107)', () => {
  it('shows the reply while an entry is typed, and answers a test word like the bot', async () => {
    await openFlow();
    const artists = () => card('2. Search Artists');
    await within(artists()).findByText('Tems');
    const preview = () => screen.getByTestId('live-preview');
    fireEvent.click(within(artists()).getByRole('button', { name: '+ Add artist' }));
    const form = within(artists()).getByRole('group', { name: 'Add artist' });
    fireEvent.change(within(form).getByLabelText(/^Name/), { target: { value: 'Wizkid' } });
    fireEvent.change(within(form).getByLabelText(/^Day/), { target: { value: 'Saturday' } });
    expect(within(preview()).getByText('Type an artist’s name or day.')).toBeTruthy();
    expect(within(preview()).getByText('Wizkid')).toBeTruthy();
    expect(within(preview()).getByText('Wizkid — Saturday — [stage] — [start_time]')).toBeTruthy();
    fireEvent.change(within(form).getByLabelText(/^Stage/), { target: { value: 'Main stage' } });
    fireEvent.change(within(form).getByLabelText(/^Start time/), { target: { value: '9pm' } });
    expect(within(preview()).getByText('Wizkid — Saturday — Main stage — 9pm')).toBeTruthy();
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await within(artists()).findByText('Wizkid');

    // With the step open, the phone's composer tests a word against the saved entries.
    fireEvent.click(screen.getByRole('button', { name: 'Edit 2. Search Artists' }));
    const box = screen.getByLabelText('Test a word');
    fireEvent.change(box, { target: { value: 'wizkid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(within(preview()).getByText('wizkid')).toBeTruthy();
    expect(within(preview()).getByText('Wizkid — Saturday — Main stage — 9pm')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Test a word'), { target: { value: 'pizza' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(within(preview()).getByText('No matching information is available. Try another name, code or keyword.')).toBeTruthy();
    // No request was made for the preview.
    expect(posts.some(post => post.body.action === 'preview')).toBe(false);
  });

  it('a browse step shows the entries as a numbered list', async () => {
    flow.definition.nodes = flow.definition.nodes.map((node: any) => node.id === 'lookup_artists' ? { ...node, mode: 'browse', prompt: 'Reply with a number.' } : node);
    rows['t-artists'].push({ id: 'a2', row_code: 'WIZKID', data: { name: 'Wizkid', day: 'Saturday', stage: 'Main stage', start_time: '9pm' }, position: 1, hidden: false, updated_at: 'r0' });
    await openFlow();
    await within(card('2. Search Artists')).findByText('Wizkid');
    fireEvent.click(screen.getByRole('button', { name: 'Edit 2. Search Artists' }));
    const preview = screen.getByTestId('live-preview');
    expect(within(preview).getAllByText((_, element) => element?.tagName === 'P' && element.textContent === 'Reply with a number.\n\n1. Tems\n2. Wizkid')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Test a word'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(within(screen.getByTestId('live-preview')).getByText('Wizkid — Saturday — Main stage — 9pm')).toBeTruthy();
  });
});

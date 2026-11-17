// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FlowBuilder } from './FlowBuilder';
import { WALKTHROUGH_KEY, Walkthrough } from './Walkthrough';
import { STARTERS } from '@/lib/custom-flow-builder/starters';

// Rendered tests for the #1079 page builder. API traffic is mocked at fetch and
// every payload asserted here is one of the existing actions.
const flowDef = { id: '11111111-1111-4111-8111-111111111111', name: 'Retreat', status: 'draft', greeting: 'Welcome', fallback_message: 'Sorry', entry_keyword: 'RETREAT', start_node: 'menu', nodes: [
  { id: 'menu', type: 'menu', text: 'What would you like?', options: [{ label: 'Program', next: 'program' }, { label: 'Goodbye', next: 'bye' }] },
  { id: 'program', type: 'lookup', table: 'program', search_fields: ['session'], prompt: 'Type a day.', reply: '{{session}} — {{ day }}', no_match: 'Nothing found', next: 'menu' },
  { id: 'bye', type: 'message', text: 'See you', next: null },
] };
const programList = { id: 'list-1', name: 'program', editor_schema_version: 1, updated_at: 'x', columns: [
  { name: 'session', label: 'Session', type: 'text', required: true }, { name: 'day', label: 'Day', type: 'text' }, { name: 'place', label: 'Place', type: 'text' },
] };
type Def = typeof flowDef;
let flow: { id: string; version: number; definition: Def; published_definition: Def | null; published_version: number | null };
let posts: Array<{ url: string; body: Record<string, any> }>;
let failNextTable: boolean;

function dataTransfer() {
  const data: Record<string, string> = {};
  return { data, get types() { return Object.keys(data); }, setData(type: string, value: string) { data[type] = value; }, getData(type: string) { return data[type] ?? ''; }, effectAllowed: 'all', dropEffect: 'none' };
}
beforeEach(() => {
  try { window.localStorage.setItem(WALKTHROUGH_KEY, 'done'); } catch { /* ignore */ }
  flow = { id: flowDef.id, version: 1, definition: structuredClone(flowDef), published_definition: null, published_version: null };
  posts = []; failNextTable = false;
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (!options?.method) {
      if (url.startsWith('/api/custom-flows/data')) return { ok: true, json: async () => ({ tables: [structuredClone(programList)], rows: url.includes('tableId=list-1') ? [{ id: 'r0', row_code: 'H', hidden: true, data: { session: 'Hidden', day: 'No' } }, { id: 'r1', row_code: 'SAT', hidden: false, data: { session: 'Morning prayer', day: 'Saturday' } }] : [] }) };
      return { ok: true, json: async () => ({ flows: [structuredClone(flow)] }) };
    }
    const body = JSON.parse(String(options.body)); posts.push({ url, body });
    if (url === '/api/custom-flows/setup') {
      flow = { id: body.id, version: 1, published_definition: null, published_version: null,
        definition: { id: body.id, name: body.name, status: 'draft', greeting: '', fallback_message: 'x', entry_keyword: body.keyword || null, start_node: 'main_menu',
          guided: { version: 1, template: 'blank', template_version: 1, menu_id: 'main_menu', sections: [] },
          nodes: [{ id: 'main_menu', type: 'menu', text: 'What would you like information about?', options: [] }] } as unknown as Def };
      return { ok: true, json: async () => ({ flow: structuredClone(flow) }) };
    }
    if (url === '/api/custom-flows/data') {
      if (failNextTable) { failNextTable = false; return { ok: false, json: async () => ({ error: 'write_failed' }) }; }
      return { ok: true, json: async () => ({ data: { id: body.id } }) };
    }
    if (body.action === 'save') { flow.definition = body.definition; flow.version++; return { ok: true, json: async () => ({ flow: structuredClone(flow) }) }; }
    return { ok: true, json: async () => ({ messages: [] }) };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); try { window.localStorage.clear(); } catch { /* ignore */ } });

async function openFlow() {
  render(<FlowBuilder businessId="business" />);
  fireEvent.click(await screen.findByRole('option', { name: 'Retreat' }));
}
const map = () => screen.getByRole('region', { name: 'Step map' });
const headings = () => within(map()).getAllByRole('heading', { level: 3 }).map(heading => heading.textContent);
async function saveAndReadDefinition() {
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Saved.');
  return posts.filter(post => post.body.action === 'save').at(-1)!.body.definition as Def;
}

describe('Add a step palette', () => {
  it('adds a step by dragging it onto the flow, and by pressing it', async () => {
    await openFlow();
    const transfer = dataTransfer();
    const chip = screen.getByRole('button', { name: 'Send a message' });
    expect(chip.getAttribute('draggable')).toBe('true');
    fireEvent.dragStart(chip, { dataTransfer: transfer });
    const zone = within(map()).getByText('Drop a step here');
    fireEvent.dragOver(zone, { dataTransfer: transfer });
    fireEvent.drop(zone, { dataTransfer: transfer });
    expect(headings()).toEqual(['1. Show buttons', '2. Search Program', '3. Send a message', '4. Send a message']);
    // Keyboard and pointer equivalent: pressing the chip adds the same step at the end.
    fireEvent.click(screen.getByRole('button', { name: 'Search my list' }));
    expect(headings().at(-1)).toBe('5. Search my list');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(posts).toHaveLength(0);
    const saved = await saveAndReadDefinition();
    expect(saved.nodes.map(node => node.type)).toEqual(['menu', 'lookup', 'message', 'message', 'lookup']);
  });

  it('dropping a step under Show buttons adds it with a new button that goes to it', async () => {
    await openFlow();
    const transfer = dataTransfer();
    fireEvent.dragStart(screen.getByRole('button', { name: 'Show buttons' }), { dataTransfer: transfer });
    const zone = within(map()).getByText('Drop a step here to add it as a new button');
    fireEvent.drop(zone, { dataTransfer: transfer });
    const saved = await saveAndReadDefinition();
    const added = saved.nodes.at(-1)!;
    expect(added.type).toBe('menu');
    expect((saved.nodes[0] as Def['nodes'][0] & { options: Array<{ label: string; next: string }> }).options).toEqual([
      { label: 'Program', next: 'program' }, { label: 'Goodbye', next: 'bye' }, { label: '', next: added.id },
    ]);
  });

  it('marks Soon steps, which add nothing when pressed or dropped', async () => {
    await openFlow();
    const before = headings();
    for (const name of ['Event tickets', 'Giving', 'Take a payment', 'Talk to a person', 'Ask for a reply']) {
      const chip = screen.getByRole('button', { name: new RegExp(`^${name}`) });
      expect(chip.textContent).toContain('Soon');
      expect(chip.getAttribute('aria-disabled')).toBe('true');
      expect(chip.getAttribute('draggable')).toBe('false');
      fireEvent.click(chip);
      expect(screen.getByText(`${name} is coming soon. You can’t add it yet.`)).toBeTruthy();
    }
    // A drag that carries no step (e.g. from a Soon chip) is ignored by the drop target.
    const empty = dataTransfer();
    fireEvent.dragStart(screen.getByRole('button', { name: /^Giving/ }), { dataTransfer: empty });
    fireEvent.drop(within(map()).getByText('Drop a step here'), { dataTransfer: empty });
    expect(screen.getByText('Coming soon:')).toBeTruthy();
    expect(headings()).toEqual(before);
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    expect(posts).toHaveLength(0);
  });
});

describe('Reordering', () => {
  it('moves a step by dragging it onto another step, and by keyboard', async () => {
    await openFlow();
    const transfer = dataTransfer();
    const grips = within(map()).getAllByTitle('Drag to move this step');
    fireEvent.dragStart(grips[2], { dataTransfer: transfer });
    const target = within(map()).getByRole('heading', { name: '1. Show buttons' });
    fireEvent.dragOver(target, { dataTransfer: transfer });
    fireEvent.drop(target, { dataTransfer: transfer });
    expect(headings()).toEqual(['1. Send a message', '2. Show buttons', '3. Search Program']);
    // Keyboard drag on the step order list: Space picks up, arrow moves, Space drops.
    const item = screen.getByRole('button', { name: '1. Send a message' });
    fireEvent.keyDown(item, { key: ' ' });
    fireEvent.keyDown(item, { key: 'ArrowDown' });
    fireEvent.keyDown(item, { key: ' ' });
    await waitFor(() => expect(headings()).toEqual(['1. Show buttons', '2. Send a message', '3. Search Program']));
    const saved = await saveAndReadDefinition();
    expect(saved.nodes.map(node => node.id)).toEqual(['menu', 'bye', 'program']);
    expect(saved.start_node).toBe('menu');
  });

  it('reorders buttons by drag (keyboard) and by the move control, showing where each goes', async () => {
    await openFlow();
    expect(screen.getByRole('button', { name: 'Program → 2. Search Program' })).toBeTruthy();
    const goodbye = screen.getByRole('button', { name: 'Goodbye → 3. Send a message' });
    fireEvent.keyDown(goodbye, { key: ' ' });
    fireEvent.keyDown(goodbye, { key: 'ArrowUp' });
    fireEvent.keyDown(goodbye, { key: ' ' });
    await waitFor(() => expect(within(map()).getByRole('list', { name: 'Options for 1. Show buttons' }).textContent).toMatch(/^Goodbye.*Program/));
    fireEvent.click(screen.getByRole('button', { name: 'Move button down: Goodbye → 3. Send a message' }));
    await waitFor(() => expect(within(map()).getByRole('list', { name: 'Options for 1. Show buttons' }).textContent).toMatch(/^Program.*Goodbye/));
    fireEvent.click(screen.getByRole('button', { name: 'Add a button' }));
    const saved = await saveAndReadDefinition();
    expect((saved.nodes[0] as { options: unknown[] }).options).toEqual([{ label: 'Program', next: 'program' }, { label: 'Goodbye', next: 'bye' }, { label: '', next: '' }]);
  });
});

describe('Plain English', () => {
  it('gives every field a ? tip and an example, and shows no code words', async () => {
    await openFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    for (const label of ['Edit 2. Search Program', 'Edit 3. Send a message']) fireEvent.click(screen.getByRole('button', { name: label }));
    const labels = ['Flow name', 'Greeting', 'When we don’t understand', 'Word people send to start', 'Language', 'Time zone', 'Currency', 'First step',
      'Message above the buttons', 'Button text', 'Goes to', 'Which list', 'Question we ask', 'Reply', 'When nothing matches', 'Then go to', 'Message', 'Picture link (optional)'];
    for (const label of labels) {
      const help = screen.getAllByRole('button', { name: `More about ${label}` })[0];
      const tip = document.getElementById(help.getAttribute('aria-describedby')!)!;
      expect(tip.getAttribute('role')).toBe('tooltip');
      expect(tip.textContent!.length).toBeGreaterThan(10);
      const control = screen.getAllByLabelText(label)[0];
      expect(control.getAttribute('aria-describedby')).toBe(tip.id);
      if (control.tagName !== 'SELECT') expect(control.getAttribute('placeholder') ?? control.getAttribute('data-placeholder')).toMatch(/^Example: /);
    }
    await screen.findByRole('button', { name: 'Insert Place' });
    const text = document.body.textContent!;
    expect(text).not.toMatch(/\blookups?\b/i);
    expect(text).not.toMatch(/\bnodes?\b/i);
    expect(text).not.toMatch(/JSON/);
    expect(text).not.toContain('{{');
    for (const word of ['Publish', 'Draft', 'fallback', 'Entry keyword', 'Start block']) expect(text).not.toContain(word);
  });

  it('builds the reply with Insert chips and keeps the exact stored template', async () => {
    await openFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Edit 2. Search Program' }));
    const editor = screen.getByRole('textbox', { name: 'Reply' });
    expect(editor.textContent).toBe('Session — Day');
    // Live example from the first visible saved row.
    await waitFor(() => expect(screen.getByTestId('reply-example').textContent).toBe('Morning prayer — Saturday'));
    // Rendering the stored reply never edits the draft.
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Insert Place' }));
    expect(editor.textContent).toBe('Session — DayPlace');
    editor.appendChild(document.createTextNode(' today'));
    fireEvent.input(editor);
    expect(screen.getByTestId('reply-example').textContent).toBe('Morning prayer — Saturday today');
    const saved = await saveAndReadDefinition();
    // Original spelling of {{ day }} is kept; new details use the {{column}} form.
    expect((saved.nodes[1] as { reply: string }).reply).toBe('{{session}} — {{ day }}{{place}} today');
    expect(saved.nodes[1]).toMatchObject({ table: 'program', search_fields: ['session'], prompt: 'Type a day.', no_match: 'Nothing found', next: 'menu' });
  });

  it('keeps an unedited reply byte for byte, including line breaks', async () => {
    flow.definition.nodes[1] = { ...flow.definition.nodes[1], reply: '{{session}}\n{{ day }} at {{place}}\n' } as Def['nodes'][1];
    await openFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Edit 2. Search Program' }));
    const editor = screen.getByRole('textbox', { name: 'Reply' });
    fireEvent.input(editor);
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    fireEvent.change(screen.getByLabelText('Question we ask'), { target: { value: 'Type a session.' } });
    const saved = await saveAndReadDefinition();
    expect((saved.nodes[1] as { reply: string }).reply).toBe('{{session}}\n{{ day }} at {{place}}\n');
  });
});

describe('Template gallery', () => {
  it('shows picture cards and builds a starter with only existing actions', async () => {
    render(<FlowBuilder businessId="business" />);
    await screen.findByRole('option', { name: 'Retreat' });
    const gallery = screen.getByRole('region', { name: 'Start a new flow' });
    expect(within(gallery).getAllByRole('button').map(button => button.textContent!.slice(0, 40))).toHaveLength(5);
    for (const title of ['Church retreat', 'Festival / event', 'Restaurant info', 'Salon info', 'Start from scratch']) {
      const card = within(gallery).getByRole('button', { name: title });
      expect(card.getAttribute('aria-describedby')).toBeTruthy();
    }
    fireEvent.click(within(gallery).getByRole('button', { name: 'Church retreat' }));
    expect((screen.getByLabelText('Flow name') as HTMLInputElement).value).toBe('Church retreat');
    fireEvent.change(screen.getByLabelText('Word people send to start'), { target: { value: 'retreat' } });
    failNextTable = true;
    fireEvent.click(screen.getByRole('button', { name: 'Create flow' }));
    await screen.findByText('Your flow was made, but we couldn’t add all its lists. Try again.');
    fireEvent.click(screen.getByRole('button', { name: 'Create flow' }));
    await screen.findByRole('region', { name: 'Flow actions' });
    // Setup once (blank), each list once (the failed one retried), then a normal save.
    expect(posts.map(post => [post.url, post.body.action ?? post.body.template])).toEqual([
      ['/api/custom-flows/setup', 'blank'], ['/api/custom-flows/data', 'create_table'], ['/api/custom-flows/data', 'create_table'],
      ['/api/custom-flows/data', 'create_table'], ['/api/custom-flows', 'save'],
    ]);
    expect(posts[0].body).toMatchObject({ template: 'blank', name: 'Church retreat', keyword: 'RETREAT' });
    expect(posts[1].body.id).toBe(posts[2].body.id);
    expect(posts.slice(2, 4).map(post => [post.body.name, post.body.columns])).toEqual(STARTERS.church_retreat.lists.map(list => [list.name, list.columns]));
    const saved = posts[4].body;
    expect(saved).toMatchObject({ id: posts[0].body.id, version: 1 });
    expect(saved.definition.guided).toEqual({ version: 1, template: 'blank', template_version: 1, menu_id: 'main_menu', sections: [] });
    expect(saved.definition.nodes.map((node: { id: string }) => node.id)).toEqual(['main_menu', 'lookup_program', 'lookup_faqs']);
    expect(saved.definition.nodes[1]).toMatchObject({ type: 'lookup', table: 'Program', reply: '{{session}} — {{day}} {{time}} — {{place}}', next: 'main_menu' });
    expect(screen.getByRole('heading', { name: 'Church retreat', level: 2 })).toBeTruthy();
    // A starter has no guided sections, so it opens ready to edit without the advanced editor.
    expect(screen.queryByText(/Open the advanced editor to change steps/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove this step' })).toBeTruthy();
  });

  it('uses the existing festival setup unchanged', async () => {
    render(<FlowBuilder businessId="business" />);
    await screen.findByRole('option', { name: 'Retreat' });
    fireEvent.click(screen.getByRole('button', { name: 'Festival / event' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create flow' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ url: '/api/custom-flows/setup', body: { template: 'festival_info', name: 'Festival Info', bindings: ['name'] } });
  });
});

describe('First-time walkthrough', () => {
  it('shows three steps once, and stays dismissed in this browser', async () => {
    window.localStorage.clear();
    const { unmount } = render(<Walkthrough />);
    const tour = await screen.findByRole('region', { name: 'Quick tour' });
    expect(within(tour).getByRole('heading').textContent).toBe('Add your list');
    fireEvent.click(within(tour).getByRole('button', { name: 'Next tip' }));
    expect(within(tour).getByRole('heading').textContent).toBe('Try it in the phone');
    fireEvent.click(within(tour).getByRole('button', { name: 'Next tip' }));
    expect(within(tour).getByRole('heading').textContent).toBe('Save, then make it live');
    fireEvent.click(within(tour).getByRole('button', { name: 'Got it' }));
    expect(screen.queryByRole('region', { name: 'Quick tour' })).toBeNull();
    expect(window.localStorage.getItem(WALKTHROUGH_KEY)).toBe('done');
    unmount();
    render(<Walkthrough />);
    await act(async () => {});
    expect(screen.queryByRole('region', { name: 'Quick tour' })).toBeNull();
  });

  it('still works when browser storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    render(<Walkthrough />);
    const tour = await screen.findByRole('region', { name: 'Quick tour' });
    fireEvent.click(within(tour).getByRole('button', { name: 'Skip tour' }));
    expect(screen.queryByRole('region', { name: 'Quick tour' })).toBeNull();
  });
});

// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FlowBuilder } from './FlowBuilder';
import { FlowSetup } from './FlowSetup';
import { LookupSettings } from './LookupSettings';
import { TableEditor } from './TableEditor';
import { WALKTHROUGH_KEY } from './Walkthrough';
import { MOVE_STEP_TYPE, NEW_STEP_TYPE } from './ui';
import { validateDefinition } from '@/lib/bot/custom-flow/definition';
import { createTemplate } from '@/lib/custom-flow-builder/templates';
import { STARTERS } from '@/lib/custom-flow-builder/starters';

// Rendered tests for the #1079 review fixes. API traffic is mocked at fetch;
// validation uses the real, unchanged server validator.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const flowDef = { id: '11111111-1111-4111-8111-111111111111', name: 'Retreat', status: 'draft', greeting: 'Welcome', fallback_message: 'Sorry', entry_keyword: 'RETREAT', start_node: 'menu', nodes: [
  { id: 'menu', type: 'menu', text: 'What would you like?', options: [{ label: 'Program', next: 'program' }, { label: 'Goodbye', next: 'bye' }] },
  { id: 'program', type: 'lookup', table: 'program', search_fields: ['session'], prompt: 'Type a day.', reply: '{{session}}', no_match: 'Nothing found', next: 'menu' },
  { id: 'bye', type: 'message', text: 'See you', next: null },
] } as Record<string, any>;
const programList = { id: 'list-1', name: 'program', editor_schema_version: 1, updated_at: 'x', columns: [
  { name: 'session', label: 'Session', type: 'text', required: true }, { name: 'day', label: 'Day', type: 'text' }, { name: 'place', label: 'Place', type: 'text' },
] };
let flow: Record<string, any>;
let posts: Array<{ url: string; body: Record<string, any> }>;
let hold: null | Promise<void>;

function dataTransfer(data: Record<string, string> = {}) {
  return { data, get types() { return Object.keys(data); }, setData(type: string, value: string) { data[type] = value; }, getData(type: string) { return data[type] ?? ''; }, effectAllowed: 'all', dropEffect: 'none' };
}
beforeEach(() => {
  try { window.localStorage.setItem(WALKTHROUGH_KEY, 'done'); } catch { /* ignore */ }
  flow = { id: flowDef.id, version: 1, definition: structuredClone(flowDef), published_definition: null, published_version: null };
  posts = []; hold = null;
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (!options?.method) {
      if (url.startsWith('/api/custom-flows/data')) return { ok: true, json: async () => ({ tables: [structuredClone(programList)], rows: url.includes('tableId=') ? [{ id: 'r1', row_code: 'SAT', hidden: false, data: { session: 'Morning prayer', day: 'Saturday' } }] : [] }) };
      return { ok: true, json: async () => ({ flows: [structuredClone(flow)] }) };
    }
    const body = JSON.parse(String(options.body)); posts.push({ url, body });
    if (hold) await hold;
    if (body.action === 'validate') {
      const errors = validateDefinition(body.definition);
      return errors.length ? { ok: false, status: 422, json: async () => ({ error: 'invalid_definition', errors }) } : { ok: true, json: async () => ({ errors: [] }) };
    }
    if (body.action === 'save') { flow.definition = body.definition; flow.version++; return { ok: true, json: async () => ({ flow: structuredClone(flow) }) }; }
    return { ok: true, json: async () => ({ messages: [] }) };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); try { window.localStorage.clear(); } catch { /* ignore */ } });

async function openFlow(props: Partial<React.ComponentProps<typeof FlowBuilder>> = {}) {
  render(<FlowBuilder businessId="business" {...props} />);
  fireEvent.click(await screen.findByRole('option', { name: String(flow.definition.name) }));
}
const map = () => screen.getByRole('region', { name: 'Step map' });
const headings = () => within(map()).getAllByRole('heading', { level: 3 }).map(heading => heading.textContent);

describe('Plain-English problems (fix 1)', () => {
  it('names the step instead of showing server ids or code words', async () => {
    await openFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Send a message' }));
    fireEvent.click(screen.getByRole('button', { name: 'Search my list' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check for problems' }));
    const alert = await screen.findByRole('alert');
    const raw = validateDefinition(posts.at(-1)!.body.definition);
    expect(raw.some(message => UUID.test(message) && /node/.test(message))).toBe(true);
    expect(alert.textContent).toContain('Step 4 (Send a message) has no text yet.');
    expect(alert.textContent).toContain('Step 5 (Search my list) needs a list. Choose one in Which list.');
    expect(alert.textContent).not.toMatch(/node|lookup|template|table|\{\{/i);
    expect(alert.textContent).not.toMatch(UUID);
    expect(screen.getByRole('status').textContent).toBe('Some steps aren’t finished yet. Fix them, then try again.');
    expect(screen.getByRole('status').textContent).not.toContain('Try again.');
  });
});

describe('Palette feedback (fix 3) and focus (fix 13)', () => {
  it('scrolls to the added step, focuses its first field and announces it', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    try {
      await openFlow();
      fireEvent.click(screen.getByRole('button', { name: 'Send a message' }));
      const active = document.activeElement as HTMLElement;
      expect(active.tagName).toBe('TEXTAREA');
      expect(within(active.closest('li')!).getByRole('heading', { name: '4. Send a message' })).toBeTruthy();
      expect(scroll).toHaveBeenCalledOnce();
      expect(screen.getByText('Step 4 added').getAttribute('aria-live')).toBe('polite');
    } finally { delete (Element.prototype as Partial<Element>).scrollIntoView; }
  });

  it('moves focus after removing a step or a button, and after the tour', async () => {
    window.localStorage.clear();
    await openFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Custom flows', level: 1 }));
    // The start step (Show buttons) opens by default.
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove button' })[0]);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add a button' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit 3. Goodbye' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove this step' }).at(-1)!);
    expect(headings()).toEqual(['1. Show buttons', '2. Search Program']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit 2. Search Program' }));
  });
});

describe('Pending requests block drag and drop (fix 4)', () => {
  it('ignores palette drops and step moves while a save is pending', async () => {
    await openFlow();
    fireEvent.change(screen.getByLabelText('Message above the buttons'), { target: { value: 'Pick one' } });
    let release!: () => void;
    hold = new Promise(resolve => { release = resolve; });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    const before = headings();
    for (const grip of within(map()).getAllByTitle('Drag to move this step')) expect(grip.getAttribute('draggable')).toBe('false');
    expect(screen.getByRole('button', { name: 'Send a message' }).getAttribute('draggable')).toBe('false');
    for (const zone of [within(map()).getByText('Drop a step here'), within(map()).getByText('Drop a step here to add it as a new button')]) {
      const drop = dataTransfer({ [NEW_STEP_TYPE]: 'message' });
      fireEvent.dragOver(zone, { dataTransfer: drop });
      fireEvent.drop(zone, { dataTransfer: drop });
    }
    const move = dataTransfer({ [MOVE_STEP_TYPE]: 'bye' });
    const target = within(map()).getByRole('heading', { name: '1. Show buttons' });
    fireEvent.dragOver(target, { dataTransfer: move });
    fireEvent.drop(target, { dataTransfer: move });
    expect(headings()).toEqual(before);
    await act(async () => { release(); hold = null; });
    await screen.findByText('Saved.');
    expect(headings()).toEqual(before);
    expect(posts.at(-1)!.body.definition.nodes.map((node: { id: string }) => node.id)).toEqual(['menu', 'program', 'bye']);
  });
});

describe('Starter recovery (fix 5) and plain list names (fix 2)', () => {
  // A small stand-in server: requests land even when their reply is lost.
  let server: { flow: Record<string, any> | null; tables: Map<string, string>; lose: Set<string>; bump: boolean };
  beforeEach(() => {
    server = { flow: null, tables: new Map(), lose: new Set(), bump: false };
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      if (!options?.method) return { ok: true, json: async () => ({ flows: server.flow ? [structuredClone(server.flow)] : [] }) };
      const body = JSON.parse(String(options.body)); posts.push({ url, body });
      const lost = (key: string) => { if (server.lose.delete(key)) throw new TypeError('network'); };
      if (url === '/api/custom-flows/setup') {
        server.flow = { id: body.id, version: 1, published_definition: null, published_version: null, definition: { id: body.id, name: body.name, status: 'draft', greeting: 'Hi', fallback_message: 'x', entry_keyword: null, start_node: 'main_menu',
          guided: { version: 1, template: 'blank', template_version: 1, menu_id: 'main_menu', sections: [] }, nodes: [{ id: 'main_menu', type: 'menu', text: 'What would you like?', options: [] }] } };
        const reply = structuredClone(server.flow);
        if (server.bump) server.flow.version = 5; // changed elsewhere; the blank definition is untouched
        return { ok: true, json: async () => ({ flow: reply }) };
      }
      if (url === '/api/custom-flows/data') {
        if (server.tables.has(body.id)) return { ok: false, status: 409, json: async () => ({ error: 'version_conflict' }) };
        server.tables.set(body.id, body.name);
        lost(`table:${body.name}`);
        return { ok: true, json: async () => ({ data: { id: body.id } }) };
      }
      if (body.version !== server.flow!.version) return { ok: false, status: 409, json: async () => ({ error: 'version_conflict' }) };
      server.flow!.definition = body.definition; server.flow!.version++;
      lost('save');
      return { ok: true, json: async () => ({ flow: structuredClone(server.flow) }) };
    }));
  });

  it('finishes a starter whose list and save replies were lost', async () => {
    const created = vi.fn();
    render(<FlowSetup businessId="business" template="church_retreat" onCreated={created} onCancel={vi.fn()} />);
    server.lose.add('table:Questions'); server.lose.add('save');
    fireEvent.click(screen.getByRole('button', { name: 'Create flow' }));
    await screen.findByText('Unable to save changes. Try again.');
    fireEvent.click(screen.getByRole('button', { name: 'Create flow' }));
    await screen.findByText('Unable to save changes. Try again.');
    fireEvent.click(screen.getByRole('button', { name: 'Create flow' }));
    await waitFor(() => expect(created).toHaveBeenCalledOnce());
    // Each list made once; the replayed list id is accepted; the save is not repeated over itself.
    expect([...server.tables.values()]).toEqual(['Program', 'Questions']);
    expect(posts.filter(post => post.body.action === 'save').map(post => post.body.version)).toEqual([1, 1]);
    expect(server.flow!.version).toBe(2);
    expect(created.mock.calls[0][0].version).toBe(2);
    expect(created.mock.calls[0][0].definition.nodes.map((node: { id: string }) => node.id)).toEqual(['main_menu', 'lookup_program', 'lookup_faqs']);
    // Plain stored list names; step ids stay code-safe.
    expect(created.mock.calls[0][0].definition.tables).toEqual(['Program', 'Questions']);
    expect(created.mock.calls[0][0].definition.nodes[0].options.map((option: { label: string }) => option.label)).toEqual(['Program', 'Questions']);
  });

  it('retries the save once with the fresh version when the blank flow is untouched', async () => {
    const created = vi.fn();
    render(<FlowSetup businessId="business" template="salon_info" onCreated={created} onCancel={vi.fn()} />);
    server.bump = true;
    fireEvent.click(screen.getByRole('button', { name: 'Create flow' }));
    await waitFor(() => expect(created).toHaveBeenCalledOnce());
    expect(posts.filter(post => post.body.action === 'save').map(post => post.body.version)).toEqual([1, 5]);
    expect(created.mock.calls[0][0].definition.tables).toEqual(STARTERS.salon_info.lists.map(list => list.name));
  });

  it('opens the made flow when the merchant cancels after it was created', async () => {
    const created = vi.fn(), cancelled = vi.fn();
    render(<FlowSetup businessId="business" template="restaurant_info" onCreated={created} onCancel={cancelled} />);
    server.lose.add('table:Our menu');
    fireEvent.click(screen.getByRole('button', { name: 'Create flow' }));
    await screen.findByText('Unable to save changes. Try again.');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(created).toHaveBeenCalledOnce());
    expect(created.mock.calls[0][0].id).toBe(server.flow!.id);
    expect(cancelled).not.toHaveBeenCalled();
  });
});

describe('Search my list settings (fixes 6 and 7)', () => {
  it('shows business details like the engine does and hides empty Search by entries', async () => {
    const node = { id: 'program', type: 'lookup' as const, table: 'program', search_fields: ['session', ''], prompt: '', reply: '{{session}} — {{business.operating_hours}}', no_match: 'x', next: null };
    render(<LookupSettings businessId="business" flowId="flow" node={node} lists={[programList as any]} business={{ operating_hours: { monday: { open: '09:00', close: '17:00' } } }}
      onChange={vi.fn()} destination={() => null} />);
    await waitFor(() => expect(screen.getByTestId('reply-example').textContent).toBe('Morning prayer — monday: 09:00–17:00'));
    expect(screen.getByTestId('reply-example').textContent).not.toContain('[object Object]');
    const search = screen.getByRole('group', { name: 'Search by' });
    expect(within(search).getAllByRole('checkbox').map(box => box.closest('label')!.textContent)).toEqual(['Session', 'Day', 'Place']);
  });
});

describe('Small fixes (8–12)', () => {
  it('wraps the start word, explains Short code and Save list, and uses plain help', async () => {
    flow.definition.entry_keyword = 'AVERYLONGSTARTWORDWITHOUTANYSPACES';
    await openFlow();
    expect(screen.getByText('AVERYLONGSTARTWORDWITHOUTANYSPACES', { selector: 'span' }).className).toContain('break-all');
    expect(screen.getByRole('button', { name: 'Edit 3. Goodbye' }).className).toContain('dark:focus-visible:outline-brand-300');
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const language = document.getElementById(screen.getByLabelText('Language').getAttribute('aria-describedby')!)!;
    expect(language.textContent).toContain('en means English');
    expect(screen.getByLabelText('Language').getAttribute('placeholder')).toBe('Example: en for English');
  });

  it('gives list fields a ? tip and says why Save list is off', async () => {
    render(<TableEditor businessId="business" flowId="flow" onDirty={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByRole('option', { name: 'program' });
    fireEvent.click(screen.getByRole('button', { name: 'Add a list' }));
    for (const label of ['List name', 'Column name']) expect(screen.getByRole('button', { name: `More about ${label}` })).toBeTruthy();
    const saveList = screen.getByRole('button', { name: 'Save list' });
    expect(document.getElementById(saveList.getAttribute('aria-describedby')!)!.textContent).toBe('Add a list name to save this list.');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.change(screen.getByLabelText('Choose a list'), { target: { value: 'list-1' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Add row' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
    const tip = document.getElementById(screen.getByRole('button', { name: 'More about Short code' }).getAttribute('aria-describedby')!)!;
    expect(tip.textContent).toMatch(/people see it and can type it/);
    expect(screen.getByRole('textbox', { name: 'Short code' }).getAttribute('placeholder')).toBe('Example: SAT-AM');
    const saveRow = screen.getByRole('button', { name: 'Save list' });
    expect((saveRow as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById(saveRow.getAttribute('aria-describedby')!)!.textContent).toBe('Add a short code to save this row.');
  });

  it('names the section toggle and exposes its state', async () => {
    flow.definition = createTemplate({ id: flowDef.id, businessId: 'business', template: 'festival_info', name: 'Fest', keyword: '', language: 'en', timezone: 'UTC', currency: 'USD', bindings: [] }).definition;
    await openFlow();
    const off = screen.getAllByRole('button', { name: 'Turn section off' })[0];
    expect(document.getElementById(off.getAttribute('aria-describedby')!)!.textContent).toBe('ArtistsOn');
    fireEvent.click(off);
    const on = screen.getByRole('button', { name: 'Turn on Artists' });
    expect(document.getElementById(on.getAttribute('aria-describedby')!)!.textContent).toBe('ArtistsOff');
  });
});

// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FlowBuilder } from './FlowBuilder';
import { WALKTHROUGH_KEY } from './Walkthrough';

// Rendered tests for the #1079 polish (Owner feedback after the staging test):
// hidden flow list with "All flows", one step edited at a time, the live phone
// preview and nothing cut off. API traffic is mocked at fetch; the live preview
// must not make any request.
const LONG = 'A very long button label that a merchant typed for their customers';
const festival = { id: 'fest', name: 'Lagos fest', status: 'draft', greeting: 'Welcome to the fest', fallback_message: 'Try again', entry_keyword: 'FEST', start_node: 'main', nodes: [
  { id: 'main', type: 'menu', text: 'What would you like?', options: [{ label: 'Artists', next: 'artists' }, { label: 'Say goodbye', next: 'bye' }] },
  { id: 'artists', type: 'lookup', table: 'artists', search_fields: ['name'], prompt: 'Type an artist name.', reply: '{{name}}', no_match: 'None' },
  { id: 'bye', type: 'message', text: 'Goodbye for now', next: null },
] };
type Flow = typeof festival;
let flows: Array<{ id: string; version: number; definition: Flow; published_definition: Flow | null; published_version: number | null }>;
let posts: Array<Record<string, unknown>>;

function dataTransfer() {
  const data: Record<string, string> = {};
  return { data, get types() { return Object.keys(data); }, setData(type: string, value: string) { data[type] = value; }, getData(type: string) { return data[type] ?? ''; }, effectAllowed: 'all', dropEffect: 'none' };
}
beforeEach(() => {
  try { window.localStorage.setItem(WALKTHROUGH_KEY, 'done'); } catch { /* ignore */ }
  flows = [{ id: 'fest', version: 1, definition: structuredClone(festival), published_definition: null, published_version: null }];
  posts = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.startsWith('/api/custom-flows/data')) return { ok: true, json: async () => ({ tables: [], rows: [] }) };
    if (!options?.method) return { ok: true, json: async () => ({ flows: structuredClone(flows) }) };
    posts.push(JSON.parse(String(options.body)));
    return { ok: true, json: async () => ({ messages: [] }) };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function openFlow() {
  const view = render(<FlowBuilder businessId="business" />);
  fireEvent.click(await screen.findByRole('option', { name: 'Lagos fest' }));
  return view;
}
const map = () => screen.getByRole('region', { name: 'Step map' });
const live = () => within(screen.getByRole('complementary')).getByTestId('live-preview');
const stepCard = (heading: string) => within(map()).getByRole('heading', { level: 3, name: heading }).closest('li')!;

describe('Flow list while a flow is open', () => {
  it('hides Your flows while editing and shows it again from All flows', async () => {
    render(<FlowBuilder businessId="business" />);
    expect(await screen.findByRole('listbox', { name: 'Custom flows' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'All flows' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Lagos fest' }));
    expect(screen.queryByRole('listbox', { name: 'Custom flows' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Flows' })).toBeNull();
    const back = screen.getByRole('button', { name: 'All flows' });
    fireEvent.click(back);
    expect(screen.getByRole('listbox', { name: 'Custom flows' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Flow actions' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Custom flows', level: 1 }));
    expect(screen.getByText('Showing all flows').getAttribute('aria-live')).toBe('polite');
    expect(posts).toHaveLength(0);
  });
});

describe('Editing one step at a time', () => {
  it('highlights the edited step, labels its editor, focuses it and closes it with Done', async () => {
    await openFlow();
    // The start step opens by default.
    expect(screen.getByRole('heading', { level: 4, name: 'Editing step 1 · Show buttons' })).toBeTruthy();
    const edit = screen.getByRole('button', { name: 'Edit 3. Say goodbye' });
    fireEvent.click(edit);
    expect(edit.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Edit 1. Show buttons' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.getAllByRole('heading', { level: 4, name: /^Editing step/ }).map(heading => heading.textContent)).toEqual(['Editing step 3 · Say goodbye']);
    expect(screen.getAllByRole('button', { name: 'Done' })).toHaveLength(1);
    // Brand outline and an Editing badge on that step only.
    const card = stepCard('3. Say goodbye');
    expect(within(card).getByText('Editing')).toBeTruthy();
    expect(card.querySelector('.ring-brand')).toBeTruthy();
    expect(within(stepCard('1. Show buttons')).queryByText('Editing')).toBeNull();
    expect(stepCard('1. Show buttons').querySelector('.ring-brand')).toBeNull();
    // Focus moves into the editor, on its first field: the button that leads here (#1107).
    const editor = document.getElementById(edit.getAttribute('aria-controls')!)!;
    expect(editor.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLInputElement).value).toBe('Say goodbye');
    expect((within(editor).getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Goodbye for now');
    // The step's "?" tip lives in the editing header.
    expect(within(editor).getByRole('button', { name: 'More about Say goodbye' })).toBeTruthy();
    // The open editor is one named group.
    expect(editor.getAttribute('role')).toBe('group');
    expect(screen.getByRole('group', { name: 'Editing step 3 · Say goodbye' })).toBe(editor);
    fireEvent.click(within(editor).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('heading', { level: 4, name: /^Editing step/ })).toBeNull();
    expect(edit.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(edit);
    expect(posts).toHaveLength(0);
  });

  it('a newly added step becomes the only step being edited', async () => {
    await openFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Send a message' }));
    expect(screen.getAllByRole('heading', { level: 4, name: /^Editing step/ }).map(heading => heading.textContent)).toEqual(['Editing step 4 · Send a message']);
    expect(screen.getAllByRole('button', { name: /^Edit \d/ }).filter(button => button.getAttribute('aria-expanded') === 'true')).toHaveLength(1);
  });
});

describe('Dragging from the palette', () => {
  it('shows a grip and hint, a drag state, and a drop line where the step will land', async () => {
    await openFlow();
    expect(screen.getByText('Drag onto your flow, or tap to add.')).toBeTruthy();
    const chip = screen.getByRole('button', { name: 'Send a message' });
    expect(chip.querySelector('svg')).toBeTruthy();
    const transfer = dataTransfer();
    fireEvent.dragStart(chip, { dataTransfer: transfer });
    expect(chip.getAttribute('data-dragging')).toBe('true');
    const zone = within(map()).getByText('Drop a step here');
    expect(zone.className).toContain('border-brand ');
    fireEvent.dragOver(zone, { dataTransfer: transfer });
    expect(zone.querySelector('[data-drop-line]')).toBeTruthy();
    fireEvent.drop(zone, { dataTransfer: transfer });
    fireEvent.dragEnd(chip);
    expect(chip.getAttribute('data-dragging')).toBeNull();
    expect(zone.querySelector('[data-drop-line]')).toBeNull();
    expect(within(map()).getByRole('heading', { level: 3, name: '4. Send a message' })).toBeTruthy();
  });
});

describe('Live WhatsApp preview', () => {
  it('shows what the flow sends and updates on add, edit and move, without any request', async () => {
    await openFlow();
    expect(within(live()).getByText('Welcome to the fest')).toBeTruthy();
    expect(within(live()).getByText('What would you like?')).toBeTruthy();
    expect(within(within(live()).getByRole('list', { name: 'Buttons' })).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Artists', 'Say goodbye']);
    const preview = screen.getByRole('complementary');
    expect(within(preview).getByText('Preview: step 1')).toBeTruthy();
    // Options are shown, not tappable: Try it is the interactive chat.
    expect(within(live()).queryByRole('button')).toBeNull();

    // Edit: the edited step's message, as the customer sees it.
    fireEvent.click(screen.getByRole('button', { name: 'Edit 3. Say goodbye' }));
    expect(within(preview).getByText('Preview: step 3')).toBeTruthy();
    expect(within(live()).getByText('Goodbye for now')).toBeTruthy();
    expect(within(live()).queryByText('Welcome to the fest')).toBeNull();
    fireEvent.change(within(document.getElementById('flow-step-bye')!).getByLabelText('Message'), { target: { value: 'See you soon' } });
    expect(within(live()).getByText('See you soon')).toBeTruthy();

    // Add: a date question shows the date list the bot sends.
    fireEvent.click(screen.getByRole('button', { name: /^Pick a date/ }));
    expect(within(preview).getByText('Preview: step 4')).toBeTruthy();
    expect(within(live()).getByText(/Choose a date/)).toBeTruthy();
    expect(within(within(live()).getByRole('list', { name: 'List choices' })).getAllByRole('listitem').at(-1)!.textContent).toBe('Another date');
    const dateEditor = document.getElementById(screen.getByRole('button', { name: 'Edit 4. Pick a date' }).getAttribute('aria-controls')!)!;
    fireEvent.change(within(dateEditor).getByLabelText('Question'), { target: { value: 'Which day will you arrive?' } });
    expect(within(live()).getByText('Which day will you arrive?')).toBeTruthy();

    // Move: the same step is now step 3, and the label follows it.
    fireEvent.click(screen.getByRole('button', { name: 'Move up: 4. Pick a date' }));
    expect(within(preview).getByText('Preview: step 3')).toBeTruthy();
    expect(within(live()).getByText('Which day will you arrive?')).toBeTruthy();

    // Closing the editor goes back to the opening: greeting, then the first step.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(within(preview).getByText('Preview: start')).toBeTruthy();
    expect(within(live()).getByText('Welcome to the fest')).toBeTruthy();
    expect(posts).toHaveLength(0);
  });

  it('follows a start message chain and edits to the greeting', async () => {
    flows[0].definition = { ...festival, start_node: 'bye', nodes: [festival.nodes[2], { ...festival.nodes[1] }, festival.nodes[0]].map(node => node.id === 'bye' ? { ...node, next: 'main' } : node) } as unknown as Flow;
    await openFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(Array.from(live().querySelectorAll('p')).map(p => p.textContent)).toEqual(['Welcome to the fest', 'Goodbye for now', 'What would you like?', 'Select Try it to chat with it.']);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.change(screen.getByLabelText('Greeting'), { target: { value: 'Hello there' } });
    expect(within(live()).getByText('Hello there')).toBeTruthy();
    expect(posts).toHaveLength(0);
  });
});

describe('Nothing cut off', () => {
  it('stacks each Show buttons row in the narrow editor instead of using page-width columns', async () => {
    await openFlow();
    const rows = screen.getAllByTestId('button-row');
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.className).not.toMatch(/\b(sm|md|lg|xl):grid-cols-/);
  });

  it('lets each Step order row wrap so Move up and Move down sit under the step name', async () => {
    await openFlow();
    const item = screen.getByRole('button', { name: '1. Show buttons' });
    expect(item.className).toContain('basis-full');
    expect(item.parentElement!.className).toContain('flex-wrap');
  });

  it('uses no truncate, ellipsis or line-clamp classes on buttons, placeholders, chips or palette items', async () => {
    flows[0].definition = { ...festival, name: `${LONG} flow`, entry_keyword: 'AVERYLONGSTARTWORDTHATKEEPSGOING',
      nodes: [{ ...festival.nodes[0], options: [{ label: LONG, next: 'artists' }, { label: 'Say goodbye', next: 'bye' }] }, festival.nodes[1], festival.nodes[2]] } as Flow;
    const view = render(<FlowBuilder businessId="business" />);
    const truncating = /\b(truncate|text-ellipsis|line-clamp-\d+|overflow-ellipsis)\b/;
    const offenders = () => Array.from(view.container.querySelectorAll<HTMLElement>('button, [placeholder], [role="option"], li, span, p, h2, h3, h4'))
      .filter(element => truncating.test(element.getAttribute('class') ?? ''));
    await screen.findByRole('option', { name: `${LONG} flow` });
    expect(offenders()).toEqual([]);
    fireEvent.click(screen.getByRole('option', { name: `${LONG} flow` }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    for (const name of [`Edit 2. Search ${LONG}`, 'Edit 3. Say goodbye', 'Edit 1. Show buttons']) {
      fireEvent.click(screen.getByRole('button', { name }));
      expect(offenders()).toEqual([]);
    }
    // The long label is shown whole on the canvas. The phone keeps WhatsApp's 20-letter button limit, like the bot, and says so.
    expect(within(map()).getByText(LONG)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(within(live()).getByText(LONG.slice(0, 20))).toBeTruthy();
    expect(within(live()).getByText('WhatsApp shows the first 20 letters of each choice.')).toBeTruthy();
    for (const element of view.container.querySelectorAll('[placeholder]')) expect(element.getAttribute('class') ?? '').not.toMatch(truncating);
  });
});

// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FlowBuilder } from './FlowBuilder';

// Rendered tests for the #1074 layout: flow list, step map, settings panel and
// WhatsApp-style preview. API traffic is mocked at fetch; the payloads are the
// existing ones and must not change.
const festival = { id: 'fest', name: 'Lagos fest', status: 'draft', greeting: 'Welcome', fallback_message: 'Try again', entry_keyword: 'FEST', start_node: 'main', nodes: [
  { id: 'main', type: 'menu', text: 'What would you like?', options: [{ label: 'Artists', next: 'artists' }, { label: 'Say goodbye', next: 'bye' }, { label: 'Broken', next: 'gone' }] },
  { id: 'artists', type: 'lookup', table: 'artists', search_fields: ['name'], prompt: 'Type an artist name.', reply: '{{name}}', no_match: 'None' },
  { id: 'bye', type: 'message', text: 'Goodbye for now', next: null },
] };
const plain = { id: 'plain', name: 'Opening hours', status: 'draft', greeting: 'Hi', fallback_message: 'Sorry', nodes: [
  { id: 'a', type: 'message', text: 'We open at 9', next: null },
] };
type Flow = typeof festival | typeof plain;
let flows: Array<{ id: string; version: number; definition: Flow; published_definition: Flow | null; published_version: number | null }>;
let posts: Array<Record<string, any>>;
beforeEach(() => {
  flows = [
    { id: 'fest', version: 1, definition: structuredClone(festival), published_definition: structuredClone(festival), published_version: 1 },
    { id: 'plain', version: 1, definition: structuredClone(plain), published_definition: null, published_version: null },
  ];
  posts = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.startsWith('/api/custom-flows/data')) return { ok: true, json: async () => ({ tables: [], rows: [] }) };
    if (!options?.method) return { ok: true, json: async () => ({ flows: structuredClone(flows) }) };
    const body = JSON.parse(String(options.body)); posts.push(body);
    if (['save', 'publish', 'restore'].includes(body.action)) {
      const flow = flows.find(item => item.id === body.id)!;
      if (body.action === 'save') { flow.definition = body.definition; flow.version++; }
      return { ok: true, json: async () => ({ flow: structuredClone(flow) }) };
    }
    if (body.action === 'validate') return { ok: true, json: async () => ({ errors: [] }) };
    return { ok: true, json: async () => ({ messages: [] }) };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function openFlow(name: string, details = {}) {
  render(<FlowBuilder businessId="business" businessDetails={details} />);
  fireEvent.click(await screen.findByRole('option', { name }));
}

describe('Your flows list', () => {
  it('filters by name, shows Draft or Live, and selects a flow by click or keyboard', async () => {
    render(<FlowBuilder businessId="business" />);
    const list = await screen.findByRole('listbox', { name: 'Custom flows' });
    expect(within(list).getAllByRole('option').map(option => option.textContent)).toEqual(['Lagos festLive', 'Opening hoursNot live yet']);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search flows' }), { target: { value: 'open' } });
    expect(within(screen.getByRole('listbox', { name: 'Custom flows' })).getAllByRole('option').map(option => option.textContent)).toEqual(['Opening hoursNot live yet']);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search flows' }), { target: { value: 'zzz' } });
    expect(screen.getByText('No flows match your search.')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search flows' }), { target: { value: '' } });
    const first = screen.getByRole('option', { name: 'Lagos fest' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Opening hours' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(screen.getByRole('heading', { name: 'Opening hours' })).toBeTruthy();
    // #1079 polish: the list hides while a flow is open; "All flows" brings it back with that flow selected.
    expect(screen.queryByRole('listbox', { name: 'Custom flows' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All flows' }));
    expect(screen.getByRole('option', { name: 'Opening hours' }).getAttribute('aria-selected')).toBe('false');
    expect(posts).toHaveLength(0);
  });

  it('locks the list while the draft has unsaved changes', async () => {
    await openFlow('Opening hours');
    fireEvent.change(screen.getByLabelText('Greeting'), { target: { value: 'Changed' } });
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    // #1079 polish: the list is hidden while a flow is open; its "All flows" way back is locked instead.
    const back = screen.getByRole('button', { name: 'All flows' }) as HTMLButtonElement;
    expect(back.disabled).toBe(true);
    fireEvent.click(back);
    expect(screen.queryByRole('listbox', { name: 'Custom flows' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Opening hours' })).toBeTruthy();
    expect((screen.getByLabelText('Greeting') as HTMLInputElement).value).toBe('Changed');
    const hint = document.getElementById(back.getAttribute('aria-describedby')!)!;
    expect(hint.textContent).toBe('Save or discard changes to switch flows.');
    expect(screen.getByText('Save or discard changes to switch flows.')).toBe(hint);
  });

  it('treats a click or Enter on the already-selected flow as a no-op', async () => {
    await openFlow('Lagos fest');
    const edit = screen.getByRole('button', { name: 'Edit 3. Send a message' });
    fireEvent.click(edit);
    fireEvent.change(screen.getByLabelText('Message', { selector: 'textarea' }), { target: { value: 'Changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    // #1079 polish: the list is hidden while the flow is open, so the selected flow cannot be chosen again.
    expect(screen.queryByRole('option', { name: 'Lagos fest' })).toBeNull();
    // choose() would have closed the open editor and cleared the notice.
    expect(edit.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Saved.')).toBeTruthy();
    expect(screen.queryByText('Save or discard changes to switch flows.')).toBeNull();
  });
});

describe('Step map', () => {
  it('draws start, every step, menu branches and terminal pills', async () => {
    await openFlow('Lagos fest');
    const map = screen.getByRole('region', { name: 'Step map' });
    expect(within(map).getByText('Someone sends FEST')).toBeTruthy();
    for (const heading of ['1. Show buttons', '2. Search Artists', '3. Send a message']) expect(within(map).getByRole('heading', { name: heading })).toBeTruthy();
    const branches = within(map).getByRole('list', { name: 'Options for 1. Show buttons' });
    expect(within(branches).getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'Artists→goes to2. Search Artists', 'Say goodbye→goes to3. Send a message', 'Broken→goes toNot connected yet',
    ]);
    // Lookup without next returns to the start step at runtime; a message with next null ends.
    expect(within(map).getByText('Back to start')).toBeTruthy();
    expect(within(map).getByText('Ends')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Flow actions' })).getByText('Live')).toBeTruthy();
  });

  it('starts at the start step when there is no entry keyword', async () => {
    await openFlow('Opening hours');
    expect(within(screen.getByRole('region', { name: 'Step map' })).getByText('Starts at 1. Send a message')).toBeTruthy();
    expect(screen.getAllByText('Not live yet').length).toBeGreaterThan(0);
  });

  // ~5-6 s in jsdom under full-suite load (same pattern as the template-labels test). Assertions unchanged.
  it('opens a step editor in place when the step is clicked, without any request', async () => {
    await openFlow('Lagos fest');
    const edit = screen.getByRole('button', { name: 'Edit 3. Send a message' });
    expect(edit.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByDisplayValue('Goodbye for now')).toBeNull();
    fireEvent.click(edit);
    expect(edit.getAttribute('aria-expanded')).toBe('true');
    const editor = document.getElementById(edit.getAttribute('aria-controls')!)!;
    expect((within(editor).getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Goodbye for now');
    fireEvent.change(within(editor).getByLabelText('Message'), { target: { value: 'See you soon' } });
    expect(within(screen.getByRole('region', { name: 'Step map' })).getByText('See you soon', { selector: 'p' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Go live' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(edit);
    expect(screen.queryByLabelText('Message', { selector: 'textarea' })).toBeNull();
    expect(posts).toHaveLength(0);
  });

  it('keeps open step editors after save, check, publish and reset of the same flow, and resets them for another flow', async () => {
    await openFlow('Lagos fest');
    const editButton = () => screen.getByRole('button', { name: 'Edit 3. Send a message' });
    fireEvent.click(editButton());
    // #1079 polish: one step is edited at a time, so opening step 3 closes the start step.
    expect(screen.getByRole('button', { name: 'Edit 1. Show buttons' }).getAttribute('aria-expanded')).toBe('false');
    fireEvent.change(screen.getByLabelText('Message', { selector: 'textarea' }), { target: { value: 'Bye' } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    for (const [button, notice] of [['Save', 'Saved.'], ['Check for problems', 'No problems found.'], ['Go live', 'Your flow is live.'], ['Go back to live version', 'Back to the live version.']]) {
      fireEvent.click(screen.getByRole('button', { name: button }));
      await screen.findByText(notice);
      expect(editButton().getAttribute('aria-expanded')).toBe('true');
      expect(screen.getByRole('button', { name: 'Edit 1. Show buttons' }).getAttribute('aria-expanded')).toBe('false');
    }
    expect(posts.map(post => post.action)).toEqual(['save', 'validate', 'publish', 'restore']);
    fireEvent.click(screen.getByRole('button', { name: 'All flows' }));
    fireEvent.click(screen.getByRole('option', { name: 'Opening hours' }));
    expect(screen.getByRole('button', { name: 'Edit 1. Send a message' }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'All flows' }));
    fireEvent.click(screen.getByRole('option', { name: 'Lagos fest' }));
    expect(editButton().getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: 'Edit 1. Show buttons' }).getAttribute('aria-expanded')).toBe('true');
  }, 15_000);

  it('treats any empty message next as Ends and any empty lookup next as Back to start', async () => {
    // Engine rule: a message continues only `if (node.next)`; a lookup falls back to the start step.
    flows[1].definition = { ...plain, nodes: [
      { id: 'a', type: 'message', text: 'Empty string next', next: '' },
      { id: 'b', type: 'message', text: 'Undefined next' },
      { id: 'c', type: 'lookup', table: 'faqs', search_fields: ['question'], reply: 'x', no_match: 'y', next: '' },
    ] } as unknown as typeof plain;
    await openFlow('Opening hours');
    const map = screen.getByRole('region', { name: 'Step map' });
    expect(within(map).getAllByText('Ends')).toHaveLength(2);
    expect(within(map).getAllByText('Back to start')).toHaveLength(1);
    expect(within(map).queryByText(/Not connected yet|Goes to/)).toBeNull();
  });

  it('keeps settings in a panel opened from the top bar', async () => {
    await openFlow('Lagos fest');
    const settings = screen.getByRole('button', { name: 'Settings' });
    expect(settings.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('textbox', { name: 'Greeting' })).toBeNull();
    fireEvent.click(settings);
    expect(settings.getAttribute('aria-expanded')).toBe('true');
    expect((screen.getByRole('textbox', { name: 'Greeting' }) as HTMLInputElement).value).toBe('Welcome');
    expect(screen.getByRole('combobox', { name: 'First step' })).toBeTruthy();
  });
});

describe('WhatsApp preview', () => {
  it('renders customer and bot bubbles, images and option buttons from the preview response', async () => {
    await openFlow('Lagos fest', { name: 'Lagos Fest Ltd' });
    const preview = screen.getByRole('complementary');
    expect(within(preview).getByText('Lagos Fest Ltd')).toBeTruthy();
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [
      { text: 'Welcome' }, { text: 'What would you like?', options: [{ label: 'Artists', value: 'cf:main:0' }, { label: 'Say goodbye', value: 'cf:main:1' }] },
      { text: 'Artists', input: true }, { text: 'Type an artist name.', image: 'https://example.com/poster.png' },
    ] }) } as Response);
    fireEvent.click(within(preview).getByRole('button', { name: 'Restart preview' }));
    await within(preview).findByText('Type an artist name.');
    const row = (text: string) => within(preview).getByText(text, { selector: 'p' }).closest('.flex')!;
    expect(row('Welcome').className).toContain('justify-start');
    expect(row('Artists').className).toContain('justify-end');
    expect(row('Type an artist name.').className).toContain('justify-start');
    expect(row('Type an artist name.').querySelector('img')!.getAttribute('src')).toBe('https://example.com/poster.png');
    // Options before the latest customer input are history and stay disabled.
    for (const name of ['Artists', 'Say goodbye']) expect((within(preview).getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    const requests = vi.mocked(fetch).mock.calls.filter(call => call[1]?.method === 'POST').map(call => JSON.parse(String(call[1]!.body)));
    expect(requests.map(request => [request.action, request.inputs])).toEqual([['preview', []]]);
    await waitFor(() => expect(preview.getAttribute('aria-busy')).toBe('false'));
  });
});

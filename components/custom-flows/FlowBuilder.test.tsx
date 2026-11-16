// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FlowBuilder } from './FlowBuilder';
import { createTemplate } from '@/lib/custom-flow-builder/templates';

const definition = { id: 'flow', name: 'Saved flow', status: 'draft', greeting: 'Welcome', fallback_message: 'Try again', nodes: [
  { id: 'a', type: 'message', text: 'First', next: 'b' }, { id: 'b', type: 'message', text: 'Last', next: null },
] };
let row: { id: string; version: number; definition: typeof definition; published_definition: typeof definition; published_version: number };
let calls: Array<Record<string, any>>;
beforeEach(() => {
  row = { id: 'flow', version: 1, definition: structuredClone(definition), published_definition: structuredClone(definition), published_version: 1 };
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
    if (_url.startsWith('/api/custom-flows/data')) return {ok:true,json:async()=>({tables:[],rows:[]})};
    if (!options?.method) return { ok: true, json: async () => ({ flows: [structuredClone(row)] }) };
    const body = JSON.parse(String(options.body)); calls.push(body);
    if (_url === '/api/custom-flows/setup') {
      body.action='setup';
      row.definition=createTemplate({...body,timezone:'Africa/Lagos',currency:'NGN'}).definition as typeof definition;
      row.id=body.id;row.version=1;
    }
    if (body.action === 'create') { row.definition = body.definition; row.version = 1; }
    if (body.action === 'save') { row.definition = body.definition; row.version++; }
    if (body.action === 'restore') { row.definition = structuredClone(row.published_definition); row.version++; }
    if (body.action === 'publish') { row.published_definition = structuredClone(row.definition); row.version++; row.published_version++; }
    if (body.action === 'validate') return { ok: true, json: async () => ({ errors: [] }) };
    if (body.action === 'preview') return { ok: true, json: async () => ({ messages: [{ text: body.definition.greeting }] }) };
    return { ok: true, json: async () => ({ flow: structuredClone(row) }) };
  }));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function open() {
  render(<FlowBuilder businessId="business" />);
  await screen.findByRole('option', { name: 'Saved flow' });
  // Layout change (#1074): the flow dropdown is now the "Your flows" listbox.
  fireEvent.click(screen.getByRole('option', { name: 'Saved flow' }));
}

describe('FlowBuilder user journeys', () => {
  it('creates, saves, validates, previews, publishes, edits and resets a new flow', async () => {
    render(<FlowBuilder businessId="business" />);
    await screen.findByRole('option', { name: 'Saved flow' });
    fireEvent.click(screen.getByRole('button', { name: 'Start blank' }));
    fireEvent.change(screen.getByLabelText('Flow name'), { target: { value: 'New flow' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    fireEvent.click(await screen.findByRole('button', {name:'Advanced editor'}));
    fireEvent.click(screen.getByRole('button', {name:'Remove block'}));
    fireEvent.change(screen.getByLabelText('Greeting'), { target: { value: 'New greeting' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add message' }));
    fireEvent.change(screen.getAllByLabelText('Message').find(element => element.tagName === 'TEXTAREA')!, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText('Draft saved.');
    fireEvent.click(screen.getByRole('button', { name: 'Check for problems' }));
    await screen.findByText('No validation errors.');
    fireEvent.click(screen.getByRole('button', { name: 'Restart preview' }));
    await screen.findByText('New greeting');
    fireEvent.click(screen.getByRole('button', { name: 'Publish flow' }));
    await screen.findByText('Flow published.');
    fireEvent.change(screen.getByLabelText('Greeting'), { target: { value: 'Unsaved replacement' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset draft to published' }));
    await screen.findByText('Draft reset to published.');
    expect((screen.getByLabelText('Greeting') as HTMLInputElement).value).toBe('New greeting');
    expect(calls.map(call => call.action)).toEqual(['setup','save', 'validate', 'preview', 'publish', 'restore']);
  });

  it('keeps reorder draft-only until save and explicit publish', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Move up: 2. Message' }));
    expect(calls).toHaveLength(0);
    expect((screen.getByRole('button', { name: 'Publish flow' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText('Draft saved.');
    expect(calls[0].definition.nodes.map((node: Record<string, string>) => node.id)).toEqual(['b', 'a']);
    expect(calls[0].definition.start_node).toBe('b');
    expect(calls[0].definition.nodes.map((node: Record<string, string>) => node.next)).toEqual(['a', null]);
    expect(row.published_definition.nodes[0].id).toBe('a');
    fireEvent.click(screen.getByRole('button', { name: 'Publish flow' }));
    await screen.findByText('Flow published.');
    expect(calls[1].action).toBe('publish');
    expect(calls[1].version).toBe(2);
    expect(row.published_definition.nodes[0].id).toBe('b');
  });

  it('restores published content into unsaved draft through the reset action', async () => {
    await open();
    fireEvent.change(screen.getByLabelText('Greeting'), { target: { value: 'Unsaved' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset draft to published' }));
    await screen.findByText('Draft reset to published.');
    expect((screen.getByLabelText('Greeting') as HTMLInputElement).value).toBe('Welcome');
    expect(calls[0].action).toBe('restore');
    expect(row.published_version).toBe(1);
  });

  it('previews unsaved content without calling save or publish', async () => {
    await open();
    fireEvent.change(screen.getByLabelText('Greeting'), { target: { value: 'Draft greeting' } });
    fireEvent.click(screen.getByRole('button', { name: 'Restart preview' }));
    await screen.findByText('Draft greeting');
    expect(calls.map(call => call.action)).toEqual(['preview']);
    expect(row.definition.greeting).toBe('Welcome');
  });

  it('shows an unset menu destination and allows selecting the first block', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Add menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add option' }));
    const select = screen.getByLabelText('Destination') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(select.selectedOptions[0].textContent).toBe('Choose a destination');
    fireEvent.change(select, { target: { value: 'a' } });
    expect(select.value).toBe('a');
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText('Draft saved.');
    expect(calls[0].definition.nodes.at(-1).options[0].next).toBe('a');
  });

  it('labels template destinations and headings without changing option values or saved connections', async () => {
    const template = createTemplate({ id: 'flow', businessId: 'business', template: 'festival_info', name: 'Saved flow', keyword: '', language: 'en', timezone: 'UTC', currency: 'USD', bindings: [] }).definition;
    row.definition = template as typeof definition;
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Advanced editor' }));
    const labels = ['1. Menu prompt', '2. Artists — Lookup', '3. Vendors — Lookup', '4. Ticket Types — Lookup', '5. News — Lookup', '6. FAQs — Lookup'];
    // Layout change (#1074): step editors open from the step map; the start step opens by default.
    for (const label of labels.slice(1)) fireEvent.click(screen.getByRole('button', { name: `Edit ${label}` }));
    expect(screen.getAllByLabelText('Next step')).toHaveLength(5);
    for (const label of labels) {
      expect(screen.getByRole('heading', { name: label })).toBeTruthy();
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    const destinations = screen.getAllByLabelText('Destination') as HTMLSelectElement[];
    expect(destinations.map(select => select.value)).toEqual(template.nodes[0].type === 'menu' ? template.nodes[0].options.map(option => option.next) : []);
    for (const select of [...destinations, screen.getByLabelText('Start block'), ...screen.getAllByLabelText('Next step')] as HTMLSelectElement[]) {
      expect(Array.from(select.options).filter(option => option.value).map(option => [option.value, option.textContent])).toEqual(template.nodes.map((node, index) => [node.id, labels[index]]));
    }
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText('Draft saved.');
    expect(calls[0].definition.nodes).toEqual(template.nodes);
    expect(calls[0].definition.start_node).toBe(template.start_node);
    expect(calls[0].definition.guided).toEqual(template.guided);
  });

  it('labels custom tables and keeps an unconfigured lookup generic', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Add lookup' }));
    expect(screen.getByRole('heading', { name: '3. Lookup prompt' })).toBeTruthy();
    const start = screen.getByLabelText('Start block') as HTMLSelectElement;
    const lookupId = start.options[start.options.length - 1].value;
    fireEvent.change(screen.getByLabelText('Table name', { selector: 'textarea' }), { target: { value: 'community_events' } });
    expect(screen.getByRole('heading', { name: '3. Community Events — Lookup' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '3. Community Events — Lookup' })).toBeTruthy();
    expect(start.options[start.options.length - 1].value).toBe(lookupId);
    expect(start.options[start.options.length - 1].textContent).toBe('3. Community Events — Lookup');
  });

  it('shows validation rejection and success beside the bottom actions without changing the flow', async () => {
    await open();
    const before = structuredClone(row);
    const validate = screen.getByRole('button', { name: 'Check for problems' });
    const actions = validate.parentElement!.parentElement!;
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'incomplete_sections', errors: ['A selected section needs information.'] }) } as Response);
    fireEvent.click(validate);
    await within(actions).findByRole('status');
    expect(within(actions).getByRole('status').textContent).toBe('Add complete visible information to each selected section, or turn that section off.');
    expect(within(actions).getByRole('alert').textContent).toBe('A selected section needs information.');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    fireEvent.click(validate);
    await within(actions).findByText('No validation errors.');
    expect(within(actions).queryByRole('alert')).toBeNull();
    expect(row).toEqual(before);
    expect(calls.map(call => call.action)).toEqual(['validate']);
  });

  it('keeps publish confirmation and displays a confirmed rejection beside Publish', async () => {
    await open();
    const before = structuredClone(row);
    const publish = screen.getByRole('button', { name: 'Publish flow' });
    const actions = publish.parentElement!.parentElement!;
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    const requestsBefore = vi.mocked(fetch).mock.calls.length;
    fireEvent.click(publish);
    expect(window.confirm).toHaveBeenCalledWith('Publish this draft? Customers will use these changes.');
    expect(vi.mocked(fetch).mock.calls).toHaveLength(requestsBefore);
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'incomplete_sections' }) } as Response);
    fireEvent.click(publish);
    await within(actions).findByText('Add complete visible information to each selected section, or turn that section off.');
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)![1]!.body)).action).toBe('publish');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(row).toEqual(before);
  });

  it('shows preview failure beside preview and clears earlier action feedback', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Check for problems' }));
    await screen.findByText('No validation errors.');
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'preview_unavailable' }) } as Response);
    fireEvent.click(screen.getByRole('button', { name: 'Restart preview' }));
    await within(screen.getByRole('complementary')).findByText('Unable to preview this draft. Check the flow and try again.');
    expect(screen.queryByText('No validation errors.')).toBeNull();
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('disables historical preview choices while keeping the current return menu and restart usable', async () => {
    await open();
    const before = structuredClone(row);
    const preview = screen.getByRole('complementary');
    const menu = { text: 'Choose a section', options: [{ label: 'Artists', value: 'cf:main:0' }, { label: 'Vendors', value: 'cf:main:1' }] };
    const info = { text: 'Information after the menu.' };
    const respond = (messages: unknown[]) => vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ messages }) } as Response);
    const requests = () => vi.mocked(fetch).mock.calls.filter(call => call[1]?.method === 'POST').map(call => JSON.parse(String(call[1]!.body)));
    respond([menu, info]);
    fireEvent.click(within(preview).getByRole('button', { name: 'Restart preview' }));
    const artists = await within(preview).findByRole('button', { name: 'Artists' });
    expect((artists as HTMLButtonElement).disabled).toBe(false);
    const lookup = [menu, info, { text: 'Artists', input: true }, { text: 'Type an artist name.' }];
    respond(lookup);
    fireEvent.click(artists);
    await within(preview).findByText('Type an artist name.');
    for (const label of ['Artists', 'Vendors']) {
      const oldOption = within(preview).getByRole('button', { name: label }) as HTMLButtonElement;
      expect(oldOption.disabled).toBe(true);
      const beforeClick = requests().length;
      fireEvent.click(oldOption);
      expect(requests()).toHaveLength(beforeClick);
    }
    const reply = within(preview).getByRole('textbox', { name: 'Message' });
    fireEvent.change(reply, { target: { value: 'Tems' } });
    const result = [...lookup, { text: 'Tems', input: true }, { text: 'Tems performs on Friday.' }, { text: 'Continue', options: [{ label: 'Return to menu', value: 'cf:return:0' }] }, info];
    respond(result);
    fireEvent.click(within(preview).getByRole('button', { name: 'Preview draft' }));
    const back = await within(preview).findByRole('button', { name: 'Return to menu' });
    expect((back as HTMLButtonElement).disabled).toBe(false);
    respond([...result, { text: 'Return to menu', input: true }, menu, info]);
    fireEvent.click(back);
    await waitFor(() => expect(within(preview).getAllByRole('button', { name: 'Artists' })).toHaveLength(2));
    expect((within(preview).getAllByRole('button', { name: 'Artists' })[0] as HTMLButtonElement).disabled).toBe(true);
    expect((within(preview).getAllByRole('button', { name: 'Artists' })[1] as HTMLButtonElement).disabled).toBe(false);
    respond([menu, info]);
    fireEvent.click(within(preview).getByRole('button', { name: 'Restart preview' }));
    await waitFor(() => expect(within(preview).getAllByRole('button', { name: 'Artists' })).toHaveLength(1));
    expect((within(preview).getByRole('button', { name: 'Artists' }) as HTMLButtonElement).disabled).toBe(false);
    expect(requests().map(request => request.inputs)).toEqual([[], ['cf:main:0'], ['cf:main:0', 'Tems'], ['cf:main:0', 'Tems', 'cf:return:0'], []]);
    expect(requests().every(request => request.action === 'preview')).toBe(true);
    expect(row).toEqual(before);
  });

  it('scrolls only the transcript to each latest preview response without moving focus', async () => {
    await open();
    render(<button>Outside preview</button>);
    const outside = screen.getByRole('button', { name: 'Outside preview' });
    outside.focus();
    const preview = screen.getByRole('complementary');
    const transcript = preview.querySelector('[aria-live="polite"]') as HTMLDivElement;
    let contentHeight = 1000;
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, get: () => contentHeight });
    const windowScroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [{ text: 'First preview response.' }] }) } as Response);
    fireEvent.click(within(preview).getByRole('button', { name: 'Restart preview' }));
    await within(preview).findByText('First preview response.');
    expect(transcript.scrollTop).toBe(1000);
    transcript.scrollTop = 100;
    contentHeight = 2000;
    fireEvent.change(within(preview).getByRole('textbox', { name: 'Message' }), { target: { value: 'Next' } });
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [{ text: 'First preview response.' }, { text: 'Next', input: true }, { text: 'Latest preview response.' }] }) } as Response);
    fireEvent.click(within(preview).getByRole('button', { name: 'Preview draft' }));
    await within(preview).findByText('Latest preview response.');
    expect(transcript.scrollTop).toBe(2000);
    expect(windowScroll).not.toHaveBeenCalled();
    expect(document.documentElement.scrollTop).toBe(0);
    expect(document.activeElement).toBe(outside);
  });

  it('shows preview loading locally and retains retry controls with the existing error', async () => {
    await open();
    const preview = screen.getByRole('complementary');
    const restart = within(preview).getByRole('button', { name: 'Restart preview' }) as HTMLButtonElement;
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    fireEvent.click(restart);
    expect(preview.getAttribute('aria-busy')).toBe('true');
    expect(restart.disabled).toBe(true);
    await act(async () => finish({ ok: false, json: async () => ({ error: 'preview_unavailable' }) } as Response));
    expect(within(preview).getByRole('status').textContent).toBe('Unable to preview this draft. Check the flow and try again.');
    expect(preview.getAttribute('aria-busy')).toBe('false');
    expect(restart.disabled).toBe(false);
  });

  it('keeps initial load failure visible without an open editor', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, json: async () => ({}) } as Response);
    render(<FlowBuilder businessId="business" />);
    await screen.findByText('Unable to load flows. Try again.');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Check for problems' })).toBeNull();
  });

  it('retains edits on a stale-save response', async () => {
    await open();
    fireEvent.change(screen.getByLabelText('Greeting'), { target: { value: 'Keep this edit' } });
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'version_conflict' }) } as Response);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText('Another editor changed this flow. Reload before saving.');
    expect((screen.getByLabelText('Greeting') as HTMLInputElement).value).toBe('Keep this edit');
    expect(row.definition.greeting).toBe('Welcome');
  });
});

// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  fireEvent.change(screen.getByRole('combobox', { name: 'Custom flows' }), { target: { value: 'flow' } });
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
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
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
    const validate = screen.getByRole('button', { name: 'Validate' });
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
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    await screen.findByText('No validation errors.');
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'preview_unavailable' }) } as Response);
    fireEvent.click(screen.getByRole('button', { name: 'Restart preview' }));
    await within(screen.getByRole('complementary')).findByText('Unable to preview this draft. Check the flow and try again.');
    expect(screen.queryByText('No validation errors.')).toBeNull();
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('keeps initial load failure visible without an open editor', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, json: async () => ({}) } as Response);
    render(<FlowBuilder businessId="business" />);
    await screen.findByText('Unable to load flows. Try again.');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Validate' })).toBeNull();
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

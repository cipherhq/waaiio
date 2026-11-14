// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FlowBuilder } from './FlowBuilder';

const definition = { id: 'flow', name: 'Saved flow', status: 'draft', greeting: 'Welcome', fallback_message: 'Try again', nodes: [
  { id: 'a', type: 'message', text: 'First', next: 'b' }, { id: 'b', type: 'message', text: 'Last', next: null },
] };
let row: { id: string; version: number; definition: typeof definition; published_definition: typeof definition; published_version: number };
let calls: Array<Record<string, any>>;
beforeEach(() => {
  row = { id: 'flow', version: 1, definition: structuredClone(definition), published_definition: structuredClone(definition), published_version: 1 };
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
    if (!options?.method) return { ok: true, json: async () => ({ flows: [structuredClone(row)] }) };
    const body = JSON.parse(String(options.body)); calls.push(body);
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
    fireEvent.click(screen.getByRole('button', { name: 'New flow' }));
    fireEvent.change(screen.getByLabelText('Flow name'), { target: { value: 'New flow' } });
    fireEvent.change(screen.getByLabelText('Greeting'), { target: { value: 'New greeting' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add message' }));
    fireEvent.change(screen.getAllByLabelText('Message').find(element => element.tagName === 'TEXTAREA')!, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText('Draft saved.');
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    await screen.findByText('No validation errors.');
    fireEvent.click(screen.getByRole('button', { name: 'Restart preview' }));
    await screen.findByText('New greeting');
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await screen.findByText('Flow published.');
    fireEvent.change(screen.getByLabelText('Greeting'), { target: { value: 'Unsaved replacement' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset draft to published' }));
    await screen.findByText('Draft reset to published.');
    expect((screen.getByLabelText('Greeting') as HTMLInputElement).value).toBe('New greeting');
    expect(calls.map(call => call.action)).toEqual(['create', 'validate', 'preview', 'publish', 'restore']);
  });

  it('keeps reorder draft-only until save and explicit publish', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Move up: 2. Message' }));
    expect(calls).toHaveLength(0);
    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText('Draft saved.');
    expect(calls[0].definition.nodes.map((node: Record<string, string>) => node.id)).toEqual(['b', 'a']);
    expect(calls[0].definition.start_node).toBe('b');
    expect(calls[0].definition.nodes.map((node: Record<string, string>) => node.next)).toEqual(['a', null]);
    expect(row.published_definition.nodes[0].id).toBe('a');
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
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

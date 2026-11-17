// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FlowBuilder } from './FlowBuilder';
import { WALKTHROUGH_KEY } from './Walkthrough';

// Rendered tests for "Use what you already have" steps (#1086). API traffic is
// mocked at fetch; the record picker reads the existing sources route.
const EVENT = 'e0000000-0000-4000-8000-000000000001';
const OFFERING = 'a0000000-0000-4000-8000-000000000001';
const flowDef = { id: '11111111-1111-4111-8111-111111111111', name: 'Retreat', status: 'draft', greeting: 'Welcome', fallback_message: 'Sorry', entry_keyword: 'RETREAT', start_node: 'menu', nodes: [
  { id: 'menu', type: 'menu', text: 'What would you like?', options: [{ label: 'Program', next: 'bye' }] },
  { id: 'bye', type: 'message', text: 'See you', next: null },
] as Array<Record<string, unknown>> };
type Def = typeof flowDef;
let flow: { id: string; version: number; definition: Def; published_definition: Def | null; published_version: number | null };
let posts: Array<Record<string, any>>;
let sourceUrls: string[];
let failSources = false;
let noGiving = false;
let nextPost: (body: Record<string, any>) => { ok: boolean; json: () => Promise<unknown> } | null;

function dataTransfer() {
  const data: Record<string, string> = {};
  return { data, get types() { return Object.keys(data); }, setData(type: string, value: string) { data[type] = value; }, getData(type: string) { return data[type] ?? ''; }, effectAllowed: 'all', dropEffect: 'none' };
}
beforeEach(() => {
  try { window.localStorage.setItem(WALKTHROUGH_KEY, 'done'); } catch { /* ignore */ }
  flow = { id: flowDef.id, version: 1, definition: structuredClone(flowDef), published_definition: null, published_version: null };
  posts = []; sourceUrls = []; nextPost = () => null; failSources = false; noGiving = false;
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (!options?.method) {
      if (url.startsWith('/api/custom-flows/sources')) {
        sourceUrls.push(url);
        if (failSources) return { ok: false, json: async () => ({ error: 'read_failed' }) };
        const records = url.includes('kind=event') ? [{ id: EVENT, name: 'Youth Retreat 2026', detail: '2026-12-12' }]
          : url.includes('kind=giving') && !noGiving ? [{ id: OFFERING, name: 'Sunday Offering' }] : [];
        return { ok: true, json: async () => ({ records }) };
      }
      if (url.startsWith('/api/custom-flows/data')) return { ok: true, json: async () => ({ tables: [] }) };
      return { ok: true, json: async () => ({ flows: [structuredClone(flow)] }) };
    }
    const body = JSON.parse(String(options.body)); posts.push(body);
    const override = nextPost(body);
    if (override) return override;
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
async function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Saved.');
  return posts.filter(post => post.action === 'save').at(-1)!.definition as Def;
}

describe('Use what you already have', () => {
  it('shows the four steps as working, not Soon', async () => {
    await openFlow();
    for (const name of ['Event tickets', 'Giving', 'Take a payment', 'Talk to a person']) {
      const chip = screen.getByRole('button', { name });
      expect(chip.textContent).not.toContain('Soon');
      expect(chip.getAttribute('aria-disabled')).toBeNull();
      expect(chip.getAttribute('draggable')).toBe('true');
    }
  });

  it('adds Event tickets, picks one of the business\'s events, and saves the step', async () => {
    await openFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Event tickets' }));
    expect(headings()).toEqual(['1. Show buttons', '2. Send a message', '3. Event tickets']);
    const picker = await screen.findByLabelText('Which event');
    await screen.findByRole('option', { name: 'Youth Retreat 2026 — 2026-12-12' });
    expect(sourceUrls.at(-1)).toContain('kind=event');
    expect(sourceUrls.at(-1)).toContain('businessId=business');
    fireEvent.change(picker, { target: { value: EVENT } });
    expect(screen.getByText('Next, people continue in Event tickets: Youth Retreat 2026. They see your usual steps and pay the usual way.')).toBeTruthy();
    expect(within(map()).getByText('Continues in Event tickets')).toBeTruthy();
    const stored = await save();
    expect(stored.nodes.at(-1)).toMatchObject({ type: 'handoff', capability: 'ticketing', record_id: EVENT });
  });

  it('dropping Giving on a Show buttons step adds a button that goes to it; Let people choose stores no record', async () => {
    await openFlow();
    const transfer = dataTransfer();
    fireEvent.dragStart(screen.getByRole('button', { name: 'Giving' }), { dataTransfer: transfer });
    const zone = within(map()).getByText('Drop a step here to add it as a new button');
    fireEvent.dragOver(zone, { dataTransfer: transfer });
    fireEvent.drop(zone, { dataTransfer: transfer });
    expect(headings()).toEqual(['1. Show buttons', '2. Send a message', '3. Giving']);
    const picker = await screen.findByLabelText('Which giving option');
    await screen.findByRole('option', { name: 'Sunday Offering' });
    expect((picker as HTMLSelectElement).value).toBe('');
    const stored = await save();
    const giving = stored.nodes.at(-1)!;
    expect(giving).toEqual({ id: giving.id, type: 'handoff', capability: 'giving' });
    expect((stored.nodes[0] as { options: Array<{ next: string }> }).options.at(-1)!.next).toBe(giving.id);
  });

  it('gives each setting a ? tip and uses plain English only', async () => {
    await openFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Take a payment' }));
    await screen.findByLabelText('Which payment option');
    for (const label of ['Which feature', 'Which payment option']) {
      const help = screen.getByRole('button', { name: `More about ${label}` });
      const tip = document.getElementById(help.getAttribute('aria-describedby')!)!;
      expect(tip.getAttribute('role')).toBe('tooltip');
      expect(tip.textContent).toMatch(/Example: /);
      expect(screen.getByLabelText(label).getAttribute('aria-describedby')).toBe(tip.id);
    }
    expect(await screen.findByText('You have no active options yet. Add one on your Services page.')).toBeTruthy();
    const text = document.body.textContent!;
    for (const word of [/\bhandoff\b/i, /\bcapabilit/i, /record_id/, /\bticketing\b/, /\bnodes?\b/i]) expect(text).not.toMatch(word);
  });

  it('switching to Talk to a person drops the chosen record and hides the picker', async () => {
    await openFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Event tickets' }));
    fireEvent.change(await screen.findByLabelText('Which event'), { target: { value: EVENT } });
    fireEvent.change(screen.getByLabelText('Which feature'), { target: { value: 'chat' } });
    expect(screen.queryByLabelText('Which event')).toBeNull();
    expect(screen.getByText('Next, people continue in Talk to a person. Their messages appear on your Chat page.')).toBeTruthy();
    const stored = await save();
    expect(stored.nodes.at(-1)).toEqual({ id: stored.nodes.at(-1)!.id, type: 'handoff', capability: 'chat' });
  });

  it('warns when a saved event is no longer available, only after the list has loaded', async () => {
    flow.definition.nodes.push({ id: 'tix', type: 'handoff', capability: 'ticketing', record_id: 'e0000000-0000-4000-8000-0000000000ff' });
    await openFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Edit 3. Event tickets' }));
    // First render: still loading, the saved choice is shown as chosen and no alert is raised.
    expect(screen.queryByText('The one you picked is no longer available. Choose another, or let people choose.')).toBeNull();
    expect(screen.getByRole('option', { name: 'Your chosen event' })).toBeTruthy();
    await screen.findByRole('option', { name: 'Youth Retreat 2026 — 2026-12-12' });
    expect(screen.getByText('The one you picked is no longer available. Choose another, or let people choose.')).toBeTruthy();
  });

  it('keeps the saved choice visible when the list fails, and Try again reloads it', async () => {
    flow.definition.nodes.push({ id: 'tix', type: 'handoff', capability: 'ticketing', record_id: EVENT });
    failSources = true;
    await openFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Edit 3. Event tickets' }));
    expect(await screen.findByText('We couldn’t load your list.')).toBeTruthy();
    expect((screen.getByLabelText('Which event') as HTMLSelectElement).selectedOptions[0].textContent).toBe('Your chosen event');
    failSources = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('option', { name: 'Youth Retreat 2026 — 2026-12-12' });
    expect((screen.getByLabelText('Which event') as HTMLSelectElement).value).toBe(EVENT);
    expect(screen.queryByText('We couldn’t load your list.')).toBeNull();
  });

  it('points Giving with no options to Donation Options', async () => {
    noGiving = true;
    await openFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Giving' }));
    expect(await screen.findByText('You have no active giving options yet. Add one under Donation Options.')).toBeTruthy();
  });

  it('shows the preview line as a note, and a plain message when Go live finds an unavailable record', async () => {
    flow.definition.nodes.push({ id: 'tix', type: 'handoff', capability: 'ticketing', record_id: EVENT });
    nextPost = body => body.action === 'preview'
      ? { ok: true, json: async () => ({ messages: [{ text: 'Welcome' }, { text: 'Next, people continue in Event tickets: Youth Retreat 2026. They see your usual steps and pay the usual way.', note: true }] }) }
      : body.action === 'publish' ? { ok: false, json: async () => ({ error: 'unavailable_handoff_record', nodes: ['tix'], errors: [] }) } : null;
    await openFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Try it' }));
    const note = await screen.findByText('Next, people continue in Event tickets: Youth Retreat 2026. They see your usual steps and pay the usual way.');
    expect(note.tagName).toBe('P');
    expect(note.closest('[aria-live]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go live' }));
    expect(await screen.findByText('Step 3 (Event tickets) uses an event or option that is no longer available. Open it and choose again.')).toBeTruthy();
  });
});

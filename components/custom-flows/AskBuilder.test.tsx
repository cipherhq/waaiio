// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FlowBuilder } from './FlowBuilder';
import { WALKTHROUGH_KEY } from './Walkthrough';
import { previewDraft } from '@/lib/custom-flow-builder/preview';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { EditableFlow } from '@/lib/custom-flow-builder/order';

// Rendered tests for "Ask a question" steps (#1085). API traffic is mocked at
// fetch; the Try it preview test runs the real engine through previewDraft.
const flowDef = { id: '11111111-1111-4111-8111-111111111111', name: 'Retreat', status: 'draft', greeting: 'Welcome', fallback_message: 'Sorry', entry_keyword: 'RETREAT',
  timezone: 'Africa/Lagos', start_node: 'menu', nodes: [
    { id: 'menu', type: 'menu', text: 'What would you like?', options: [{ label: 'Program', next: 'bye' }] },
    { id: 'bye', type: 'message', text: 'See you', next: null },
  ] as Array<Record<string, unknown>> };
type Def = typeof flowDef;
let flow: { id: string; version: number; definition: Def; published_definition: Def | null; published_version: number | null };
let posts: Array<Record<string, any>>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-16T10:00:00Z'));
  try { window.localStorage.setItem(WALKTHROUGH_KEY, 'done'); } catch { /* ignore */ }
  flow = { id: flowDef.id, version: 1, definition: structuredClone(flowDef), published_definition: null, published_version: null };
  posts = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (!options?.method) {
      if (url.startsWith('/api/custom-flows/data')) return { ok: true, json: async () => ({ tables: [] }) };
      return { ok: true, json: async () => ({ flows: [structuredClone(flow)] }) };
    }
    const body = JSON.parse(String(options.body)); posts.push(body);
    if (body.action === 'save') { flow.definition = body.definition; flow.version++; return { ok: true, json: async () => ({ flow: structuredClone(flow) }) }; }
    return { ok: true, json: async () => ({ messages: [] }) };
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); try { window.localStorage.clear(); } catch { /* ignore */ } });

async function openFlow(country?: string) {
  render(<FlowBuilder businessId="business" country={country} />);
  fireEvent.click(await screen.findByRole('option', { name: 'Retreat' }));
}
const map = () => screen.getByRole('region', { name: 'Step map' });
async function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Saved.');
  return posts.filter(post => post.action === 'save').at(-1)!.definition as Def;
}

describe('Ask a question', () => {
  it('adds a Pick one question with tips, examples and choices, and saves the stored shape', async () => {
    await openFlow();
    fireEvent.click(screen.getByRole('button', { name: /^Pick one/ }));
    const step = within(map()).getByRole('heading', { level: 3, name: '3. Pick one' }).closest('li')!;
    // Every field has a "?" tip and an example placeholder.
    const question = within(step).getByLabelText('Question') as HTMLTextAreaElement;
    expect(question.placeholder).toBe('Example: Which meal would you like?');
    expect(within(step).getByRole('button', { name: 'More about Question' })).toBeTruthy();
    fireEvent.change(question, { target: { value: 'Which meal?' } });
    fireEvent.change(within(step).getByLabelText('Choice 1'), { target: { value: 'Rice' } });
    fireEvent.change(within(step).getByLabelText('Choice 2'), { target: { value: 'Beans' } });
    fireEvent.click(within(step).getByRole('button', { name: 'Add a choice' }));
    fireEvent.change(within(step).getByLabelText('Choice 3'), { target: { value: 'Yam' } });
    fireEvent.click(within(step).getByRole('button', { name: 'Remove choice 2' }));
    fireEvent.change(within(step).getByLabelText('If the answer can’t be used (optional)'), { target: { value: 'Tap one of the meals.' } });
    expect(screen.getByText(/A question asks people for one answer and saves it on your Flow answers page/)).toBeTruthy();
    const saved = await save();
    expect(saved.nodes.at(-1)).toEqual({ id: expect.any(String), type: 'ask', answer_type: 'choice', question: 'Which meal?', options: ['Rice', 'Yam'],
      retry_message: 'Tap one of the meals.', next: null });
  });

  it('a date question shows the friendly upcoming days and the full confirmation, and can allow past dates', async () => {
    await openFlow();
    fireEvent.click(screen.getByRole('button', { name: /^Pick a date/ }));
    const step = within(map()).getByRole('heading', { level: 3, name: '3. Pick a date' }).closest('li')!;
    const days = within(within(step).getByRole('list', { name: 'Date choices people see' })).getAllByRole('listitem').map(item => item.textContent);
    expect(days).toEqual(['Mon 16 Nov', 'Tue 17 Nov', 'Wed 18 Nov', 'Thu 19 Nov', 'Fri 20 Nov', 'Sat 21 Nov', 'Sun 22 Nov', 'Another date']);
    expect(within(step).getByText(/“✅ Monday, 16 November 2026”/)).toBeTruthy();
    fireEvent.change(within(step).getByLabelText('Question'), { target: { value: 'Date of birth?' } });
    fireEvent.click(within(step).getByRole('checkbox', { name: /Allow dates before today/ }));
    const saved = await save();
    expect(saved.nodes.at(-1)).toMatchObject({ type: 'ask', answer_type: 'date', question: 'Date of birth?', allow_past: true });
  });

  it('a Photo or PDF question explains the limits and that Try it cannot send files', async () => {
    await openFlow();
    fireEvent.click(screen.getByRole('button', { name: /^Photo or PDF/ }));
    const step = within(map()).getByRole('heading', { level: 3, name: '3. Photo or PDF' }).closest('li')!;
    expect(within(step).getByText(/a PDF, up to 10 MB/)).toBeTruthy();
    expect(within(step).getByText(/Try it can’t send files/)).toBeTruthy();
    expect(within(step).getByRole('link', { name: 'Flow answers' }).getAttribute('href')).toBe('/dashboard/custom-flows/responses');
  });

  it('shows no code words in question settings', async () => {
    await openFlow();
    for (const name of ['Yes or no', 'Short answer']) fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }));
    const found = map().textContent!.match(/\b(node|answer_type|yes_no|retry_message|null|undefined)\b|\{\{/);
    expect(found?.[0]).toBeUndefined();
  });
});

describe('Try it preview runs the real engine (#1085)', () => {
  const draft = { ...flowDef, start_node: 'q', nodes: [
    { id: 'q', type: 'ask', answer_type: 'date', question: 'Which day will you arrive?', next: 'bye' },
    { id: 'bye', type: 'message', text: 'See you', next: null },
  ] } as unknown as EditableFlow;
  // Read-only tables for the preview: the business is entitled and in GB.
  const readonly = {
    from: (table: string) => {
      const rows: Record<string, unknown[]> = {
        businesses: [{ id: 'business', status: 'active', subscription_tier: 'business', trial_ends_at: null, feature_trial_ends_at: null, category: 'other', country_code: 'GB' }],
        business_capabilities: [{ business_id: 'business', capability: 'custom_flow', is_enabled: true }], capability_overrides: [],
      };
      const query: any = { data: rows[table] ?? [], select: () => query, eq: () => query, order: () => query, in: () => query, limit: () => query,
        maybeSingle: async () => ({ data: (rows[table] ?? [])[0] ?? null, error: null }), single: async () => ({ data: (rows[table] ?? [])[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ data: rows[table] ?? [], error: null }) };
      return query;
    },
  } as unknown as SupabaseClient;

  it('shows the friendly date list, then the full date, and saves nothing for real', async () => {
    const messages = await previewDraft(readonly, 'business', draft, ['cf:q:date:2026-11-21']);
    const question = messages.find(m => m.text === 'Which day will you arrive?')!;
    expect(question.options!.map(o => o.label)).toEqual(['Mon 16 Nov', 'Tue 17 Nov', 'Wed 18 Nov', 'Thu 19 Nov', 'Fri 20 Nov', 'Sat 21 Nov', 'Sun 22 Nov', 'Another date']);
    expect(messages.map(m => m.text).slice(-3)).toEqual(['Sat 21 Nov', '✅ Saturday, 21 November 2026', 'See you']);
  });
});

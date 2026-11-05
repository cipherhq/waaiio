import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ result: { data: [] as unknown[], error: null as unknown }, projections: [] as string[] }));
vi.mock('@/lib/supabase', () => ({ adminDb: { from: (table: string) => {
  const query = {
    select: (columns: string) => { if (table === 'bot_sessions') mocks.projections.push(columns); return query; },
    order: () => query, limit: () => query, in: () => query,
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(
      table === 'bot_sessions' ? mocks.result : { data: table === 'businesses' ? [{ id: 'b1', name: 'QA Business' }] : [], error: null },
    ).then(resolve),
  };
  return query;
} } }));
import ChatHistory from '../pages/ChatHistory';

beforeEach(() => { mocks.result = { data: [], error: null }; mocks.projections.length = 0; });
afterEach(cleanup);

it.each([
  [{ active_capability: 'ordering', business_category: 'shop' }, 'ordering'],
  [{ business_category: 'shop' }, 'shop'],
])('renders the supported session flow %j', async (session_data, expected) => {
  mocks.result.data = [{ id: 'session1', business_id: 'b1', whatsapp_number: 'qa-phone', session_data, current_step: 'choose', is_active: true, conversation_log: [], created_at: '2026-10-31T00:00:00Z', last_active_at: null }];
  render(<ChatHistory />);
  expect(await screen.findByText('QA Business')).toBeInTheDocument();
  expect(screen.getByText(expected as string)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Bot Sessions (1)' })).toBeInTheDocument();
  expect(mocks.projections[0]).toContain('session_data');
  expect(mocks.projections[0]).not.toContain('flow_type');
});

it('keeps a genuine empty list separate from a failed query', async () => {
  render(<ChatHistory />);
  expect(await screen.findByText('No bot sessions found')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('reports bot query failures without claiming zero sessions', async () => {
  mocks.result = { data: [], error: { message: 'unavailable' } };
  render(<ChatHistory />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load bot sessions');
  expect(screen.getByRole('button', { name: 'Bot Sessions (unavailable)' })).toBeInTheDocument();
  expect(screen.queryByText('No bot sessions found')).not.toBeInTheDocument();
});

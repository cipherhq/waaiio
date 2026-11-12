// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import FormsPage from '@/app/dashboard/forms/page';

const state = vi.hoisted(() => ({
  businessId: 'business-a', error: null as unknown, rows: [] as unknown[],
  filters: [] as Array<[string, unknown]>,
  pending: null as null | Promise<{ data: unknown[]; error: null }>,
}));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => ({ id: state.businessId, country_code: 'NG' }) }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/components/dashboard/forms/FormSendPanel', () => ({ FormSendPanel: () => null }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ from: (table: string) => {
  let missingColumn = false;
  const chain = {
    select: (columns: string) => {
      // M119 + M437, independently checked in staging: these columns do not exist.
      missingColumn = table === 'form_responses' && /business_notes|\bstatus\b|\bchannel\b/.test(columns);
      return chain;
    },
    eq: (key: string, value: unknown) => { if (table === 'form_responses') state.filters.push([key, value]); return chain; },
    neq: (key: string) => { if (key === 'status') missingColumn = true; return chain; },
    order: async () => {
      if (table === 'forms') return { data: [{
        id: 'form-a', title: 'Programme registration', description: null, token: 'form-token',
        is_active: true, response_count: 1, created_at: '2026-11-11',
        fields: Array.from({ length: 6 }, (_, i) => ({ id: `f_${i}`, label: `Question ${i + 1}`, type: 'text', required: false })),
      }], error: null };
      if (missingColumn) return { data: null, error: { code: '42703', message: 'Column does not exist' } };
      return state.pending ?? { data: state.rows, error: state.error };
    },
  };
  return chain;
} }) }));

beforeEach(() => {
  state.businessId = 'business-a'; state.error = null; state.filters = []; state.pending = null;
  state.rows = [{ id: 'response-a', customer_name: 'Ada', customer_phone: '+15555550123', customer_email: null,
    answers: { f_0: 'First answer', f_5: 'Last answer' }, submission_source: 'native', consent_given: true, submitted_at: '2026-11-11T12:00:00Z' }];
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function openResponses() {
  const button = await screen.findByRole('button', { name: 'View Responses (1)' });
  await act(async () => { fireEvent.click(button); });
}

describe('#591 native form responses dashboard', () => {
  it('reads the actual schema, scopes to this business and shows every answer', async () => {
    render(<FormsPage />); await openResponses();
    expect(await screen.findByText('Ada')).toBeTruthy();
    expect(screen.getByText('Last answer')).toBeTruthy();
    expect(screen.getByText('WhatsApp', { exact: true })).toBeTruthy();
    expect(state.filters).toEqual([['form_id', 'form-a'], ['business_id', 'business-a']]);
    expect(screen.queryByPlaceholderText('Add note...')).toBeNull();
    expect(screen.getByText(/confirmation is tracked separately/)).toBeTruthy();
  });

  it('shows answers retained from an earlier published revision', async () => {
    state.rows = [{ id: 'old', customer_name: 'Earlier signup', answers: { retired: 'Preserved answer' }, submission_source: 'native', submitted_at: '2026-11-11',
      metadata: { form_config: { fields: [{ id: 'retired', label: 'Former question', type: 'text' }] } } }];
    render(<FormsPage />); await openResponses();
    expect(await screen.findByText('Former question')).toBeTruthy(); expect(screen.getByText('Preserved answer')).toBeTruthy();
  });

  it('shows a failed read and retries without falsely claiming there are no responses', async () => {
    state.error = { message: 'Unavailable' };
    render(<FormsPage />); await openResponses();
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load responses');
    expect(screen.queryByText(/No responses yet/)).toBeNull();
    state.error = null;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(await screen.findByText('Ada')).toBeTruthy();
  });

  it('discards a response read that finishes after switching businesses', async () => {
    let finish!: (result: { data: unknown[]; error: null }) => void;
    state.pending = new Promise(resolve => { finish = resolve; });
    const view = render(<FormsPage />); await openResponses();
    expect(screen.getByRole('status').textContent).toContain('Loading');
    state.businessId = 'business-b'; view.rerender(<FormsPage />);
    await act(async () => { finish({ data: state.rows, error: null }); });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(screen.queryByText('Ada')).toBeNull();
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import FormsPage from '@/app/dashboard/forms/page';
const state = vi.hoisted(() => ({ rows: [] as unknown[], readError: null as unknown, saveError: null as unknown, insert: vi.fn() }));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => ({ id: 'biz', country_code: 'NG' }) }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ from: () => {
  const chain = { select: () => chain, eq: () => chain, order: async () => ({ data: state.rows, error: state.readError }), insert: async (row: unknown) => { state.insert(row); if (!state.saveError) state.rows = [{ ...(row as object), id: 'saved', response_count: 0, created_at: new Date().toISOString() }]; return { error: state.saveError }; } };
  return chain;
} }) }));
beforeEach(() => { state.rows = []; state.readError = null; state.saveError = null; state.insert.mockClear(); });
afterEach(cleanup);
async function fillForm() {
  fireEvent.click((await screen.findAllByRole('button', { name: '+ New Form' }))[0]);
  fireEvent.change(screen.getByPlaceholderText('e.g. Guest Registration, Patient Intake'), { target: { value: 'QA form' } });
  fireEvent.change(screen.getByPlaceholderText('Field label (e.g. Full Name)'), { target: { value: 'Response' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
}
describe('forms save and load failures', () => {
  it('keeps editor and entered content on rejected save, then supports retry', async () => {
    state.saveError = { message: 'Rejected' };
    render(<FormsPage />); await fillForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create Form' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not save');
    expect((screen.getByPlaceholderText('e.g. Guest Registration, Patient Intake') as HTMLInputElement).value).toBe('QA form');
    expect(screen.queryByText('No forms yet')).toBeNull();
    state.saveError = null;
    fireEvent.click(screen.getByRole('button', { name: 'Create Form' }));
    await screen.findByRole('heading', { name: 'Forms' });
    await screen.findByText('QA form');
    expect(state.insert).toHaveBeenCalledTimes(2);
  });
  it('shows read errors instead of false empty state and retries', async () => {
    state.readError = { message: 'Unavailable' };
    render(<FormsPage />);
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load forms');
    expect(screen.queryByText('No forms yet')).toBeNull();
    state.readError = null;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByText('No forms yet')).toBeTruthy();
  });
});

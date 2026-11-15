// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], from: vi.fn(), update: vi.fn(), finish: vi.fn(), filters: [] as unknown[][] }));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => ({ id: 'tenant-a', name: 'Demo', country_code: 'NG', category: 'salon', flow_type: 'scheduling', subscription_tier: 'free' }) }));
vi.mock('@/hooks/useCategoryConfig', () => ({ useCategoryConfig: () => ({ labels: { defaultHasPrice: true, serviceName: 'Service', serviceNamePlural: 'Services', personLabelPlural: 'Customers' } }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ from: m.from }) }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/components/dashboard/ServiceIntakeSettings', () => ({ ServiceIntakeSettings: () => null }));
vi.mock('@/components/dashboard/ItemTaxFields', () => ({ ItemTaxFields: () => null }));
import ServicesPage from '../page';
const service = (status: string, isClass = false) => ({ id: 's1', name: isClass ? 'Yoga' : 'Haircut', status, is_active: status === 'active', is_class: isClass, price: 100, deposit_amount: 0, metadata: {}, class_schedule: [], available_days: [], gallery_urls: [], staff_ids: [], billing_type: 'one_time' });
beforeEach(() => {
  vi.clearAllMocks(); m.filters = []; m.rows = [service('active')];
  m.finish.mockImplementation(async () => ({ data: { id: 's1', status: 'inactive', is_active: false }, error: null }));
  m.from.mockImplementation((table: string) => {
    let writing = false;
    const q: Record<string, unknown> = {};
    for (const name of ['select', 'neq', 'order', 'or', 'gte', 'in', 'limit']) q[name] = () => q;
    for (const name of ['eq', 'is']) q[name] = (...args: unknown[]) => { if (writing) m.filters.push([name, ...args]); return q; };
    q.update = (patch: unknown) => { writing = true; m.update(table, patch); return q; };
    q.maybeSingle = () => m.finish();
    q.then = (resolve: (result: unknown) => unknown) => Promise.resolve({ data: table === 'services' ? m.rows : [], error: null }).then(resolve);
    return q;
  });
});
afterEach(cleanup);
describe('service tile status control', () => {
  it.each([false, true])('deactivates a tile without opening edit, class=%s', async isClass => {
    m.rows = [service('active', isClass)]; render(<ServicesPage />);
    const name = isClass ? 'Yoga' : 'Haircut';
    const button = await screen.findByRole('button', { name: `Active: ${name}` });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.className).toContain('min-h-[44px]');
    fireEvent.click(button);
    await screen.findByRole('button', { name: `Inactive: ${name}` });
    expect(screen.queryByText('Edit Service')).toBeNull();
    expect(m.update).toHaveBeenCalledExactlyOnceWith('services', { status: 'inactive', is_active: false });
    expect(m.filters).toEqual([['eq', 'id', 's1'], ['eq', 'business_id', 'tenant-a'], ['is', 'deleted_at', null], ['eq', 'status', 'active']]);
  });
  it.each([false, true])('activates an inactive tile after its returned row confirms the save, class=%s', async isClass => {
    const name = isClass ? 'Yoga' : 'Haircut';
    m.rows = [service('inactive', isClass)]; m.finish.mockResolvedValue({ data: { id: 's1', status: 'active', is_active: true }, error: null });
    render(<ServicesPage />); fireEvent.click(await screen.findByRole('button', { name: `Inactive: ${name}` }));
    await screen.findByRole('button', { name: `Active: ${name}` });
    expect(m.update).toHaveBeenCalledExactlyOnceWith('services', { status: 'active', is_active: true });
  });
  it('blocks duplicate clicks while pending and keeps the old status until confirmation', async () => {
    let resolve!: (value: unknown) => void;
    m.finish.mockReturnValue(new Promise(r => { resolve = r; }));
    render(<ServicesPage />); const button = await screen.findByRole('button', { name: 'Active: Haircut' });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    expect(m.update).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    await act(async () => resolve({ data: { id: 's1', status: 'inactive', is_active: false }, error: null }));
    expect((screen.getByRole('button', { name: 'Inactive: Haircut' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it.each([true, false])('does not snapshot the pending tile into edit; resumes after settlement, success=%s', async success => {
    let resolve!: (value: unknown) => void;
    m.finish.mockReturnValue(new Promise(r => { resolve = r; }));
    render(<ServicesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Active: Haircut' }));
    fireEvent.click(screen.getByText('Haircut'));
    expect(screen.queryByText('Edit Service')).toBeNull();
    await act(async () => resolve(success
      ? { data: { id: 's1', status: 'inactive', is_active: false }, error: null }
      : { data: null, error: { message: 'denied' } }));
    fireEvent.click(screen.getByText('Haircut'));
    expect(screen.getByText('Edit Service')).toBeTruthy();
    const status = screen.getByDisplayValue(success ? 'Inactive' : 'Active') as HTMLSelectElement;
    expect(status.value).toBe(success ? 'inactive' : 'active');
  });
  it('allows editing another tile while one status save is pending', async () => {
    m.rows.push({ ...service('active'), id: 's2', name: 'Massage' });
    m.finish.mockReturnValue(new Promise(() => {}));
    render(<ServicesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Active: Haircut' }));
    fireEvent.click(screen.getByText('Massage'));
    expect(screen.getByText('Edit Service')).toBeTruthy();
    expect(screen.getByDisplayValue('Massage')).toBeTruthy();
    expect(m.update).toHaveBeenCalledTimes(1);
  });
  it.each(['error', 'empty', 'throw'])('preserves the tile and reports failed %s saves', async outcome => {
    if (outcome === 'throw') m.finish.mockRejectedValue(new Error('network'));
    else m.finish.mockResolvedValue({ data: null, error: outcome === 'error' ? { message: 'denied' } : null });
    render(<ServicesPage />); fireEvent.click(await screen.findByRole('button', { name: 'Active: Haircut' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'This service could not be saved. Please try again.');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Active: Haircut' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('button', { name: 'Inactive: Haircut' })).toBeNull();
  });
  it('keeps normal tile edit navigation separate from status updates', async () => {
    render(<ServicesPage />);
    fireEvent.click(await screen.findByText('Haircut'));
    expect(await screen.findByText('Edit Service')).toBeTruthy();
    expect(m.update).not.toHaveBeenCalled();
  });
  it('keeps archived tiles read-only for status while preserving normal edit navigation', async () => {
    m.rows = [service('archived')]; render(<ServicesPage />);
    await screen.findByText('Haircut');
    expect(screen.getByText('archived')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^(Active|Inactive):/ })).toBeNull();
    fireEvent.click(screen.getByText('Haircut'));
    expect(await screen.findByText('Edit Service')).toBeTruthy();
    expect(m.update).not.toHaveBeenCalled();
  });
});

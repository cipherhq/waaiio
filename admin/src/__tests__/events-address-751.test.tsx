import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  role: 'admin', create: vi.fn(), predict: vi.fn(), details: vi.fn(), audit: vi.fn(), apiPut: vi.fn(), apiGet: vi.fn(), rows: [] as Array<Record<string, any>>,
  writes: [] as Array<{ table: string; payload: unknown; id?: string }>,
}));
vi.mock('@/lib/googlePlaces', () => ({ createGooglePlacesServices: mocks.create }));
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => ({ role: mocks.role }) }));
vi.mock('@/lib/auditLog', () => ({ logAudit: mocks.audit }));
vi.mock('@/lib/countries', () => ({ loadCountries: async () => {}, getCountryCurrencyMap: () => ({ NG: 'NGN' }) }));
vi.mock('@/lib/adminApi', () => ({ adminApiPut: mocks.apiPut, adminApiGet: mocks.apiGet }));
vi.mock('@/lib/supabase', () => ({
  adminDb: { from: (table: string) => {
    const chain: Record<string, any> = {};
    for (const method of ['select', 'order', 'in']) chain[method] = () => chain;
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve({
      data: table === 'events' ? mocks.rows.map(row => ({ ...row })) : [{ id: 'business-1', name: 'Fixture business', country_code: 'NG' }], error: null,
    }).then(resolve);
    return chain;
  } },
}));
import Events from '@/pages/Events';
const place = { formatted_address: '10 Main Street, Lagos', address_components: [] };
beforeEach(() => {
  vi.clearAllMocks(); mocks.role = 'admin'; mocks.writes = [];
  mocks.create.mockReset().mockResolvedValue({ predictions: { getPlacePredictions: mocks.predict }, details: { getDetails: mocks.details }, reset: vi.fn() });
  mocks.predict.mockReset().mockImplementation((_request, callback) => callback([{
    place_id: 'one', description: 'Main Street', structured_formatting: { main_text: 'Main Street', secondary_text: 'Lagos' },
  }], 'OK'));
  mocks.details.mockReset().mockImplementation((_request, callback) => callback(place, 'OK'));
  mocks.rows = [
    { id: 'event-1', business_id: 'business-1', name: 'First event', venue: 'Saved venue', date: '2099-01-01', time: '10:00:00', status: 'published', price: 50, created_at: '2026-01-01', updated_at: '2026-01-01T00:00:00Z' },
    { id: 'event-2', business_id: 'business-1', name: 'Second event', venue: 'Other venue', date: '2099-01-02', time: '11:00:00', status: 'draft', price: 20, created_at: '2026-01-01', updated_at: '2026-01-01T00:00:00Z' },
  ];
  mocks.apiPut.mockReset().mockImplementation(async (path, body) => {
    const id = path.split('/').pop();
    const row = mocks.rows.find(row => row.id === id)!;
    Object.assign(row, body.changes, { updated_at: '2026-02-01T00:00:00Z' });
    mocks.writes.push({ table: 'events', id, payload: body.changes });
    return new Response(JSON.stringify({ committed: true, event: { ...row }, operation_id: body.operation_id, cancelled: false }));
  });
});
async function open(name = 'First event') { fireEvent.click(await screen.findByText(name)); await screen.findByLabelText('Venue'); }
describe('#751 Admin event venue persistence', () => {
  it('restores venue, selects by pointer and persists through the authenticated save API', async () => {
    render(<Events />); await open();
    expect(screen.getByLabelText('Venue')).toHaveValue('Saved venue');
    fireEvent.change(screen.getByLabelText('Venue'), { target: { value: 'Main' } });
    const option = await screen.findByRole('option', { name: /Main Street/ });
    fireEvent.pointerDown(option); fireEvent.click(option);
    expect(screen.getByLabelText('Venue')).toHaveValue(place.formatted_address);
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledOnce());
    expect(mocks.writes).toEqual([{ table: 'events', id: 'event-1', payload: {
      name: 'First event', date: '2099-01-01', time: '10:00', venue: place.formatted_address, price: 50, status: 'published',
    } }]);
    expect(mocks.apiPut).toHaveBeenCalledWith('/api/admin/events/event-1', expect.objectContaining({
      business_id: 'business-1', expected_updated_at: '2026-01-01T00:00:00Z', operation_id: expect.any(String),
    }));
    expect(mocks.audit).not.toHaveBeenCalled(); // Actor audit is written by the authorized server operation.
    await waitFor(() => expect(screen.queryByLabelText('Venue')).toBeNull());
    await open();
    expect(screen.getByLabelText('Venue')).toHaveValue(mocks.rows[0].venue);
  });
  it('saves manual venue when the provider is unavailable', async () => {
    mocks.create.mockRejectedValue(new Error('unavailable'));
    render(<Events />); await open();
    fireEvent.change(screen.getByLabelText('Venue'), { target: { value: 'Manual venue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledOnce());
    expect(mocks.writes[0]).toMatchObject({ id: 'event-1', payload: { venue: 'Manual venue' } });
    await waitFor(() => expect(screen.queryByLabelText('Venue')).toBeNull());
    await open();
    expect(screen.getByLabelText('Venue')).toHaveValue('Manual venue');
  });
  it('drops selected details when closing and opening another event', async () => {
    let finish: (place: unknown, status: string) => void = () => {};
    mocks.details.mockImplementation((_request, callback) => { finish = callback; });
    render(<Events />); await open();
    fireEvent.change(screen.getByLabelText('Venue'), { target: { value: 'Main' } });
    fireEvent.click(await screen.findByRole('option', { name: /Main Street/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await open('Second event');
    act(() => finish(place, 'OK'));
    expect(screen.getByLabelText('Venue')).toHaveValue('Other venue');
    expect(mocks.writes).toHaveLength(0);
  });
  it.each(['support', 'finance', 'operations'])('does not expose edit/save controls to %s', async role => {
    mocks.role = role; render(<Events />);
    fireEvent.click(await screen.findByText('First event'));
    expect(screen.queryByLabelText('Venue')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save Changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel Event' })).toBeNull();
    expect(mocks.writes).toHaveLength(0); expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

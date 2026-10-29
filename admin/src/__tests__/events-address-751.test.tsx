import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  role: 'admin', create: vi.fn(), predict: vi.fn(), details: vi.fn(), audit: vi.fn(),
  writes: [] as Array<{ table: string; payload: unknown; id?: string }>,
}));
vi.mock('@/lib/googlePlaces', () => ({ createGooglePlacesServices: mocks.create }));
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => ({ role: mocks.role }) }));
vi.mock('@/lib/auditLog', () => ({ logAudit: mocks.audit }));
vi.mock('@/lib/countries', () => ({ loadCountries: async () => {}, getCountryCurrencyMap: () => ({ NG: 'NGN' }) }));
vi.mock('@/lib/supabase', () => {
  const rows = [
    { id: 'event-1', business_id: 'business-1', name: 'First event', venue: 'Saved venue', date: '2099-01-01T10:00:00', status: 'active', price: 50, created_at: '2026-01-01' },
    { id: 'event-2', business_id: 'business-1', name: 'Second event', venue: 'Other venue', date: '2099-01-02T11:00:00', status: 'draft', price: 20, created_at: '2026-01-01' },
  ];
  return { supabase: {}, adminDb: { from: (table: string) => {
    const chain: Record<string, any> = {};
    let write: { table: string; payload: unknown; id?: string } | undefined;
    for (const method of ['select', 'order', 'in']) chain[method] = () => chain;
    chain.update = (payload: unknown) => { write = { table, payload }; mocks.writes.push(write); return chain; };
    chain.eq = (_field: string, id: string) => { if (write) write.id = id; return chain; };
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: table === 'events' ? rows : [{ id: 'business-1', name: 'Fixture business', country_code: 'NG' }], error: null }).then(resolve);
    return chain;
  } } };
});
import Events from '@/pages/Events';
const place = { formatted_address: '10 Main Street, Lagos', address_components: [] };
beforeEach(() => {
  vi.clearAllMocks(); mocks.role = 'admin'; mocks.writes = [];
  mocks.create.mockReset().mockResolvedValue({ predictions: { getPlacePredictions: mocks.predict }, details: { getDetails: mocks.details } });
  mocks.predict.mockReset().mockImplementation((_request, callback) => callback([{
    place_id: 'one', description: 'Main Street', structured_formatting: { main_text: 'Main Street', secondary_text: 'Lagos' },
  }], 'OK'));
  mocks.details.mockReset().mockImplementation((_request, callback) => callback(place, 'OK'));
  mocks.audit.mockResolvedValue(undefined);
});
async function open(name = 'First event') { fireEvent.click(await screen.findByText(name)); await screen.findByLabelText('Venue'); }
describe('#751 Admin event venue persistence', () => {
  it('restores venue, selects by pointer and preserves update/audit contract', async () => {
    render(<Events />); await open();
    expect(screen.getByLabelText('Venue')).toHaveValue('Saved venue');
    fireEvent.change(screen.getByLabelText('Venue'), { target: { value: 'Main' } });
    const option = await screen.findByRole('option', { name: /Main Street/ });
    fireEvent.pointerDown(option); fireEvent.click(option);
    expect(screen.getByLabelText('Venue')).toHaveValue(place.formatted_address);
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(mocks.audit).toHaveBeenCalledOnce());
    expect(mocks.writes).toEqual([{ table: 'events', id: 'event-1', payload: {
      name: 'First event', date: '2099-01-01T10:00:00', venue: place.formatted_address, price: 50, status: 'active',
    } }]);
    expect(mocks.audit).toHaveBeenCalledWith({ action: 'edit_event', entity_type: 'events', entity_id: 'event-1', details: { name: 'First event' } });
    await waitFor(() => expect(screen.queryByLabelText('Venue')).toBeNull());
  });
  it('saves manual venue when the provider is unavailable', async () => {
    mocks.create.mockRejectedValue(new Error('unavailable'));
    render(<Events />); await open();
    fireEvent.change(screen.getByLabelText('Venue'), { target: { value: 'Manual venue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(mocks.audit).toHaveBeenCalledOnce());
    expect(mocks.writes[0]).toMatchObject({ id: 'event-1', payload: { venue: 'Manual venue' } });
    await waitFor(() => expect(screen.queryByLabelText('Venue')).toBeNull());
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

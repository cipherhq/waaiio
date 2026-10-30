import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  role: 'admin', put: vi.fn(), get: vi.fn(), rows: [] as Array<Record<string, any>>,
  readError: false, operations: new Map<string, any>(),
}));
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => ({ role: mock.role }) }));
vi.mock('@/components/AddressAutocomplete', () => ({
  default: (props: any) => <input aria-label={props.ariaLabel} value={props.value} onChange={event => props.onChange(event.target.value)} />,
}));
vi.mock('@/lib/adminApi', () => ({ adminApiPut: mock.put, adminApiGet: mock.get }));
vi.mock('@/lib/countries', () => ({ loadCountries: async () => {}, getCountryCurrencyMap: () => ({ NG: 'NGN' }) }));
vi.mock('@/lib/supabase', () => ({
  adminDb: { from: (table: string) => {
    const chain: Record<string, any> = {};
    for (const key of ['select', 'order', 'in']) chain[key] = () => chain;
    chain.then = (resolve: (result: unknown) => unknown) => Promise.resolve({
      data: table === 'events' ? mock.rows.map(row => ({ ...row })) : [{ id: 'biz', name: 'Business', country_code: 'NG' }],
      error: table === 'events' && mock.readError ? { message: 'unavailable' } : null,
    }).then(resolve);
    return chain;
  } },
}));
import Events from '@/pages/Events';

const revision = '2026-01-01T00:00:00Z';
function reply(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
function commit(body: any) {
  const row = mock.rows[0];
  Object.assign(row, body.changes, { updated_at: '2026-02-01T00:00:00Z' });
  const result = { committed: true, event: { ...row }, operation_id: body.operation_id,
    cancelled: row.status === 'cancelled', cancelled_tickets: 2, refunds_pending: 1,
    notifications: { accepted: 0, pending: 1, failed: 0, ambiguous: 1, total: 2 } };
  mock.operations.set(body.operation_id, result);
  return result;
}
beforeEach(() => {
  vi.clearAllMocks();
  mock.role = 'admin'; mock.readError = false; mock.operations.clear();
  mock.rows = [{ id: 'event', business_id: 'biz', name: 'Concert', date: '2099-01-01', time: '19:30:00',
    venue: 'Hall', price: 50, status: 'published', created_at: revision, updated_at: revision,
    description: 'Unchanged', total_tickets: 10, tickets_sold: 2 }];
  mock.put.mockReset().mockImplementation(async (_path, body) => reply(commit(body)));
  mock.get.mockReset().mockImplementation(async path => {
    const key = path.split('operation_id=')[1];
    return mock.operations.has(key) ? reply(mock.operations.get(key)) : reply({ code: 'operation_not_found' }, 404);
  });
  vi.stubGlobal('confirm', vi.fn(() => true));
});
async function open(name = 'Concert') {
  fireEvent.click(await screen.findByText(name));
  await screen.findByLabelText('Event name');
}
function edit(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
function save() { fireEvent.click(screen.getByRole('button', { name: 'Save Changes' })); }

describe('#514 Admin event save', () => {
  it('persists and reopens all six fields without altering unrelated columns', async () => {
    render(<Events />); await open();
    expect(screen.getByLabelText('Event time')).toHaveValue('19:30');
    edit('Event name', 'Updated concert'); edit('Event date', '2099-02-03'); edit('Event time', '20:45');
    edit('Venue', 'New hall'); edit('Event price', '0'); edit('Event status', 'sold_out');
    save();
    await waitFor(() => expect(screen.queryByLabelText('Event name')).toBeNull());
    expect(mock.put).toHaveBeenCalledWith('/api/admin/events/event', expect.objectContaining({
      business_id: 'biz', expected_updated_at: revision, operation_id: expect.any(String),
      changes: { name: 'Updated concert', date: '2099-02-03', time: '20:45', venue: 'New hall', price: 0, status: 'sold_out' },
    }));
    await open('Updated concert');
    expect(screen.getByLabelText('Event date')).toHaveValue('2099-02-03');
    expect(screen.getByLabelText('Event time')).toHaveValue('20:45');
    expect(screen.getByLabelText('Venue')).toHaveValue('New hall');
    expect(screen.getByLabelText('Event price')).toHaveValue(0);
    expect(screen.getByLabelText('Event status')).toHaveValue('sold_out');
    expect(mock.rows[0]).toMatchObject({ description: 'Unchanged', total_tickets: 10, tickets_sold: 2 });
  });
  it.each([400, 403, 409])('preserves edits on explicit HTTP %s rejection without claiming saved', async status => {
    mock.put.mockResolvedValue(reply({ error: 'Rejected safely' }, status));
    render(<Events />); await open(); edit('Venue', 'Keep this'); save();
    await screen.findByText('Rejected safely');
    expect(screen.getByLabelText('Venue')).toHaveValue('Keep this');
    expect(mock.rows[0].venue).toBe('Hall');
    expect(screen.queryByText('Event saved.')).toBeNull();
  });
  it('treats a missing persisted row as unknown rather than dismissing the editor', async () => {
    mock.put.mockResolvedValue(reply({ committed: true, event: null }));
    render(<Events />); await open(); save();
    await screen.findByText('Save outcome is unknown. The server did not return a persisted event.');
    expect(screen.getByLabelText('Event name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Check save outcome' })).toBeEnabled();
  });
  it('recovers a committed lost response by readback without another mutation', async () => {
    mock.put.mockImplementationOnce(async (_path, body) => { commit(body); throw new Error('response lost'); });
    render(<Events />); await open(); edit('Venue', 'Committed hall'); save();
    fireEvent.click(await screen.findByRole('button', { name: 'Check save outcome' }));
    await waitFor(() => expect(screen.queryByLabelText('Venue')).toBeNull());
    expect(mock.put).toHaveBeenCalledOnce();
    expect(mock.get).toHaveBeenCalledOnce();
    await open(); expect(screen.getByLabelText('Venue')).toHaveValue('Committed hall');
  });
  it('replays the identical operation only after a not-found readback', async () => {
    mock.put.mockRejectedValueOnce(new Error('not received'));
    render(<Events />); await open(); save();
    fireEvent.click(await screen.findByRole('button', { name: 'Check save outcome' }));
    await waitFor(() => expect(mock.put).toHaveBeenCalledTimes(2));
    expect(mock.put.mock.calls[1]).toEqual(mock.put.mock.calls[0]);
    expect(mock.get).toHaveBeenCalledOnce();
  });
  it('distinguishes committed save from reload failure and refreshes without resaving', async () => {
    mock.put.mockImplementationOnce(async (_path, body) => { const result = commit(body); mock.readError = true; return reply(result); });
    render(<Events />); await open(); edit('Venue', 'Saved hall'); save();
    await screen.findByText(/Saved, but the latest record could not be verified/);
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
    mock.readError = false;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh saved event' }));
    await waitFor(() => expect(screen.queryByLabelText('Venue')).toBeNull());
    expect(mock.put).toHaveBeenCalledOnce();
  });
  it.each(['button', 'status'])('uses permanent cancellation contract from the %s entry', async entry => {
    render(<Events />); await open();
    if (entry === 'button') fireEvent.click(screen.getByRole('button', { name: 'Cancel Event' }));
    else { edit('Event status', 'cancelled'); save(); }
    await waitFor(() => expect(screen.queryByLabelText('Venue')).toBeNull());
    expect(confirm).toHaveBeenCalledOnce();
    expect(mock.put.mock.calls[0][1].changes.status).toBe('cancelled');
    expect(screen.getByRole('status')).toHaveTextContent('1 needing reconciliation');
    expect(screen.getByRole('status')).toHaveTextContent('no refund has been executed');
    expect(screen.getByRole('status')).toHaveTextContent('Acceptance does not confirm delivery');
  });
  it('does not mutate when permanent cancellation confirmation is declined', async () => {
    vi.mocked(confirm).mockReturnValue(false);
    render(<Events />); await open();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Event' }));
    expect(mock.put).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Venue')).toBeEnabled();
  });
  it('allows nonstatus correction of a cancelled record without exposing reactivation', async () => {
    mock.rows[0].status = 'cancelled';
    render(<Events />); await open();
    expect(screen.getByLabelText('Event status')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel Event' })).toBeDisabled();
    edit('Venue', 'Corrected hall'); save();
    await waitFor(() => expect(mock.put).toHaveBeenCalledOnce());
    expect(mock.put.mock.calls[0][1].changes).toMatchObject({ status: 'cancelled', venue: 'Corrected hall' });
    expect(confirm).not.toHaveBeenCalled();
  });
  it.each(['operations', 'finance', 'support'])('keeps %s read-only', async role => {
    mock.role = role; render(<Events />); fireEvent.click(await screen.findByText('Concert'));
    expect(screen.queryByRole('button', { name: 'Save Changes' })).toBeNull();
    expect(mock.put).not.toHaveBeenCalled();
  });
});

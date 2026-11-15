import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), upsert: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/api-auth', () => ({ authenticateRequest: mocks.auth }));
import { POST } from '../route';
const request = (contacts: unknown[]) => new NextRequest('http://localhost/api/customers/import', { method: 'POST', body: JSON.stringify({ businessId: 'tenant-a', contacts }) });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.upsert.mockResolvedValue({ error: null });
  mocks.from.mockReturnValue({ upsert: mocks.upsert });
  mocks.auth.mockResolvedValue({ businessId: 'tenant-a', service: { from: mocks.from } });
});
describe('contact import phone boundary', () => {
  it('skips invalid rows in a mixed batch before storage', async () => {
    const invalid = ['+23480234566777777777777777', '+234801234567890123', '+12001234567', '08012345678', '2.348012345678E+12', '+14155552671 ext 5', 2348012345678, {}, null];
    const response = await POST(request([...invalid.map(phone => ({ phone })), { phone: '+234 803 123 4567', name: 'Ada', email: 'ada@example.com', tags: ['vip'], date_of_birth: '2000-01-02' }]));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ imported: 1, skipped: invalid.length });
    expect(body.errors.map((e: {row:number}) => e.row)).toEqual(invalid.map((_,i) => i+1));
    expect(body.errors[0].reason).toBe('Invalid phone number');
    expect(body.errors[invalid.length - 1].reason).toBe('Missing phone number');
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).toHaveBeenCalledWith({ business_id: 'tenant-a', phone: '+2348031234567', name: 'Ada', email: 'ada@example.com', tags: ['vip'], date_of_birth: '2000-01-02' }, { onConflict: 'business_id,phone' });
    expect(mocks.from.mock.calls.map(c => c[0])).toEqual(['customer_profiles']);
  });
  it('canonicalizes international formats onto the same tenant upsert key', async () => {
    const phones = ['+1 (415) 555-2671', '14155552671', '+1 416 555 0123', '+233 24 123 4567', '44 20 7946 0018'];
    const response = await POST(request(phones.map(phone => ({ phone }))));
    expect(await response.json()).toEqual({ imported: 5, skipped: 0 });
    expect(mocks.upsert.mock.calls.map(c => c[0].phone)).toEqual(['+14155552671', '+14155552671', '+14165550123', '+233241234567', '+442079460018']);
    for (const [row, options] of mocks.upsert.mock.calls) {
      expect(row.business_id).toBe('tenant-a'); expect(options).toEqual({ onConflict: 'business_id,phone' });
    }
    expect(new Set(mocks.from.mock.calls.map(c => c[0]))).toEqual(new Set(['customer_profiles']));
  });
  it('reports missing and malformed rows without writing or crashing', async () => {
    const response = await POST(request([null, 5, {}, { phone: '' }, { phone: '  ' }]));
    expect(await response.json()).toEqual({ imported: 0, skipped: 5, errors: Array.from({ length: 5 }, (_, i) => ({ row: i + 1, reason: 'Missing phone number' })) });
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('preserves ownership denial without any storage access', async () => {
    mocks.auth.mockResolvedValue(NextResponse.json({ error: 'Forbidden' }, { status: 403 }));
    expect((await POST(request([{ phone: '+14155552671' }]))).status).toBe(403);
    expect(mocks.auth).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requireBusinessOwnership: true, businessIdKey: 'businessId' }));
    expect(mocks.from).not.toHaveBeenCalled();
  });
});

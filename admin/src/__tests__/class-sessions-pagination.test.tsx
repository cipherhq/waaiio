import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'test' } } }) } } }));
import ClassSessions from '@/pages/ClassSessions';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('uses the real pager and requests the next server page', async () => {
 const fetcher = vi.fn(async (_url: string) => new Response(JSON.stringify({ data: [{ id: 'session', business_name: 'Test Business', service_name: 'Yoga', date: '2026-11-11', start_time: '09:00', capacity: 10, attendee_count: 1, status: 'scheduled' }], totalPages: 2, total: 21 })));
 vi.stubGlobal('fetch', fetcher);
 render(<ClassSessions />);
 await screen.findByText('Page 1 of 2');
 expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
 fireEvent.click(screen.getByRole('button', { name: 'Next' }));
 await screen.findByText('Page 2 of 2');
 expect(fetcher.mock.calls.some(call => String(call[0]).includes('page=2'))).toBe(true);
 expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
});

it('opens canonical detail components with values and closes them', async () => {
 const session = { id: 'session', business_name: 'Test Business', service_name: 'Yoga', date: '2026-11-11', created_at: '2026-11-01T12:00:00Z', start_time: '09:00', end_time: '10:00', capacity: 10, attendee_count: 1, status: 'scheduled', instructor_name: 'Teacher' };
 vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('sessionId=') ? { data: { ...session, attendees: [{ id: 'a', guest_name: 'Guest Test', party_size: 1, status: 'confirmed' }] } } : { data: [session], totalPages: 1, total: 1 }))));
 render(<ClassSessions />);
 fireEvent.click(await screen.findByText('Yoga'));
 await screen.findByRole('heading', { name: 'Class Session Detail' });
 await screen.findByText('Guest Test');
 expect(screen.getAllByText('Test Business')).toHaveLength(2);
 expect(screen.getByText('09:00 — 10:00')).toBeInTheDocument();
 expect(screen.getAllByText('1/10')).toHaveLength(2);
 fireEvent.click(screen.getByRole('button', { name: /^Close$/ }));
 expect(screen.queryByRole('heading', { name: 'Class Session Detail' })).not.toBeInTheDocument();
});

it('does not reopen a closed detail when its delayed request completes', async () => {
 let resolveDetail!: (value: Response) => void;
 const session = { id: 'session', business_name: 'Test Business', service_name: 'Yoga', date: '2026-11-11', created_at: '2026-11-01T12:00:00Z', capacity: 10, attendee_count: 0, status: 'scheduled' };
 vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('sessionId=') ? new Promise<Response>(resolve => { resolveDetail = resolve; }) : new Response(JSON.stringify({ data: [session], totalPages: 1 }))));
 render(<ClassSessions />);
 fireEvent.click(await screen.findByText('Yoga'));
 await screen.findByText('Loading attendees...');
 fireEvent.click(screen.getByRole('button', { name: /^Close$/ }));
 await act(async () => { resolveDetail(new Response(JSON.stringify({ data: { ...session, attendees: [] } }))); });
 expect(screen.queryByRole('heading', { name: 'Class Session Detail' })).not.toBeInTheDocument();
});

it('shows a detail read failure instead of claiming no attendees', async () => {
 vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('sessionId=') ? new Response(JSON.stringify({ error: 'Unavailable' }), { status: 503 }) : new Response(JSON.stringify({ data: [{ id: 'session', service_name: 'Yoga', date: '2026-11-11', created_at: '2026-11-01T12:00:00Z', attendee_count: 4 }], totalPages: 1 }))));
 render(<ClassSessions />); fireEvent.click(await screen.findByText('Yoga'));
 await screen.findByText('Unable to load attendees. Close and reopen to retry.');
 expect(screen.queryByText('No attendees')).not.toBeInTheDocument();
});

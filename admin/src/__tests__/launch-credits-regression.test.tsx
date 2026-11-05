import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import LaunchSubscribers from '../pages/LaunchSubscribers';
import MessagingCredits from '../pages/MessagingCredits';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/adminApi', () => ({ adminApiGet: mocks.get, adminApiFetch: mocks.post }));
vi.mock('@/lib/supabase', () => ({ adminDb: { from: () => {
  const q: any = { then: (resolve: any) => Promise.resolve({ data: [], count: 0, error: null }).then(resolve) };
  for (const method of ['select', 'eq', 'order', 'range', 'in']) q[method] = () => q;
  return q;
} } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('Admin launch and credits regressions', () => {
  it('renders credit summary icons', async () => {
    render(<MessagingCredits />);
    await waitFor(() => expect(screen.getByText('Active Businesses')).toBeTruthy());
    expect(screen.getByText('Suspended')).toBeTruthy();
  });
  it('previews through authenticated GET without sending', async () => {
    mocks.post.mockResolvedValue(new Response(JSON.stringify({ data: [] })));
    mocks.get.mockResolvedValue(new Response(JSON.stringify({ error: 'Synthetic readiness unavailable' }), { status: 503 }));
    render(<LaunchSubscribers />);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview Send' }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/admin/launch-notify?retryOnly=false&limit=50'));
    expect(await screen.findByText('Synthetic readiness unavailable')).toBeTruthy();
    expect(mocks.post.mock.calls.every(([path]) => path === '/api/admin/query')).toBe(true);
  });
});

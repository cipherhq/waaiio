// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AudiencesPage from '@/app/dashboard/audiences/page';

const context = vi.hoisted(() => ({
  business: { id: 'audience-test-business' },
  capReady: true,
}));

vi.mock('@/components/dashboard/DashboardProvider', () => ({
  useBusiness: () => context.business,
  useRequireCapability: () => context.capReady,
}));
// The page imports this client but its list uses fetch, never browser DB access.
vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }));

const fetchMock = vi.fn();
const segment = {
  id: 'audience-test-segment',
  name: 'Returning customers',
  description: 'Synthetic audience fixture',
  expression: { type: 'all', children: [] },
  is_dynamic: true,
  created_at: '2026-10-01T12:00:00Z',
  updated_at: '2026-10-01T12:00:00Z',
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function expectNoEmptyClaim() {
  expect(screen.queryByText('No audiences yet')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Create Audience', exact: true })).toBeNull();
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('W25 Audience list load states', () => {
  it('waits for the initial response before claiming an empty list', async () => {
    let resolveLoad!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { resolveLoad = resolve; }));
    const { container } = render(<AudiencesPage />);

    expect(fetchMock).toHaveBeenCalledWith('/api/engage/segments?businessId=audience-test-business');
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expectNoEmptyClaim();

    await act(async () => { resolveLoad(response({ success: true, segments: [] })); });

    expect(screen.getByText('No audiences yet')).toBeTruthy();
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('renders populated success with the existing row actions', async () => {
    fetchMock.mockResolvedValueOnce(response({ success: true, segments: [segment] }));
    render(<AudiencesPage />);

    expect(await screen.findByRole('heading', { name: segment.name })).toBeTruthy();
    expect(screen.getByText(segment.description)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit', exact: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete', exact: true })).toBeTruthy();
    expectNoEmptyClaim();
  });

  it('renders the empty-state action after a successful empty response', async () => {
    fetchMock.mockResolvedValueOnce(response({ success: true, segments: [] }));
    render(<AudiencesPage />);

    expect(await screen.findByText('No audiences yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create Audience', exact: true }));
    expect(screen.getByRole('heading', { name: 'New Audience', exact: true })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 401, error: 'Unauthorized' },
    { status: 403, error: 'Access denied' },
    { status: 500, error: 'Failed to load segments' },
  ])('shows HTTP $status failure without claiming an empty list', async ({ status, error }) => {
    fetchMock.mockResolvedValueOnce(response({ error }, status));
    const { container } = render(<AudiencesPage />);

    expect(await screen.findByText(error)).toBeTruthy();
    expectNoEmptyClaim();
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves a network error without claiming an empty list', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network unavailable'));
    render(<AudiencesPage />);

    expect(await screen.findByText('Network unavailable')).toBeTruthy();
    expectNoEmptyClaim();
  });

  it('uses the HTTP fallback for a non-JSON error response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Upstream unavailable', { status: 502 }));
    render(<AudiencesPage />);

    expect(await screen.findByText('Failed to load audiences (502)')).toBeTruthy();
    expectNoEmptyClaim();
  });

  it('keeps existing rows visible when deletion fails', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ success: true, segments: [segment] }))
      .mockResolvedValueOnce(response({ error: 'Failed to delete segment' }, 500));
    render(<AudiencesPage />);

    await screen.findByRole('heading', { name: segment.name });
    fireEvent.click(screen.getByRole('button', { name: 'Delete', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm', exact: true }));

    expect(await screen.findByText('Failed to delete segment')).toBeTruthy();
    expect(screen.getByRole('heading', { name: segment.name })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit', exact: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Confirm', exact: true }).hasAttribute('disabled')).toBe(false);
    expectNoEmptyClaim();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/engage/segments/audience-test-segment?businessId=audience-test-business',
      { method: 'DELETE' },
    );
  });
});

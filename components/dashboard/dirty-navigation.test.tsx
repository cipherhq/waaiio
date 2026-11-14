// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DashboardProvider, useDashboard, type Business } from './DashboardProvider';
import { useDirtyNavigation } from './dirty-navigation';
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/lib/countries', () => ({ loadCountries: vi.fn() }));
function Editor({ dirty }: { dirty: boolean }) {
  useDirtyNavigation(dirty);
  const { switchBusiness } = useDashboard();
  return <><button onClick={() => switchBusiness('other')}>Switch</button><a href="/dashboard/orders">Orders</a></>;
}
function mount(dirty: boolean) {
  return render(<DashboardProvider business={{ id: 'current' } as Business} userId="owner"><Editor dirty={dirty} /></DashboardProvider>);
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); router.push.mockReset(); router.refresh.mockReset(); });
describe('builder-only navigation warning', () => {
  it('Cancel prevents business-switch POST and navigation', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    mount(true); fireEvent.click(screen.getByText('Switch'));
    expect(fetch).not.toHaveBeenCalled(); expect(router.push).not.toHaveBeenCalled();
  });
  it('Continue allows business-switch POST and navigation', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetch);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mount(true); fireEvent.click(screen.getByText('Switch'));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/dashboard'));
    expect(fetch).toHaveBeenCalledWith('/api/dashboard/switch-business', expect.objectContaining({ method: 'POST' }));
  });
  it.each([false, true])('link navigation follows confirmation %s', approved => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(approved);
    mount(true);
    const link = screen.getByText('Orders');
    let reachedLink = false;
    link.addEventListener('click', event => { reachedLink = true; event.preventDefault(); });
    fireEvent.click(link);
    expect(reachedLink).toBe(approved);
    expect(confirm).toHaveBeenCalledWith('Leave without saving? Draft changes will be lost.');
  });
  it('does not warn after dirty state clears or the editor unmounts', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const view = mount(true);
    view.rerender(<DashboardProvider business={{ id: 'current' } as Business} userId="owner"><Editor dirty={false} /></DashboardProvider>);
    const link = screen.getByText('Orders'); link.addEventListener('click', event => event.preventDefault());
    fireEvent.click(link); expect(confirm).not.toHaveBeenCalled();
    view.unmount();
  });
});

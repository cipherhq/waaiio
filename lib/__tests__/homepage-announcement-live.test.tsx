// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ path: '/', type: 'launch_countdown' }));
vi.mock('next/navigation', () => ({ usePathname: () => f.path }));
import SiteAnnouncement from '@/components/marketing/SiteAnnouncement';
beforeEach(() => {
  f.path = '/'; f.type = 'launch_countdown'; sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    enabled: true, type: f.type, headline: 'Service notice', message: 'Scheduled maintenance information',
    target_date: null, cta_text: null, cta_link: null, style: 'info',
  }), { status: 200 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('live homepage announcement behavior', () => {
  it('does not display a launch strip or open the launch modal on the homepage', async () => {
    await act(async () => { render(<SiteAnnouncement />); });
    expect(screen.queryByTestId('launch-strip')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sessionStorage.getItem('waaiio_launch_modal_shown')).toBeNull();
  });
  it.each(['maintenance', 'general'])('preserves ordinary %s notices', async type => {
    f.type = type;
    await act(async () => { render(<SiteAnnouncement />); });
    expect(screen.getByText('Service notice')).toBeTruthy();
    expect(screen.getByText('Scheduled maintenance information')).toBeTruthy();
    expect(screen.queryByTestId('launch-strip')).toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { state, updateCalls, mockAdminDb, logAuditMock } = vi.hoisted(() => {
  const state: {
    config: Record<string, unknown>;
    updateError: { message: string } | null;
  } = {
    config: {},
    updateError: null,
  };
  const updateCalls: Array<Record<string, unknown>> = [];

  const mockAdminDb = {
    from: vi.fn(() => {
      let mode: 'select' | 'update' = 'select';
      const chain: Record<string, any> = {};

      chain.select = vi.fn(() => {
        mode = 'select';
        return chain;
      });
      chain.update = vi.fn((payload: Record<string, unknown>) => {
        mode = 'update';
        updateCalls.push(payload);
        return chain;
      });
      chain.eq = vi.fn(() => {
        if (mode === 'update') {
          return Promise.resolve({ error: state.updateError });
        }
        return chain;
      });
      chain.single = vi.fn(async () => ({
        data: { value: { ...state.config } },
        error: null,
      }));

      return chain;
    }),
  };

  return {
    state,
    updateCalls,
    mockAdminDb,
    logAuditMock: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@/lib/supabase', () => ({
  adminDb: mockAdminDb,
}));

vi.mock('@/components/AdminLayout', () => ({
  useAdminSession: vi.fn().mockReturnValue({
    userId: 'admin-420',
    email: 'admin@waaiio.test',
    role: 'admin',
  }),
}));

vi.mock('@/lib/auditLog', () => ({
  logAudit: logAuditMock,
}));

vi.mock('@/lib/adminApi', () => ({
  getAdminApiBase: vi.fn(() => 'https://www.waaiio.com'),
}));

import SiteAnnouncementPage from '@/pages/SiteAnnouncement';

function setDraft(overrides: Record<string, unknown> = {}) {
  state.config = {
    enabled: false,
    type: 'launch_countdown',
    headline: '',
    message: '',
    target_date: null,
    cta_text: 'Get Launch Updates',
    cta_link: '/launch',
    style: 'brand',
    ...overrides,
  };
}

describe('#420 Site Announcement Admin safety UX', () => {
  beforeEach(() => {
    updateCalls.length = 0;
    state.updateError = null;
    logAuditMock.mockClear();
    vi.clearAllMocks();
    setDraft();
    vi.spyOn(window, 'open').mockImplementation(() => null);
  });

  it('renders a draft preview and makes the browser timezone explicit', async () => {
    render(<SiteAnnouncementPage />);

    expect(await screen.findByText('Preview before live')).toBeInTheDocument();
    expect(screen.getByText(/Draft preview — not live/i)).toBeInTheDocument();
    expect(screen.getByText(/Times are shown in your browser timezone:/i)).toBeInTheDocument();
    expect(screen.getByText(/Current expiry behavior:/i)).toBeInTheDocument();
  });

  it('refuses to make an invalid launch countdown live and does not persist', async () => {
    const user = userEvent.setup();
    render(<SiteAnnouncementPage />);

    const off = await screen.findByRole('button', { name: 'Off' });
    await user.click(off);

    expect(await screen.findByText(/Headline is required before making the announcement live/i))
      .toBeInTheDocument();
    expect(updateCalls).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Off' })).toBeInTheDocument();
  });

  it('Test CTA resolves a relative public-site link against VITE_API_URL authority', async () => {
    const user = userEvent.setup();
    render(<SiteAnnouncementPage />);

    const testButton = await screen.findByRole('button', { name: /Test CTA/i });
    await user.click(testButton);

    expect(window.open).toHaveBeenCalledWith(
      'https://www.waaiio.com/launch',
      '_blank',
      'noopener,noreferrer',
    );
    expect(updateCalls).toHaveLength(0);
  });

  it('applies a generated WhatsApp link to the CTA draft without persisting, then Test CTA opens it', async () => {
    const user = userEvent.setup();
    render(<SiteAnnouncementPage />);

    await user.click(await screen.findByRole('button', { name: /Generate WhatsApp Link/i }));
    await user.type(screen.getByLabelText(/Destination WhatsApp number/i), '+1 301 555 0123');
    await user.type(screen.getByLabelText(/Prefilled message/i), 'Hi Waaiio launch');
    await user.click(screen.getByRole('button', { name: /Use This Link/i }));

    const ctaLink = screen.getByPlaceholderText('/get-started or https://...');
    expect(ctaLink).toHaveValue('https://wa.me/13015550123?text=Hi%20Waaiio%20launch');
    expect(updateCalls).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /Test CTA/i }));

    expect(window.open).toHaveBeenCalledWith(
      'https://wa.me/13015550123?text=Hi%20Waaiio%20launch',
      '_blank',
      'noopener,noreferrer',
    );
    expect(updateCalls).toHaveLength(0);
  });

  it('does not claim Live when persistence fails', async () => {
    const user = userEvent.setup();
    setDraft({
      headline: 'Waaiio launches soon',
      target_date: '2099-10-11T16:00:00.000Z',
    });
    state.updateError = { message: 'Database unavailable' };

    render(<SiteAnnouncementPage />);

    await user.click(await screen.findByRole('button', { name: 'Off' }));

    expect(await screen.findByText('Database unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Off' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Live' })).not.toBeInTheDocument();
  });

  it('enables a valid future countdown and writes the validated config once', async () => {
    const user = userEvent.setup();
    setDraft({
      headline: 'Waaiio launches soon',
      message: 'Get ready.',
      target_date: '2099-10-11T16:00:00.000Z',
    });

    render(<SiteAnnouncementPage />);
    await user.click(await screen.findByRole('button', { name: 'Off' }));

    await waitFor(() => expect(updateCalls).toHaveLength(1));
    expect(await screen.findByRole('button', { name: 'Live' })).toBeInTheDocument();

    const value = updateCalls[0].value as Record<string, unknown>;
    expect(value.enabled).toBe(true);
    expect(value.target_date).toBe('2099-10-11T16:00:00.000Z');
    expect(logAuditMock).toHaveBeenCalledWith(
      'site_announcement_enabled',
      expect.objectContaining({ headline: 'Waaiio launches soon' }),
    );
  });
});

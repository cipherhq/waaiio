import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { state, apiPutCalls, logAuditMock, mockAdminApiGet, mockAdminApiPut } = vi.hoisted(() => {
  const state: {
    config: Record<string, unknown>;
    apiError: string | null;
  } = {
    config: {},
    apiError: null,
  };
  const apiPutCalls: Array<Record<string, unknown>> = [];

  return {
    state,
    apiPutCalls,
    logAuditMock: vi.fn().mockResolvedValue(undefined),
    mockAdminApiGet: vi.fn(async () => ({
      ok: true,
      json: async () => ({ config: { ...state.config }, updated_at: new Date().toISOString() }),
    })),
    mockAdminApiPut: vi.fn(async (_path: string, body: Record<string, unknown>) => {
      apiPutCalls.push(body);
      if (state.apiError) {
        return { ok: false, json: async () => ({ error: state.apiError }) };
      }
      const config = { ...body };
      delete config.expected_updated_at;
      return {
        ok: true,
        json: async () => ({
          success: true,
          config,
          updated_at: new Date().toISOString(),
        }),
      };
    }),
  };
});

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
  adminApiGet: mockAdminApiGet,
  adminApiPut: mockAdminApiPut,
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
    apiPutCalls.length = 0;
    state.apiError = null;
    logAuditMock.mockClear();
    mockAdminApiGet.mockClear();
    mockAdminApiPut.mockClear();
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

  it('initial load comes from GET /api/admin/site-announcement', async () => {
    render(<SiteAnnouncementPage />);
    await screen.findByText('Preview before live');
    expect(mockAdminApiGet).toHaveBeenCalledWith('/api/admin/site-announcement');
  });

  it('refuses to make an invalid launch countdown live and does not persist', async () => {
    const user = userEvent.setup();
    render(<SiteAnnouncementPage />);

    const off = await screen.findByRole('button', { name: 'Off' });
    await user.click(off);

    expect(await screen.findByText(/Headline is required before making the announcement live/i))
      .toBeInTheDocument();
    expect(apiPutCalls).toHaveLength(0);
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
    expect(apiPutCalls).toHaveLength(0);
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
    expect(apiPutCalls).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /Test CTA/i }));

    expect(window.open).toHaveBeenCalledWith(
      'https://wa.me/13015550123?text=Hi%20Waaiio%20launch',
      '_blank',
      'noopener,noreferrer',
    );
    expect(apiPutCalls).toHaveLength(0);
  });

  it('does not claim Live when API persistence fails', async () => {
    const user = userEvent.setup();
    setDraft({
      headline: 'Waaiio launches soon',
      target_date: '2099-10-11T16:00:00.000Z',
    });
    state.apiError = 'Database unavailable';

    render(<SiteAnnouncementPage />);

    await user.click(await screen.findByRole('button', { name: 'Off' }));

    expect(await screen.findByText('Database unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Off' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Live' })).not.toBeInTheDocument();
  });

  it('enables a valid future countdown via PUT and writes the validated config once', async () => {
    const user = userEvent.setup();
    setDraft({
      headline: 'Waaiio launches soon',
      message: 'Get ready.',
      target_date: '2099-10-11T16:00:00.000Z',
    });

    render(<SiteAnnouncementPage />);
    await user.click(await screen.findByRole('button', { name: 'Off' }));

    await waitFor(() => expect(apiPutCalls).toHaveLength(1));
    expect(await screen.findByRole('button', { name: 'Live' })).toBeInTheDocument();
    expect(mockAdminApiPut).toHaveBeenCalledWith(
      '/api/admin/site-announcement',
      expect.objectContaining({
        enabled: true,
        expected_updated_at: expect.any(String),
      }),
    );

    const body = apiPutCalls[0] as Record<string, unknown>;
    expect(body.enabled).toBe(true);
    expect(body.target_date).toBe('2099-10-11T16:00:00.000Z');
    expect(body.expected_updated_at).toEqual(expect.any(String));
    expect(logAuditMock).toHaveBeenCalledWith(
      'site_announcement_enabled',
      expect.objectContaining({ headline: 'Waaiio launches soon' }),
    );
  });

  it('Save uses authenticated PUT /api/admin/site-announcement', async () => {
    const user = userEvent.setup();
    setDraft({
      headline: 'Test headline',
      message: 'Test message',
    });

    render(<SiteAnnouncementPage />);
    const saveBtn = await screen.findByRole('button', { name: /Save Changes/i });
    await user.click(saveBtn);

    await waitFor(() => expect(apiPutCalls).toHaveLength(1));
    expect(mockAdminApiPut).toHaveBeenCalledWith(
      '/api/admin/site-announcement',
      expect.objectContaining({
        headline: 'Test headline',
        expected_updated_at: expect.any(String),
      }),
    );
  });
});

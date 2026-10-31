// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { select, eq, limit } = vi.hoisted(() => ({ select: vi.fn(), eq: vi.fn(), limit: vi.fn() }));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => ({ id: 'business-qa' }) }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ from: () => {
    const query = { select, eq, gte: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), limit };
    select.mockReturnValue(query);
    eq.mockReturnValue(query);
    return query;
  } }),
}));
import FlowDropoffsPage from '../../app/dashboard/analytics/dropoffs/page';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('merchant flow analytics reads', () => {
  it('renders persisted step IDs and scopes the query to the business', async () => {
    limit.mockResolvedValue({ data: [{ id: 'exit-1', flow_type: 'ordering', step_id: 'await_payment', reason: 'cancelled', capability: 'ordering', created_at: new Date().toISOString() }], error: null });
    render(<FlowDropoffsPage />);
    expect((await screen.findAllByText('await payment')).length).toBeGreaterThan(0);
    expect(select).toHaveBeenCalledWith('id, flow_type, step_id, reason, capability, created_at');
    expect(eq).toHaveBeenCalledWith('business_id', 'business-qa');
  });

  it('shows a genuine empty result as no activity', async () => {
    limit.mockResolvedValue({ data: [], error: null });
    render(<FlowDropoffsPage />);
    expect(await screen.findByText('No flow drop-off data yet')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['query', 'network'])('shows %s failure without false zero metrics', async failure => {
    if (failure === 'query') limit.mockResolvedValue({ data: null, error: { message: 'unavailable' } });
    else limit.mockRejectedValue(new Error('network unavailable'));
    render(<FlowDropoffsPage />);
    expect((await screen.findByRole('alert')).textContent).toContain('Unable to load flow analytics');
    expect(screen.queryByText('Total Sessions')).toBeNull();
    expect(screen.queryByText('No flow drop-off data yet')).toBeNull();
  });
});

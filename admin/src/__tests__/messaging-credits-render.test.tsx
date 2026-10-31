import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ adminDb: { from } }));

import MessagingCredits from '../pages/MessagingCredits';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Messaging Credits summary rendering', () => {
  it('renders balances and purchase summaries with the real SummaryCard', async () => {
    from.mockImplementation(() => {
      const result = { data: [], count: 0, error: null };
      const query = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        range: vi.fn().mockReturnThis(),
        then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
      };
      return query;
    });

    render(<MessagingCredits />);
    expect(screen.getByText('Active Businesses')).toBeInTheDocument();
    expect(screen.getByText('Suspended')).toBeInTheDocument();
    expect(await screen.findByText('No active businesses found.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Purchases' }));
    expect(screen.getByText('Total Purchases')).toBeInTheDocument();
    expect(screen.getByText('Pending (this page)')).toBeInTheDocument();
    expect(screen.getByText('Needs Review (this page)')).toBeInTheDocument();
    expect(screen.getByText('Completed (this page)')).toBeInTheDocument();
    expect(await screen.findByText('No top-up purchases found.')).toBeInTheDocument();
    expect(from).toHaveBeenCalledWith('messaging_topup_purchases');
  });
});

import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { projections } = vi.hoisted(() => ({ projections: [] as string[] }));
vi.mock('@/lib/supabase', () => ({ adminDb: { from: (table: string) => {
  let columns = '';
  const query = {
    select: (value: string) => { columns = value; projections.push(value); return query; },
    gte: () => query, or: () => query, order: () => query, range: () => query,
    limit: () => query, in: () => query,
    then: (resolve: (value: unknown) => unknown) => {
      const result = columns.includes('input_hash')
        ? { data: null, error: { message: 'column input_hash does not exist' } }
        : { data: table === 'businesses' ? [{ id: 'b1', name: 'QA Business' }]
          : columns.includes('business_id') ? [{ id: 'review-record-1', intent: 'unknown', confidence: 0.2, business_id: 'b1', created_at: '2026-10-31T00:00:00Z' }] : [], error: null };
      return Promise.resolve(result).then(resolve);
    },
  };
  return query;
} } }));
import AIMarketplace from '../pages/AIMarketplace';

afterEach(() => { cleanup(); projections.length = 0; });

it('loads the review queue using supported fields and identifies records without raw messages', async () => {
  render(<AIMarketplace />);
  fireEvent.click(screen.getByRole('button', { name: 'Intent Review Queue' }));
  expect(await screen.findByText('review-record-1')).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: 'Record ID' })).toBeInTheDocument();
  expect(screen.queryByRole('columnheader', { name: 'Input Hash' })).not.toBeInTheDocument();
  expect(projections.every(value => !value.includes('input_hash') && !value.includes('customer_phone_hash'))).toBe(true);
});

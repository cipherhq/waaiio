import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// The review queue reads llm_classifications through the admin query proxy (#1108):
// ai_classification_log, which the page used to read, is never written.
const { projections } = vi.hoisted(() => ({ projections: [] as Array<{ table: string; select: string }> }));
vi.mock('@/lib/adminQuery', () => ({
  adminQuery: async (table: string, options: { select?: string }) => {
    projections.push({ table, select: options.select || '' });
    return {
      data: [{ id: 'review-record-1', business_id: 'b1', detected_intent: null, detected_flow: null, confidence: 0.2, llm_used: true, regex_matched: false, created_at: '2026-10-31T00:00:00Z' }],
    };
  },
}));
vi.mock('@/lib/supabase', () => ({ adminDb: { from: () => {
  const query = {
    select: () => query, gte: () => query, or: () => query, order: () => query, range: () => query,
    limit: () => query, in: () => query,
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [{ id: 'b1', name: 'QA Business' }], error: null }).then(resolve),
  };
  return query;
} } }));
import AIMarketplace from '../pages/AIMarketplace';

afterEach(() => { cleanup(); projections.length = 0; });

it('loads the review queue from llm_classifications and identifies records without raw messages', async () => {
  render(<AIMarketplace />);
  fireEvent.click(screen.getByRole('button', { name: 'Intent Review Queue' }));
  expect(await screen.findByText('review-record-1')).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: 'Record ID' })).toBeInTheDocument();
  expect(screen.queryByRole('columnheader', { name: 'Input Hash' })).not.toBeInTheDocument();
  expect(projections.length).toBeGreaterThan(0);
  expect(projections.every(p => p.table === 'llm_classifications')).toBe(true);
  // Never the customer's message text or phone hashes.
  expect(projections.every(p => !/user_message|input_hash|customer_phone_hash/.test(p.select))).toBe(true);
});

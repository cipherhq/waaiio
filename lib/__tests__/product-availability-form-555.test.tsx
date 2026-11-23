// @vitest-environment jsdom
/**
 * M555 product form: Mon–Sun day chips and optional From/Until dates.
 * Defaults to every day with no dates; picking days limits the item.
 */
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import AvailabilityFields from '@/app/dashboard/products/components/AvailabilityFields';

type Value = { available_days: number[] | null; available_from: string | null; available_until: string | null };
let latest: Value;

function Harness({ initial }: { initial: Value }) {
  const [v, setV] = useState<Value>(initial);
  latest = v;
  return <AvailabilityFields availableDays={v.available_days} availableFrom={v.available_from} availableUntil={v.available_until} onChange={setV} />;
}

const EMPTY: Value = { available_days: null, available_from: null, available_until: null };

afterEach(cleanup);

describe('AvailabilityFields', () => {
  it('defaults to Every day with no dates', () => {
    render(<Harness initial={EMPTY} />);
    expect(screen.getByRole('button', { name: 'Every day' }).getAttribute('aria-pressed')).toBe('true');
    for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
      expect(screen.getByRole('button', { name: d }).getAttribute('aria-pressed')).toBe('false');
    }
    expect(screen.getByText(/every day/i, { selector: 'p' })).toBeTruthy();
  });

  it('picking days limits the item; Every day clears them', () => {
    render(<Harness initial={EMPTY} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mon' }));
    expect(latest.available_days).toEqual([1, 2]);
    expect(screen.getByRole('button', { name: 'Every day' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Mon' }));
    expect(latest.available_days).toEqual([2]);
    fireEvent.click(screen.getByRole('button', { name: 'Every day' }));
    expect(latest.available_days).toBeNull();
  });

  it('sets and clears dates, and warns when Until is before From', () => {
    render(<Harness initial={EMPTY} />);
    fireEvent.change(screen.getByLabelText('From (optional)'), { target: { value: '2026-11-30' } });
    fireEvent.change(screen.getByLabelText('Until (optional)'), { target: { value: '2026-11-23' } });
    expect(latest).toMatchObject({ available_from: '2026-11-30', available_until: '2026-11-23' });
    expect(screen.getByRole('alert').textContent).toMatch(/Until/);
    fireEvent.change(screen.getByLabelText('From (optional)'), { target: { value: '' } });
    expect(latest.available_from).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a saved Tuesday-only item as Tue selected', () => {
    render(<Harness initial={{ available_days: [2], available_from: null, available_until: null }} />);
    expect(screen.getByRole('button', { name: 'Tue' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Every day' }).getAttribute('aria-pressed')).toBe('false');
  });
});

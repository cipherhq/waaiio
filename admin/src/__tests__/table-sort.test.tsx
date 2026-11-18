import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { compareSortValues, nextSortState, sortNumber, sortRows, sortTime, useTableSort } from '@/lib/tableSort';
import { SortableTh } from '@/components/SortableTh';

describe('admin table sort helper', () => {
  it('sorts numbers and money by value, not as text', () => {
    const rows = [{ v: 100 }, { v: 9 }, { v: 25.5 }];
    expect(sortRows(rows, r => r.v, 'asc').map(r => r.v)).toEqual([9, 25.5, 100]);
    expect(sortRows(rows, r => r.v, 'desc').map(r => r.v)).toEqual([100, 25.5, 9]);
  });

  it('sorts dates by time, not as text', () => {
    const rows = [{ d: '2026-11-02T10:00:00+05:00' }, { d: '2026-11-02T06:00:00Z' }, { d: '2025-12-31T00:00:00Z' }];
    // 10:00+05:00 is 05:00Z, so it is earlier than 06:00Z even though its text is larger.
    expect(sortRows(rows, r => sortTime(r.d), 'asc').map(r => r.d)).toEqual([
      '2025-12-31T00:00:00Z', '2026-11-02T10:00:00+05:00', '2026-11-02T06:00:00Z',
    ]);
  });

  it('sorts text case-insensitively with natural numbers', () => {
    const rows = ['banana', 'Apple', 'cherry', 'item 10', 'item 2'];
    expect(sortRows(rows, r => r, 'asc')).toEqual(['Apple', 'banana', 'cherry', 'item 2', 'item 10']);
  });

  it('puts empty values last in both directions', () => {
    const rows = [{ v: null }, { v: 2 }, { v: undefined }, { v: 1 }, { v: Number.NaN }];
    expect(sortRows(rows, r => r.v, 'asc').map(r => r.v).slice(0, 2)).toEqual([1, 2]);
    expect(sortRows(rows, r => r.v, 'desc').map(r => r.v).slice(0, 2)).toEqual([2, 1]);
    expect(sortRows(['', 'b', '  ', 'a'], r => r, 'desc')).toEqual(['b', 'a', '', '  ']);
    expect(sortTime('not a date')).toBeNull();
    expect(compareSortValues(null, null, 'asc')).toBe(0);
  });

  it('treats missing or non-numeric amounts as empty, not zero', () => {
    const rows = [{ v: null }, { v: '12.50' }, { v: 0 }, { v: undefined }, { v: '' }, { v: 'n/a' }];
    expect(sortRows(rows, r => sortNumber(r.v), 'asc').map(r => r.v).slice(0, 2)).toEqual([0, '12.50']);
    expect(sortRows(rows, r => sortNumber(r.v), 'desc').map(r => r.v).slice(0, 2)).toEqual(['12.50', 0]);
    expect(sortNumber(null)).toBeNull();
    expect(sortNumber('n/a')).toBeNull();
  });

  it('keeps equal rows in their loaded order and does not change the input', () => {
    const rows = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'c', v: 0 }];
    expect(sortRows(rows, r => r.v, 'asc').map(r => r.id)).toEqual(['c', 'a', 'b']);
    expect(rows.map(r => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('starts a new column ascending and reverses on the same column', () => {
    const first = nextSortState<'name' | 'amount'>({ key: null, direction: 'asc' }, 'name');
    expect(first).toEqual({ key: 'name', direction: 'asc' });
    const second = nextSortState(first, 'name');
    expect(second).toEqual({ key: 'name', direction: 'desc' });
    expect(nextSortState(second, 'amount')).toEqual({ key: 'amount', direction: 'asc' });
  });
});

const ROWS = [
  { name: 'beta', amount: 50, date: '2026-01-05' },
  { name: 'Alpha', amount: 1000, date: null },
  { name: 'gamma', amount: 7, date: '2025-06-01' },
];

function Harness() {
  const { sorted, sortProps } = useTableSort(ROWS, {
    name: r => r.name,
    amount: r => r.amount,
    date: r => sortTime(r.date),
  });
  return (
    <table>
      <thead>
        <tr>
          <SortableTh {...sortProps('name')} className="uppercase">Name</SortableTh>
          <SortableTh {...sortProps('amount')}>Amount</SortableTh>
          <SortableTh {...sortProps('date')}>Date</SortableTh>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map(r => <tr key={r.name}><td>{r.name}</td><td>{r.amount}</td><td>{r.date ?? '—'}</td><td /></tr>)}
      </tbody>
    </table>
  );
}

const names = () => within(screen.getAllByRole('rowgroup')[1]).getAllByRole('row').map(r => r.firstChild?.textContent);

describe('SortableTh rendered', () => {
  it('keeps loaded order until clicked, then sorts and reverses with aria-sort', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(names()).toEqual(['beta', 'Alpha', 'gamma']);
    const amount = screen.getByRole('columnheader', { name: /Amount/ });
    expect(amount).not.toHaveAttribute('aria-sort');

    await user.click(screen.getByRole('button', { name: /Amount/ }));
    expect(names()).toEqual(['gamma', 'beta', 'Alpha']);
    expect(amount).toHaveAttribute('aria-sort', 'ascending');

    await user.click(screen.getByRole('button', { name: /Amount/ }));
    expect(names()).toEqual(['Alpha', 'beta', 'gamma']);
    expect(amount).toHaveAttribute('aria-sort', 'descending');

    // Only the active column carries aria-sort; Actions is not sortable.
    expect(screen.getByRole('columnheader', { name: /Name/ })).not.toHaveAttribute('aria-sort');
    expect(within(screen.getByRole('columnheader', { name: 'Actions' })).queryByRole('button')).toBeNull();
  });

  it('works by keyboard and puts empty dates last', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const dateButton = screen.getByRole('button', { name: /Date/ });
    dateButton.focus();
    await user.keyboard('{Enter}');
    expect(names()).toEqual(['gamma', 'beta', 'Alpha']);
    await user.keyboard(' ');
    expect(names()).toEqual(['beta', 'gamma', 'Alpha']);
    expect(screen.getByRole('columnheader', { name: /Date/ })).toHaveAttribute('aria-sort', 'descending');
  });

  it('sorts text case-insensitively and keeps the header classes', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: /Name/ }));
    expect(names()).toEqual(['Alpha', 'beta', 'gamma']);
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveClass('uppercase');
  });
});

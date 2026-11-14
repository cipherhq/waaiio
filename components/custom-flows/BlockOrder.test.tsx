// @vitest-environment jsdom
import React, { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BlockOrder } from './BlockOrder';

afterEach(cleanup);

function Harness() {
  const [value, setValue] = useState(['a', 'b', 'c']);
  return <>
    <BlockOrder value={value} onValueChange={setValue} labels={{ a: 'A', b: 'B', c: 'C' }} instructionsId="help" upLabel="Up" downLabel="Down" />
    <p id="help">Space picks up and drops; arrows move; Escape cancels.</p>
    <output data-testid="order">{value.join(',')}</output>
  </>;
}

describe('BlockOrder SDK integration', () => {
  it('moves up and down in opposite directions, restoring focus at boundaries', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Up: B' }));
    await waitFor(() => expect(screen.getByTestId('order').textContent).toBe('b,a,c'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'B' })));
    expect((screen.getByRole('button', { name: 'Up: B' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Down: A' }));
    await waitFor(() => expect(screen.getByTestId('order').textContent).toBe('b,c,a'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'A' })));
    expect((screen.getByRole('button', { name: 'Down: A' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('commits a keyboard reorder only on drop', async () => {
    render(<Harness />);
    const item = screen.getByRole('button', { name: 'A' });
    fireEvent.keyDown(item, { key: ' ' });
    fireEvent.keyDown(item, { key: 'ArrowDown' });
    expect(screen.getByTestId('order').textContent).toBe('a,b,c');
    fireEvent.keyDown(item, { key: ' ' });
    await waitFor(() => expect(screen.getByTestId('order').textContent).toBe('b,a,c'));
  });

  it.each(['Escape', 'Tab'])('%s cancels an uncommitted reorder', async (key) => {
    render(<Harness />);
    const item = screen.getByRole('button', { name: 'A' });
    fireEvent.keyDown(item, { key: ' ' });
    fireEvent.keyDown(item, { key: 'ArrowDown' });
    fireEvent.keyDown(item, { key });
    await waitFor(() => expect(screen.getByTestId('order').textContent).toBe('a,b,c'));
    expect(screen.getByRole('button', { name: 'Down: A' }).hasAttribute('disabled')).toBe(false);
  });
});

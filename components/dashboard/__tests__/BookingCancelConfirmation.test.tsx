// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BookingCancelConfirmation } from '../BookingCancelConfirmation';
afterEach(cleanup);
const bookings = [{ id: 'one', label: 'REF1 — Alex — 2026-11-20 14:00' }];
describe('booking cancellation confirmation', () => {
  it.each(['safe', 'escape', 'backdrop'])('does not mutate on %s dismissal and initially focuses safe choice', mode => {
    const onCancel = vi.fn(), onClose = vi.fn();
    render(<BookingCancelConfirmation bookings={bookings} onCancel={onCancel} onClose={onClose} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep booking' }));
    expect(screen.getByText(bookings[0].label)).toBeTruthy();
    if (mode === 'safe') fireEvent.click(screen.getByRole('button', { name: 'Keep booking' }));
    if (mode === 'escape') fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    if (mode === 'backdrop') fireEvent.click(screen.getByRole('dialog').parentElement!);
    expect(onCancel).not.toHaveBeenCalled(); expect(onClose).toHaveBeenCalledOnce();
  });
  it('locks duplicate clicks and dismissals until actual success', async () => {
    let resolve!: (value: boolean) => void;
    const onCancel = vi.fn(() => new Promise<boolean>(done => { resolve = done; })), onClose = vi.fn();
    render(<BookingCancelConfirmation bookings={bookings} onCancel={onCancel} onClose={onClose} />);
    const confirm = screen.getByRole('button', { name: 'Cancel booking' });
    fireEvent.click(confirm); fireEvent.click(confirm);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Keep booking' }));
    expect(onCancel).toHaveBeenCalledExactlyOnceWith('one'); expect(onClose).not.toHaveBeenCalled();
    resolve(true); await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
  it.each(['false', 'throw'])('shows error and stays open after %s result', async result => {
    const onCancel = vi.fn(async () => { if (result === 'throw') throw Error('network'); return false; }), onClose = vi.fn();
    render(<BookingCancelConfirmation bookings={bookings} onCancel={onCancel} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Failed to update');
    expect(onClose).not.toHaveBeenCalled();
  });
  it('retains failed bulk items and never retries already-successful cancellations', async () => {
    const onCancel = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(true), onClose = vi.fn();
    render(<BookingCancelConfirmation bookings={[...bookings, { id: 'two', label: 'REF2 — Sam — 2026-11-21' }]} onCancel={onCancel} onClose={onClose} />);
    expect(screen.getByText('2 selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
    await screen.findByRole('alert');
    expect(screen.getByText('REF2 — Sam — 2026-11-21')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onCancel.mock.calls.map(call => call[0])).toEqual(['one', 'two', 'two']);
  });
});

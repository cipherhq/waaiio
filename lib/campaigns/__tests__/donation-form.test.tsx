// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DonationForm from '@/app/donate/[campaignId]/DonationForm';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function fill() {
  fireEvent.change(screen.getByLabelText('Donation amount (USD)'), { target: { value: '25' } });
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+12025550123' } });
}
describe('public donation form', () => {
  it('has labeled mobile-friendly fields and optional identity fields', () => {
    render(<DonationForm campaignId="campaign" currency="USD" minimum={5} maximum={50} />);
    const amount = screen.getByLabelText('Donation amount (USD)') as HTMLInputElement;
    expect(amount.min).toBe('5'); expect(amount.max).toBe('50'); expect(amount.inputMode).toBe('decimal');
    expect((screen.getByLabelText('Phone number') as HTMLInputElement).required).toBe(true);
    expect((screen.getByLabelText('Name (optional)') as HTMLInputElement).required).toBe(false);
    expect((screen.getByLabelText('Email (optional)') as HTMLInputElement).required).toBe(false);
  });
  it('retries an unchanged attempt with the same identity and shows the error accessibly', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'Unable to start payment. Please try again.' }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<DonationForm campaignId="campaign" currency="USD" minimum={5} maximum={50} />);
    fill(); fireEvent.click(screen.getByRole('button', { name: 'Continue to payment' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Continue to payment' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const first = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).attemptId).toBe(first.attemptId);
    expect(first).toMatchObject({ amount: 25, phone: '+12025550123' });
  });
  it('blocks double submission while initialization is pending', async () => {
    let release!: (value: unknown) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise(resolve => { release = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    render(<DonationForm campaignId="campaign" currency="USD" minimum={5} maximum={50} />);
    fill(); const button = screen.getByRole('button', { name: 'Continue to payment' });
    fireEvent.click(button); fireEvent.submit(button.closest('form')!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: 'Opening payment…' }) as HTMLButtonElement).disabled).toBe(true);
    release({ ok: false, json: async () => ({ error: 'Unable to start payment. Please try again.' }) });
    await screen.findByRole('alert');
  });
});

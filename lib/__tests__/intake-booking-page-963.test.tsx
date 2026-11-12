// @vitest-environment jsdom
/**
 * #963: the public booking page with a client intake form (Owner decisions
 * 2026-11-10), rendered and clicked through with the network stubbed:
 *  - the phone becomes required for a service with a form;
 *  - a before-booking form is answered inside the page, then the booking is
 *    sent with that intake;
 *  - a free booking with an after-booking form shows "Fill in your form".
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/auth/PhoneInput', () => ({
  PhoneInput: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input aria-label="Phone number" value={value} onChange={e => onChange(e.target.value)} />
  ),
}));
vi.mock('next/image', () => ({ default: (p: { alt: string }) => <span>{p.alt}</span> }));

import BookingForm from '@/app/b/[slug]/BookingForm';

const HOURS = Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => [d, { open: '08:00', close: '18:00' }]));
const BUSINESS = { id: 'biz-1', name: 'Healing Labs', slug: 'healing', logo_url: null, description: null, address: null, operating_hours: HOURS, country_code: 'NG' };
const SERVICE = { id: 'svc-1', name: 'Assessment', description: null, price: 0, deposit_amount: 0, duration_minutes: 30, image_url: null, is_dropoff: false, is_appointment: false, has_form: true };
const FORM = {
  status: 'pending', business_name: 'Healing Labs', business_logo: null, service_name: 'Assessment', booking_date: null, booking_time: null,
  title: 'Health intake', description: null, fields: [{ id: 'concern', label: 'Main concern', type: 'text', required: true }],
};

function stubNetwork(routes: { intake: unknown; create: unknown }) {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.startsWith('/api/bookings/public/slots')) return ok({ slots: [{ time: '10:00', available: 1 }] });
    if (url === '/api/auth/email-otp') return ok({ challengeId: 'c1' });
    if (url.startsWith('/api/auth/email-otp?action=verify')) return ok({ verified: true, otpToken: 'otp' });
    if (url === '/api/bookings/public/intake') return ok(routes.intake);
    if (url.startsWith('/api/intake/')) return ok(init?.method === 'POST' ? { status: 'submitted' } : FORM);
    if (url === '/api/bookings/public/create') return ok(body?.preview ? { total: 0, deposit: 0, tax_snapshot: null } : routes.create);
    return new Response('{}', { status: 404 });
  }));
  return calls;
}

async function reachDetails() {
  render(<BookingForm business={BUSINESS} services={[SERVICE]} />);
  fireEvent.click(screen.getByText('Assessment'));
  const day = screen.getAllByRole('button').find(b => !(b as HTMLButtonElement).disabled && /\d/.test(b.textContent || ''))!;
  fireEvent.click(day);
  await waitFor(() => expect(screen.getByText('10:00')).toBeTruthy());
  fireEvent.click(screen.getByText('10:00'));
  fireEvent.change(screen.getByPlaceholderText('John Doe'), { target: { value: 'Ada Obi' } });
  fireEvent.change(screen.getByPlaceholderText('john@example.com'), { target: { value: 'ada@example.com' } });
  fireEvent.click(screen.getByText('Verify'));
  await waitFor(() => expect(screen.getByPlaceholderText('6-digit code')).toBeTruthy());
  fireEvent.change(screen.getByPlaceholderText('6-digit code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByText('Verify'));
  await waitFor(() => expect(screen.getByText('ada@example.com')).toBeTruthy());
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('public booking page with an intake form', () => {
  it('needs the phone, shows the before-booking form inside the page, then books with the answered intake', async () => {
    const calls = stubNetwork({ intake: { required: true, intakeId: 'in-1', token: 'tok-abc' }, create: { success: true, bookingId: 'bk-1', referenceCode: 'REF1' } });
    await reachDetails();

    expect(screen.getByText('Phone').parentElement?.textContent).toContain('*');
    fireEvent.click(screen.getByText('Continue'));
    expect(screen.getByText('Please add your phone number.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+2348012345678' } });
    fireEvent.click(screen.getByText('Continue'));
    await waitFor(() => expect(screen.getByText('Health intake')).toBeTruthy());
    expect(screen.queryByText('Book Now')).toBeNull();
    expect(calls.find(c => c.url === '/api/bookings/public/intake')?.body).toMatchObject({
      businessSlug: 'healing', serviceId: 'svc-1', guestEmail: 'ada@example.com', guestPhone: '+2348012345678', otpToken: 'otp',
    });

    fireEvent.change(screen.getByLabelText(/Main concern/), { target: { value: 'Sleep' } });
    fireEvent.click(screen.getByText('Send my answers'));
    await waitFor(() => expect(screen.getByText('Book Now')).toBeTruthy());
    expect(screen.queryByText('Health intake')).toBeNull();

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('Book Now'));
    await waitFor(() => expect(screen.getByText('Booking Confirmed!')).toBeTruthy());
    expect(calls.find(c => c.url === '/api/bookings/public/create' && !(c.body as { preview?: boolean })?.preview)?.body).toMatchObject({ intakeId: 'in-1', guestPhone: '+2348012345678' });
    expect(screen.queryByText('Fill in your form')).toBeNull();
  });

  it('Back then Continue after answering keeps the same answered form', async () => {
    const calls = stubNetwork({ intake: { required: true, intakeId: 'in-1', token: 'tok-abc' }, create: { success: true, bookingId: 'bk-1', referenceCode: 'REF1' } });
    await reachDetails();
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+2348012345678' } });
    fireEvent.click(screen.getByText('Continue'));
    await waitFor(() => expect(screen.getByText('Health intake')).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/Main concern/), { target: { value: 'Sleep' } });
    fireEvent.click(screen.getByText('Send my answers'));
    await waitFor(() => expect(screen.getByText('Book Now')).toBeTruthy());

    fireEvent.click(screen.getByText('Back'));
    fireEvent.click(screen.getByText('Continue'));
    await waitFor(() => expect(calls.filter(c => c.url === '/api/bookings/public/intake')).toHaveLength(2));
    expect(calls.filter(c => c.url === '/api/bookings/public/intake')[1].body).toMatchObject({ intakeId: 'in-1' });
  });

  it('with an after-booking form, the confirmation screen links to the form', async () => {
    stubNetwork({ intake: { required: false }, create: { success: true, bookingId: 'bk-1', referenceCode: 'REF1', intakeUrl: 'https://www.waaiio.com/intake/tok-xyz' } });
    await reachDetails();
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+2348012345678' } });
    fireEvent.click(screen.getByText('Continue'));
    await waitFor(() => expect(screen.getByText('Book Now')).toBeTruthy());
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('Book Now'));
    await waitFor(() => expect(screen.getByText('Fill in your form')).toBeTruthy());
    expect(screen.getByText('Fill in your form').getAttribute('href')).toBe('https://www.waaiio.com/intake/tok-xyz');
    expect(screen.getByText(/We also emailed you the link/)).toBeTruthy();
  });

  it('a service without a form keeps the phone optional and asks for no form', async () => {
    const calls = stubNetwork({ intake: { required: false }, create: { success: true, bookingId: 'bk-1', referenceCode: 'REF1' } });
    cleanup();
    render(<BookingForm business={BUSINESS} services={[{ ...SERVICE, has_form: false }]} />);
    fireEvent.click(screen.getByText('Assessment'));
    const day = screen.getAllByRole('button').find(b => !(b as HTMLButtonElement).disabled && /\d/.test(b.textContent || ''))!;
    fireEvent.click(day);
    await waitFor(() => expect(screen.getByText('10:00')).toBeTruthy());
    fireEvent.click(screen.getByText('10:00'));
    expect(screen.getByText('(optional)')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('John Doe'), { target: { value: 'Ada Obi' } });
    fireEvent.change(screen.getByPlaceholderText('john@example.com'), { target: { value: 'ada@example.com' } });
    fireEvent.click(screen.getByText('Verify'));
    await waitFor(() => expect(screen.getByPlaceholderText('6-digit code')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('6-digit code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByText('Verify'));
    await waitFor(() => expect(screen.getByText('ada@example.com')).toBeTruthy());
    fireEvent.click(screen.getByText('Continue'));
    await waitFor(() => expect(screen.getByText('Book Now')).toBeTruthy());
    expect(calls.some(c => c.url === '/api/bookings/public/intake')).toBe(false);
  });
});

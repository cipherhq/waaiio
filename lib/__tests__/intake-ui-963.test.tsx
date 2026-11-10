// @vitest-environment jsdom
/**
 * #963 lane 2: rendered tests for the services intake setting, the booking
 * intake panel and the client intake page (Supabase client and fetch mocked).
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  tables: {} as Record<string, { data: unknown; error: unknown }>,
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from(table: string) {
      const res = () => db.tables[table] || { data: null, error: null };
      const q = {
        select: () => q, eq: () => q, order: () => q, limit: () => q,
        maybeSingle: async () => res(),
        then: (r: (v: unknown) => unknown) => Promise.resolve(res()).then(r),
      };
      return q;
    },
  }),
}));
vi.mock('next/image', () => ({ default: (p: { alt: string }) => <span>{p.alt}</span> }));

import { ServiceIntakeSettings, type ServiceIntakeValue } from '@/components/dashboard/ServiceIntakeSettings';
import { BookingIntakePanel } from '@/components/dashboard/BookingIntakePanel';
import { IntakeFormView } from '@/components/intake/IntakeFormView';
import { dropPrivateLinkEvents, isPrivateLinkPath } from '@/components/PostHogProvider';

const EMPTY: ServiceIntakeValue = { form_id: null, timing: 'before_booking', frequency: 'first_booking' };

beforeEach(() => { db.tables = {}; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ServiceIntakeSettings', () => {
  it('is hidden for a Starter business after the trial with no link', () => {
    const { container } = render(<ServiceIntakeSettings businessId="b" entitled={false} value={EMPTY} onChange={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows a kept link as paused for a Starter business, and lets it be removed', () => {
    const onChange = vi.fn();
    render(<ServiceIntakeSettings businessId="b" entitled={false} value={{ ...EMPTY, form_id: 'f1' }} onChange={onChange} />);
    expect(screen.getByTestId('intake-paused').textContent).toContain('Pro and Premium');
    fireEvent.click(screen.getByText('Remove the form from this service'));
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY, form_id: null });
  });

  it('lists the business forms for Pro/trial, disables forms with a file question, and offers when and how often', async () => {
    db.tables.forms = { data: [
      { id: 'f1', title: 'Health intake', is_active: true, fields: [{ id: 'a', type: 'text' }] },
      { id: 'f2', title: 'ID upload', is_active: true, fields: [{ id: 'b', type: 'file' }] },
    ], error: null };
    const onChange = vi.fn();
    const { rerender } = render(<ServiceIntakeSettings businessId="b" entitled value={EMPTY} onChange={onChange} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Health intake' })).toBeTruthy());
    expect((screen.getByRole('option', { name: 'ID upload (has a file question)' }) as HTMLOptionElement).disabled).toBe(true);
    expect(screen.queryByLabelText('When to send')).toBeNull();

    fireEvent.change(screen.getByLabelText('Intake form'), { target: { value: 'f1' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY, form_id: 'f1' });

    rerender(<ServiceIntakeSettings businessId="b" entitled value={{ ...EMPTY, form_id: 'f1' }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('When to send'), { target: { value: 'after_booking' } });
    expect(onChange).toHaveBeenLastCalledWith({ form_id: 'f1', timing: 'after_booking', frequency: 'first_booking' });
    fireEvent.change(screen.getByLabelText('How often'), { target: { value: 'every_booking' } });
    expect(onChange).toHaveBeenLastCalledWith({ form_id: 'f1', timing: 'before_booking', frequency: 'every_booking' });
  });
});

describe('BookingIntakePanel', () => {
  it('shows Done with the answers, labelled from the form', async () => {
    db.tables.booking_intakes = { data: [{ status: 'submitted', form_id: 'f1', form_response_id: 'r1', submitted_at: '2026-11-10T10:00:00Z', expires_at: '2026-11-20T00:00:00Z' }], error: null };
    db.tables.form_responses = { data: { answers: { concern: 'Trouble sleeping', meds: ['None', 'Other'], agree: true } }, error: null };
    db.tables.forms = { data: { fields: [{ id: 'concern', label: 'Main concern' }, { id: 'meds', label: 'Medication' }, { id: 'agree', label: 'I agree' }] }, error: null };
    render(<BookingIntakePanel businessId="b" bookingId="k" serviceId="s" />);
    await waitFor(() => expect(screen.getByText('Done')).toBeTruthy());
    expect(screen.getByText('Main concern')).toBeTruthy();
    expect(screen.getByText('Trouble sleeping')).toBeTruthy();
    expect(screen.getByText('None, Other')).toBeTruthy();
    expect(screen.getByText('Yes')).toBeTruthy();
  });

  it('prefers a submitted intake over a newer pending one', async () => {
    db.tables.booking_intakes = { data: [
      { status: 'pending', form_id: 'f2', form_response_id: null, submitted_at: null, expires_at: '2099-01-01T00:00:00Z' },
      { status: 'submitted', form_id: 'f1', form_response_id: 'r1', submitted_at: '2026-11-10T10:00:00Z', expires_at: '2026-11-20T00:00:00Z' },
    ], error: null };
    db.tables.form_responses = { data: { answers: { concern: 'Sleep' } }, error: null };
    db.tables.forms = { data: { fields: [{ id: 'concern', label: 'Main concern' }] }, error: null };
    render(<BookingIntakePanel businessId="b" bookingId="k" serviceId="s" />);
    await waitFor(() => expect(screen.getByText('Done')).toBeTruthy());
    expect(screen.getByText('Sleep')).toBeTruthy();
  });

  it('shows Intake not done, noting an expired link', async () => {
    db.tables.booking_intakes = { data: [{ status: 'pending', form_id: 'f1', form_response_id: null, submitted_at: null, expires_at: '2000-01-01T00:00:00Z' }], error: null };
    render(<BookingIntakePanel businessId="b" bookingId="k" serviceId="s" />);
    await waitFor(() => expect(screen.getByText('Intake not done')).toBeTruthy());
    expect(screen.getByText(/link has expired/)).toBeTruthy();
  });

  it('shows Not sent when the service has a form but no intake exists, and nothing when no form is linked', async () => {
    db.tables.booking_intakes = { data: [], error: null };
    db.tables.services = { data: { intake_form_id: 'f1' }, error: null };
    render(<BookingIntakePanel businessId="b" bookingId="k" serviceId="s" />);
    await waitFor(() => expect(screen.getByText('Not sent')).toBeTruthy());
    cleanup();
    db.tables.services = { data: { intake_form_id: null }, error: null };
    const { container } = render(<BookingIntakePanel businessId="b" bookingId="k" serviceId="s" />);
    await new Promise(r => setTimeout(r, 20));
    expect(container.innerHTML).toBe('');
  });

  it('says so when the intake cannot be loaded', async () => {
    db.tables.booking_intakes = { data: null, error: { message: 'denied' } };
    render(<BookingIntakePanel businessId="b" bookingId="k" serviceId="s" />);
    await waitFor(() => expect(screen.getByText(/could not be loaded/)).toBeTruthy());
  });
});

describe('IntakeFormView', () => {
  const PENDING = {
    status: 'pending', business_name: 'Healing Labs', business_logo: null, service_name: 'Assessment',
    booking_date: '2026-11-20', booking_time: '10:00:00', title: 'Health intake', description: null,
    fields: [
      { id: 'concern', label: 'Main concern', type: 'textarea', required: true },
      { id: 'agree', label: 'I agree', type: 'checkbox', required: true },
    ],
  };

  function mockFetch(getBody: unknown, post: { status: number; body: unknown } = { status: 200, body: { status: 'submitted' } }, getStatus = 200) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === 'POST') return new Response(JSON.stringify(post.body), { status: post.status });
      return new Response(JSON.stringify(getBody), { status: getStatus });
    }));
    return calls;
  }

  it('checks required answers, then sends them and thanks the client', async () => {
    const calls = mockFetch(PENDING);
    render(<IntakeFormView token="t" />);
    await waitFor(() => expect(screen.getByText('Health intake')).toBeTruthy());
    expect(screen.getByText(/Only Healing Labs can see your answers/)).toBeTruthy();

    fireEvent.click(screen.getByText('Send my answers'));
    expect(screen.getByRole('alert').textContent).toContain('"Main concern" is required');
    fireEvent.change(screen.getByLabelText(/Main concern/), { target: { value: 'Sleep' } });
    fireEvent.click(screen.getByText('Send my answers'));
    expect(screen.getByRole('alert').textContent).toContain('"I agree" is required');
    fireEvent.click(screen.getByLabelText(/I agree/).closest('div')!.querySelector('input')!);
    fireEvent.click(screen.getByText('Send my answers'));

    await waitFor(() => expect(screen.getByText('Thank you')).toBeTruthy());
    const sent = calls.find(c => c.init?.method === 'POST');
    expect(JSON.parse(String(sent?.init?.body))).toEqual({ answers: { concern: 'Sleep', agree: true } });
  });

  it('marks every state of the page so analytics never records it', async () => {
    mockFetch(PENDING);
    render(<IntakeFormView token="t" />);
    await waitFor(() => expect(screen.getByText('Health intake')).toBeTruthy());
    expect(screen.getByTestId('intake-page').className).toContain('ph-no-capture');
    cleanup();
    mockFetch({ ...PENDING, status: 'expired', fields: undefined });
    render(<IntakeFormView token="t" />);
    await waitFor(() => expect(screen.getByText('This link has expired')).toBeTruthy());
    expect(screen.getByTestId('intake-page').className).toContain('ph-no-capture');
  });

  it('shows the server error and keeps the answers on a 400', async () => {
    mockFetch(PENDING, { status: 400, body: { error: 'Please check your answer to "Main concern"' } });
    render(<IntakeFormView token="t" />);
    await waitFor(() => expect(screen.getByText('Health intake')).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/Main concern/), { target: { value: 'Sleep' } });
    fireEvent.click(screen.getByLabelText(/I agree/).closest('div')!.querySelector('input')!);
    fireEvent.click(screen.getByText('Send my answers'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Please check your answer'));
    expect((screen.getByLabelText(/Main concern/) as HTMLTextAreaElement).value).toBe('Sleep');
  });

  it('shows done, expired and invalid links without the form', async () => {
    mockFetch({ ...PENDING, status: 'submitted', fields: undefined });
    render(<IntakeFormView token="t" />);
    await waitFor(() => expect(screen.getByText('Thank you')).toBeTruthy());
    cleanup();
    mockFetch({ ...PENDING, status: 'expired', fields: undefined });
    render(<IntakeFormView token="t" />);
    await waitFor(() => expect(screen.getByText('This link has expired')).toBeTruthy());
    cleanup();
    mockFetch({ error: 'This link is not valid.' }, undefined, 404);
    render(<IntakeFormView token="t" />);
    await waitFor(() => expect(screen.getByText('This link is not valid.')).toBeTruthy());
  });
});

describe('analytics stays off private intake links', () => {
  it('recognises intake paths only', () => {
    expect(isPrivateLinkPath('/intake/abc')).toBe(true);
    expect(isPrivateLinkPath('/intake')).toBe(true);
    for (const p of ['/', '/intakes', '/form/abc', '/dashboard/services']) expect(isPrivateLinkPath(p), p).toBe(false);
  });

  it('drops any event that names an intake URL, and keeps others', () => {
    window.history.pushState({}, '', '/pricing');
    expect(dropPrivateLinkEvents({ properties: { $current_url: 'https://waaiio.com/pricing' } })).not.toBeNull();
    for (const key of ['$current_url', '$pathname', '$referrer', '$initial_current_url', '$prev_pageview_pathname']) {
      expect(dropPrivateLinkEvents({ properties: { [key]: 'https://waaiio.com/intake/SECRET' } }), key).toBeNull();
    }
    expect(dropPrivateLinkEvents({ properties: { $pathname: '/intake/SECRET?x=1' } })).toBeNull();
    expect(dropPrivateLinkEvents(null)).toBeNull();
  });

  it('drops every event while the browser is on an intake page', () => {
    window.history.pushState({}, '', '/intake/SECRET');
    expect(dropPrivateLinkEvents({ properties: { $current_url: 'https://waaiio.com/elsewhere' } })).toBeNull();
    window.history.pushState({}, '', '/');
  });
});

'use client';

import { useState } from 'react';

const INDUSTRIES = [
  'Concierge',
  'Hospitality',
  'Travel',
  'Entertainment',
  'Events',
  'Membership',
  'Other',
];

interface FormData {
  business_name: string;
  contact_name: string;
  work_email: string;
  phone: string;
  industry: string;
  estimated_volume: string;
  has_waba: string;
  use_case: string;
  notes: string;
  website: string; // honeypot
}

const initial: FormData = {
  business_name: '',
  contact_name: '',
  work_email: '',
  phone: '',
  industry: '',
  estimated_volume: '',
  has_waba: '',
  use_case: '',
  notes: '',
  website: '',
};

export default function DemoForm() {
  const [form, setForm] = useState<FormData>(initial);
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const set = (field: keyof FormData) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
  ) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('sending');
    setErrorMsg('');

    try {
      const res = await fetch('/api/demo-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          has_waba: form.has_waba === 'yes' ? true : form.has_waba === 'no' ? false : null,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to submit');
      }

      setStatus('sent');
      setForm(initial);
    } catch (err) {
      setStatus('error');
      setErrorMsg((err as Error).message);
    }
  };

  if (status === 'sent') {
    return (
      <div className="rounded-2xl border border-green-200 bg-green-50 p-8 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
          <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h3 className="mt-4 text-lg font-semibold text-green-900">Request received!</h3>
        <p className="mt-1 text-sm text-green-700">
          We&apos;ll reach out within one business day to schedule your demo.
        </p>
        <button
          onClick={() => setStatus('idle')}
          className="mt-4 text-sm font-medium text-brand hover:underline"
        >
          Submit another request
        </button>
      </div>
    );
  }

  const inputCls =
    'mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand';
  const labelCls = 'block text-sm font-medium text-gray-700';
  const req = <span className="text-red-500">*</span>;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Honeypot — hidden from real users */}
      <div className="absolute -left-[9999px]" aria-hidden="true">
        <label htmlFor="wl-website">Website</label>
        <input
          id="wl-website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={form.website}
          onChange={set('website')}
        />
      </div>

      {/* Row 1: Business name + Contact name */}
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="wl-biz" className={labelCls}>
            Business Name {req}
          </label>
          <input
            id="wl-biz"
            type="text"
            required
            maxLength={200}
            value={form.business_name}
            onChange={set('business_name')}
            className={inputCls}
            placeholder="Acme Hospitality"
          />
        </div>
        <div>
          <label htmlFor="wl-contact" className={labelCls}>
            Contact Name {req}
          </label>
          <input
            id="wl-contact"
            type="text"
            required
            maxLength={200}
            value={form.contact_name}
            onChange={set('contact_name')}
            className={inputCls}
            placeholder="Jane Doe"
          />
        </div>
      </div>

      {/* Row 2: Email + Phone */}
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="wl-email" className={labelCls}>
            Work Email {req}
          </label>
          <input
            id="wl-email"
            type="email"
            required
            maxLength={254}
            value={form.work_email}
            onChange={set('work_email')}
            className={inputCls}
            placeholder="jane@acme.com"
          />
        </div>
        <div>
          <label htmlFor="wl-phone" className={labelCls}>
            Phone / WhatsApp {req}
          </label>
          <input
            id="wl-phone"
            type="tel"
            required
            maxLength={30}
            value={form.phone}
            onChange={set('phone')}
            className={inputCls}
            placeholder="+1 555 123 4567"
          />
        </div>
      </div>

      {/* Row 3: Industry + Volume */}
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="wl-industry" className={labelCls}>
            Industry {req}
          </label>
          <select
            id="wl-industry"
            required
            value={form.industry}
            onChange={set('industry')}
            className={inputCls}
          >
            <option value="" disabled>
              Select industry
            </option>
            {INDUSTRIES.map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="wl-volume" className={labelCls}>
            Estimated Customer Volume
          </label>
          <input
            id="wl-volume"
            type="text"
            maxLength={100}
            value={form.estimated_volume}
            onChange={set('estimated_volume')}
            className={inputCls}
            placeholder="e.g. 500 monthly"
          />
        </div>
      </div>

      {/* Row 4: WABA + Use case */}
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="wl-waba" className={labelCls}>
            Do you have a WhatsApp Business (WABA) account?
          </label>
          <select
            id="wl-waba"
            value={form.has_waba}
            onChange={set('has_waba')}
            className={inputCls}
          >
            <option value="">Not sure</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </div>
        <div>
          <label htmlFor="wl-usecase" className={labelCls}>
            Are you using this for your own business, or reselling?
          </label>
          <select
            id="wl-usecase"
            value={form.use_case}
            onChange={set('use_case')}
            className={inputCls}
          >
            <option value="">Select</option>
            <option value="own_business">Own business</option>
            <option value="reselling">Reselling to clients</option>
          </select>
        </div>
      </div>

      {/* Notes */}
      <div>
        <label htmlFor="wl-notes" className={labelCls}>
          Notes
        </label>
        <textarea
          id="wl-notes"
          rows={3}
          maxLength={2000}
          value={form.notes}
          onChange={set('notes')}
          className={inputCls}
          placeholder="Tell us about your use case, number of locations, or anything else..."
        />
      </div>

      {status === 'error' && (
        <p className="text-sm text-red-600">{errorMsg || 'Something went wrong. Please try again.'}</p>
      )}

      <button
        type="submit"
        disabled={status === 'sending'}
        className="inline-flex w-full items-center justify-center rounded-xl bg-accent px-8 py-3 text-base font-bold text-gray-900 shadow-lg shadow-accent/20 transition hover:bg-accent-400 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 disabled:opacity-50 sm:w-auto"
      >
        {status === 'sending' ? (
          <>
            <svg
              aria-hidden="true"
              className="mr-2 h-4 w-4 animate-spin"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Submitting...
          </>
        ) : (
          'Book a Demo'
        )}
      </button>
    </form>
  );
}

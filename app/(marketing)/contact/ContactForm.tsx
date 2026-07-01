'use client';

import { useState, useRef, useEffect } from 'react';

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || '';

export function ContactForm() {
  const [form, setForm] = useState({ name: '', email: '', subject: '', message: '' });
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const turnstileRef = useRef<HTMLDivElement>(null);
  const honeypotRef = useRef<HTMLInputElement>(null);

  // Load Turnstile widget if site key is configured
  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || !turnstileRef.current) return;

    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad';
    script.async = true;

    (window as unknown as Record<string, unknown>).onTurnstileLoad = () => {
      if (turnstileRef.current && (window as unknown as Record<string, unknown>).turnstile) {
        (window as unknown as { turnstile: { render: (el: HTMLElement, opts: Record<string, unknown>) => void } }).turnstile.render(turnstileRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          callback: (token: string) => setTurnstileToken(token),
          'expired-callback': () => setTurnstileToken(''),
          theme: 'light',
        });
      }
    };

    document.head.appendChild(script);
    return () => { script.remove(); };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('sending');
    setErrorMsg('');

    // If Turnstile is configured but no token, block submission
    if (TURNSTILE_SITE_KEY && !turnstileToken) {
      setStatus('error');
      setErrorMsg('Please complete the verification check.');
      return;
    }

    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          // Honeypot — invisible to humans, bots fill it
          website: honeypotRef.current?.value || '',
          // Turnstile token
          turnstileToken: turnstileToken || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to send');
      }

      setStatus('sent');
      setForm({ name: '', email: '', subject: '', message: '' });
    } catch (err) {
      setStatus('error');
      setErrorMsg((err as Error).message);
    }
  };

  if (status === 'sent') {
    return (
      <div className="mt-6 rounded-2xl border border-green-200 bg-green-50 p-8 text-center">
        <div className="text-3xl">✅</div>
        <h3 className="mt-3 text-lg font-semibold text-green-900">Message sent!</h3>
        <p className="mt-1 text-sm text-green-700">
          We&apos;ll get back to you within 24 hours.
        </p>
        <button
          onClick={() => setStatus('idle')}
          className="mt-4 text-sm font-medium text-brand hover:underline"
        >
          Send another message
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-gray-700">
            Name <span className="text-red-500">*</span>
          </label>
          <input
            id="name"
            type="text"
            required
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            placeholder="Your name"
          />
        </div>
        <div>
          <label htmlFor="email" className="block text-sm font-medium text-gray-700">
            Email <span className="text-red-500">*</span>
          </label>
          <input
            id="email"
            type="email"
            required
            value={form.email}
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            placeholder="you@example.com"
          />
        </div>
      </div>

      {/* Honeypot — hidden from humans, bots fill it */}
      <div className="absolute -left-[9999px]" aria-hidden="true">
        <label htmlFor="website">Website</label>
        <input ref={honeypotRef} id="website" type="text" name="website" tabIndex={-1} autoComplete="off" />
      </div>

      <div>
        <label htmlFor="subject" className="block text-sm font-medium text-gray-700">
          Subject
        </label>
        <input
          id="subject"
          type="text"
          value={form.subject}
          onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
          className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          placeholder="What's this about?"
        />
      </div>

      <div>
        <label htmlFor="message" className="block text-sm font-medium text-gray-700">
          Message <span className="text-red-500">*</span>
        </label>
        <textarea
          id="message"
          required
          rows={5}
          value={form.message}
          onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
          className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          placeholder="Tell us how we can help..."
        />
      </div>

      {/* Turnstile widget — only renders if site key is configured */}
      {TURNSTILE_SITE_KEY && (
        <div ref={turnstileRef} className="mt-2" />
      )}

      {status === 'error' && (
        <p className="text-sm text-red-600">{errorMsg || 'Something went wrong. Please try again.'}</p>
      )}

      <button
        type="submit"
        disabled={status === 'sending'}
        className="inline-flex items-center rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand/90 focus:outline-none focus:ring-2 focus:ring-brand focus:ring-offset-2 disabled:opacity-50"
      >
        {status === 'sending' ? (
          <>
            <svg aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Sending...
          </>
        ) : (
          'Send Message'
        )}
      </button>
    </form>
  );
}

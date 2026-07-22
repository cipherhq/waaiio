'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import Image from 'next/image';

type PageState = 'loading' | 'not_found' | 'unavailable' | 'form' | 'submitting' | 'success' | 'already_checked_in';

interface BusinessInfo {
  name: string;
  logo_url: string | null;
}

export default function CheckInPage({ params }: { params: { businessId: string } }) {
  const { businessId } = params;
  const [state, setState] = useState<PageState>('loading');
  const [business, setBusiness] = useState<BusinessInfo | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [waLink, setWaLink] = useState('');
  const [checkedInAt, setCheckedInAt] = useState('');

  // Load business info with AbortController timeout.
  // 3 seconds is appropriate because:
  //   - Supabase queries typically complete in <500ms
  //   - Mobile users on slow networks get up to 3s before a clear error
  //   - Faster than the previous infinite hang on DNS/CSP failures
  //   - Leaves room for the UI to render before Playwright's 5s assertion timeout
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);

    async function load() {
      try {
        const supabase = createClient();
        const { data, error } = await supabase
          .from('businesses')
          .select('name, logo_url')
          .eq('id', businessId)
          .eq('is_active', true)
          .abortSignal(controller.signal)
          .maybeSingle();

        if (cancelled) return;

        if (error) {
          // Query reached Supabase but failed — service issue, not "not found"
          setState('unavailable');
          return;
        }
        if (!data) {
          // Query succeeded, business genuinely does not exist
          setState('not_found');
          return;
        }
        setBusiness(data);
        setState('form');
      } catch {
        // Network failure, DNS failure, timeout, CSP block — service unavailable
        if (!cancelled) setState('unavailable');
      } finally {
        clearTimeout(timer);
      }
    }
    load();
    return () => { cancelled = true; controller.abort(); };
  }, [businessId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setState('submitting');
    setError('');

    try {
      const res = await fetch('/api/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: businessId,
          customer_name: name.trim(),
          customer_phone: phone.trim() || undefined,
          customer_email: email.trim() || undefined,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Check-in failed. Please try again.');
        setState('form');
        return;
      }

      if (data.wa_link) setWaLink(data.wa_link);

      if (data.already_checked_in) {
        setCheckedInAt(data.checked_in_at);
        setState('already_checked_in');
      } else {
        setState('success');
      }
    } catch {
      setError('Network error. Please try again.');
      setState('form');
    }
  }

  if (state === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand border-t-transparent" />
      </div>
    );
  }

  if (state === 'not_found') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="text-center">
          <p className="text-4xl">🔍</p>
          <h1 className="mt-4 text-xl font-bold text-gray-900">Business not found</h1>
          <p className="mt-2 text-sm text-gray-500">This check-in link may be invalid or expired.</p>
        </div>
      </div>
    );
  }

  if (state === 'unavailable') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="text-center">
          <p className="text-4xl">⚠️</p>
          <h1 className="mt-4 text-xl font-bold text-gray-900">Temporarily unavailable</h1>
          <p className="mt-2 text-sm text-gray-500">We couldn&apos;t load this page right now. Please try again in a moment.</p>
          <button
            onClick={() => { setState('loading'); window.location.reload(); }}
            className="mt-4 rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-8">
      <div className="w-full max-w-md">
        {/* Business header */}
        <div className="mb-6 text-center">
          {business?.logo_url ? (
            <Image
              src={business.logo_url}
              alt={business.name}
              width={64}
              height={64}
              className="mx-auto h-16 w-16 rounded-full object-cover border border-gray-200"
            />
          ) : (
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-100 text-2xl">
              ✅
            </div>
          )}
          <h1 className="mt-3 text-xl font-bold text-gray-900">{business?.name}</h1>
        </div>

        {/* Form state */}
        {(state === 'form' || state === 'submitting') && (
          <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-gray-900">Check In</h2>
            <p className="mt-1 text-sm text-gray-500">Let us know you&apos;re here.</p>

            {error && (
              <div className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
            )}

            <form onSubmit={handleSubmit} className="mt-4 space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Your name *</label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="e.g. John Doe"
                  className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100"
                  required
                  autoFocus
                  autoComplete="name"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Phone <span className="text-gray-400">(optional)</span>
                </label>
                <input
                  type="tel"
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  placeholder="e.g. 08012345678"
                  className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100"
                  autoComplete="tel"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Email <span className="text-gray-400">(optional)</span>
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="e.g. john@email.com"
                  className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100"
                  autoComplete="email"
                />
              </div>

              <button
                type="submit"
                disabled={!name.trim() || state === 'submitting'}
                className="w-full rounded-xl bg-brand py-3.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
              >
                {state === 'submitting' ? 'Checking in...' : 'Check In'}
              </button>
            </form>
          </div>
        )}

        {/* Success state */}
        {state === 'success' && (
          <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
              <svg className="h-8 w-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="mt-4 text-xl font-bold text-gray-900">You&apos;re checked in!</h2>
            <p className="mt-2 text-sm text-gray-500">Welcome to {business?.name}</p>

            {waLink && (
              <a
                href={waLink}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-[#25D366] py-3.5 text-sm font-bold text-white transition hover:bg-[#20bd5a]"
              >
                <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                Connect on WhatsApp for updates
              </a>
            )}
          </div>
        )}

        {/* Already checked in state */}
        {state === 'already_checked_in' && (
          <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-blue-100">
              <span className="text-2xl">👋</span>
            </div>
            <h2 className="mt-4 text-xl font-bold text-gray-900">Welcome back!</h2>
            <p className="mt-2 text-sm text-gray-500">
              You already checked in today at{' '}
              <span className="font-medium text-gray-700">
                {new Date(checkedInAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </p>

            {waLink && (
              <a
                href={waLink}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-[#25D366] py-3.5 text-sm font-bold text-white transition hover:bg-[#20bd5a]"
              >
                <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                Connect on WhatsApp for updates
              </a>
            )}
          </div>
        )}

        {/* Footer */}
        <p className="mt-6 text-center text-xs text-gray-400">Powered by Waaiio</p>
      </div>
    </div>
  );
}

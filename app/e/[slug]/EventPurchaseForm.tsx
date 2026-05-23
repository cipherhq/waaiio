'use client';

import { useState } from 'react';
import { PhoneInput } from '@/components/auth/PhoneInput';
import { formatCurrency, type CountryCode } from '@/lib/constants';

interface TicketType {
  id: string;
  name: string;
  price: number;
  available: number;
}

interface EventData {
  id: string;
  name: string;
  description: string | null;
  date: string;
  time: string | null;
  end_date: string | null;
  end_time: string | null;
  venue: string | null;
  price: number;
  image_url: string | null;
  max_per_order: number | null;
  slug: string;
  available: number;
}

interface BusinessData {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  country_code: string;
  payment_gateway: string | null;
}

type PageState = 'ready' | 'purchasing' | 'success' | 'error';

export default function EventPurchaseForm({
  event,
  ticketTypes,
  business,
}: {
  event: EventData;
  ticketTypes: TicketType[];
  business: BusinessData;
}) {
  const [state, setState] = useState<PageState>('ready');
  const [errorMsg, setErrorMsg] = useState('');

  // Form state
  const [selectedTicketType, setSelectedTicketType] = useState<string>(
    ticketTypes.length === 1 ? ticketTypes[0].id : '',
  );
  const [quantity, setQuantity] = useState(1);
  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [agreedToTerms, setAgreedToTerms] = useState(false);

  // Email OTP verification
  const [emailVerified, setEmailVerified] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpError, setOtpError] = useState('');
  const [otpToken, setOtpToken] = useState('');

  // Success state
  const [referenceCode, setReferenceCode] = useState('');

  const cc = (business.country_code || 'US') as CountryCode;
  const hasTicketTypes = ticketTypes.length > 0;

  // Determine price and availability
  const selectedTT = hasTicketTypes
    ? ticketTypes.find((tt) => tt.id === selectedTicketType)
    : null;

  const unitPrice = selectedTT ? selectedTT.price : event.price;
  const currentAvailable = selectedTT ? selectedTT.available : event.available;
  const isSoldOut = currentAvailable <= 0;
  const maxQty = Math.min(event.max_per_order || 10, currentAvailable);
  const totalPrice = unitPrice * quantity;

  function formatDate(dateStr: string, timeStr: string | null) {
    let date = dateStr;
    try {
      date = new Date(dateStr + 'T00:00').toLocaleDateString('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
    } catch {
      /* keep raw */
    }

    let time = timeStr || '';
    if (time) {
      try {
        const [h, m] = time.split(':');
        const dt = new Date();
        dt.setHours(parseInt(h, 10), parseInt(m, 10));
        time = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      } catch {
        /* keep raw */
      }
    }

    return time ? `${date} at ${time}` : date;
  }

  async function sendOtp() {
    if (!guestEmail.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail)) {
      setOtpError('Enter a valid email first');
      return;
    }
    setOtpLoading(true);
    setOtpError('');
    try {
      const res = await fetch('/api/auth/email-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: guestEmail.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        setOtpError(data.error || 'Failed to send code');
      } else {
        setOtpSent(true);
      }
    } catch {
      setOtpError('Network error. Try again.');
    }
    setOtpLoading(false);
  }

  async function verifyOtp() {
    if (!otpCode || otpCode.length !== 4) {
      setOtpError('Enter the 4-digit code');
      return;
    }
    setOtpLoading(true);
    setOtpError('');
    try {
      const res = await fetch('/api/auth/email-otp?action=verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: guestEmail.trim(), code: otpCode }),
      });
      const data = await res.json();
      if (data.verified) {
        setEmailVerified(true);
        setOtpToken(data.otpToken || '');
        setOtpSent(false);
      } else {
        setOtpError(data.error || 'Invalid code');
      }
    } catch {
      setOtpError('Network error. Try again.');
    }
    setOtpLoading(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!guestName.trim() || !guestEmail.trim()) {
      setErrorMsg('Please fill in your name and email.');
      return;
    }

    if (!emailVerified) {
      setErrorMsg('Please verify your email first.');
      return;
    }

    if (!agreedToTerms) {
      setErrorMsg('Please agree to the terms and conditions.');
      return;
    }

    if (hasTicketTypes && !selectedTicketType) {
      setErrorMsg('Please select a ticket type.');
      return;
    }

    setState('purchasing');
    setErrorMsg('');

    try {
      const response = await fetch('/api/events/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventSlug: event.slug,
          ticketTypeId: selectedTicketType || undefined,
          quantity,
          guestName: guestName.trim(),
          guestEmail: guestEmail.trim(),
          guestPhone: guestPhone || undefined,
          otpToken,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        setErrorMsg(result.error || 'Something went wrong. Please try again.');
        setState('error');
        return;
      }

      // If payment URL returned, redirect
      if (result.url) {
        window.location.href = result.url;
        return;
      }

      // Free event success
      setReferenceCode(result.referenceCode || '');
      setState('success');
    } catch {
      setErrorMsg('Something went wrong. Please try again.');
      setState('error');
    }
  }

  const dateLabel = formatDate(event.date, event.time);

  // Success state
  if (state === 'success') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-purple-50 to-indigo-50 px-4">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-xl">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
            <svg className="h-8 w-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="mt-4 text-2xl font-bold text-gray-900">Tickets Confirmed!</h2>
          <p className="mt-2 text-sm text-gray-600">
            You&apos;re all set for <span className="font-semibold">{event.name}</span>.
          </p>
          {referenceCode && (
            <div className="mt-4 rounded-xl bg-gray-50 px-4 py-3">
              <p className="text-xs text-gray-500">Reference Code</p>
              <p className="text-lg font-bold text-[#6C2BD9]">{referenceCode}</p>
            </div>
          )}
          <div className="mt-4 rounded-xl bg-gray-50 p-4 text-left">
            <h3 className="font-semibold text-gray-900">{event.name}</h3>
            <p className="mt-1 text-sm text-gray-600">{dateLabel}</p>
            {event.venue && <p className="text-sm text-gray-600">{event.venue}</p>}
            <p className="text-sm text-gray-600">
              {quantity} ticket{quantity > 1 ? 's' : ''}
            </p>
          </div>
          <p className="mt-2 text-xs text-gray-400">
            A confirmation has been sent to {guestEmail}
          </p>
          <div className="mt-6 border-t border-gray-100 pt-4">
            <a
              href="https://www.waaiio.com"
              className="text-xs text-gray-400 hover:text-[#6C2BD9]"
            >
              Powered by Waaiio
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-indigo-50">
      <div className="mx-auto max-w-lg">
        {/* Hero image */}
        {event.image_url && (
          <div className="relative w-full overflow-hidden bg-gray-200" style={{ maxHeight: 400 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={event.image_url}
              alt={event.name}
              className="h-full w-full object-cover"
              style={{ maxHeight: 400 }}
            />
          </div>
        )}

        {/* Event details card */}
        <div className="rounded-b-2xl bg-white px-6 pb-8 pt-6 shadow-xl sm:mx-4 sm:mt-[-20px] sm:rounded-2xl">
          {/* Business info */}
          <div className="flex items-center gap-3">
            {business.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={business.logo_url}
                alt={business.name}
                className="h-10 w-10 rounded-full object-cover"
              />
            ) : (
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#6C2BD9] text-sm font-bold text-white">
                {business.name.charAt(0)}
              </div>
            )}
            <span className="text-sm font-medium text-gray-500">{business.name}</span>
          </div>

          {/* Event name */}
          <h1 className="mt-4 text-2xl font-bold text-gray-900">{event.name}</h1>

          {/* Date & venue */}
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-3 text-sm text-gray-600">
              <svg className="h-5 w-5 flex-shrink-0 text-[#6C2BD9]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <span>{dateLabel}</span>
            </div>
            {event.venue && (
              <div className="flex items-center gap-3 text-sm text-gray-600">
                <svg className="h-5 w-5 flex-shrink-0 text-[#6C2BD9]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <span>{event.venue}</span>
              </div>
            )}
          </div>

          {/* Description */}
          {event.description && (
            <p className="mt-4 text-sm leading-relaxed text-gray-600">{event.description}</p>
          )}

          {/* Sold out badge */}
          {isSoldOut && (
            <div className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-center">
              <span className="text-sm font-semibold text-red-600">Sold Out</span>
            </div>
          )}

          {/* Purchase form */}
          {!isSoldOut && (
            <form onSubmit={handleSubmit} className="mt-6 space-y-5">
              {/* Ticket type selector */}
              {hasTicketTypes && ticketTypes.length > 1 && (
                <div>
                  <label className="mb-2 block text-sm font-semibold text-gray-900">
                    Select Ticket
                  </label>
                  <div className="space-y-2">
                    {ticketTypes.map((tt) => {
                      const ttSoldOut = tt.available <= 0;
                      return (
                        <button
                          key={tt.id}
                          type="button"
                          disabled={ttSoldOut}
                          onClick={() => {
                            setSelectedTicketType(tt.id);
                            // Reset quantity if it exceeds new availability
                            const newMax = Math.min(event.max_per_order || 10, tt.available);
                            if (quantity > newMax) setQuantity(Math.max(1, newMax));
                          }}
                          className={`flex w-full items-center justify-between rounded-xl border-2 p-4 text-left transition ${
                            ttSoldOut
                              ? 'cursor-not-allowed border-gray-100 bg-gray-50 opacity-50'
                              : selectedTicketType === tt.id
                                ? 'border-[#6C2BD9] bg-purple-50'
                                : 'border-gray-200 hover:border-gray-300'
                          }`}
                        >
                          <div>
                            <p className="text-sm font-semibold text-gray-900">{tt.name}</p>
                            <p className="text-xs text-gray-500">
                              {ttSoldOut
                                ? 'Sold out'
                                : `${tt.available} remaining`}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-bold text-gray-900">
                              {tt.price > 0 ? formatCurrency(tt.price, cc) : 'Free'}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Single ticket type — just show price */}
              {hasTicketTypes && ticketTypes.length === 1 && (
                <div className="flex items-center justify-between rounded-xl bg-gray-50 p-4">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{ticketTypes[0].name}</p>
                    <p className="text-xs text-gray-500">{ticketTypes[0].available} remaining</p>
                  </div>
                  <p className="text-sm font-bold text-gray-900">
                    {ticketTypes[0].price > 0 ? formatCurrency(ticketTypes[0].price, cc) : 'Free'}
                  </p>
                </div>
              )}

              {/* No ticket types — show event price */}
              {!hasTicketTypes && (
                <div className="flex items-center justify-between rounded-xl bg-gray-50 p-4">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">General Admission</p>
                    <p className="text-xs text-gray-500">{event.available} remaining</p>
                  </div>
                  <p className="text-sm font-bold text-gray-900">
                    {event.price > 0 ? formatCurrency(event.price, cc) : 'Free'}
                  </p>
                </div>
              )}

              {/* Quantity selector */}
              {maxQty > 1 && (
                <div>
                  <label className="mb-2 block text-sm font-semibold text-gray-900">
                    Quantity
                  </label>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setQuantity(Math.max(1, quantity - 1))}
                      disabled={quantity <= 1}
                      className="flex h-10 w-10 items-center justify-center rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-30"
                    >
                      -
                    </button>
                    <span className="w-8 text-center text-lg font-semibold text-gray-900">
                      {quantity}
                    </span>
                    <button
                      type="button"
                      onClick={() => setQuantity(Math.min(maxQty, quantity + 1))}
                      disabled={quantity >= maxQty}
                      className="flex h-10 w-10 items-center justify-center rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-30"
                    >
                      +
                    </button>
                  </div>
                </div>
              )}

              {/* Guest info */}
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Full Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={guestName}
                    onChange={(e) => setGuestName(e.target.value)}
                    required
                    placeholder="John Doe"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-[#6C2BD9] focus:ring-1 focus:ring-[#6C2BD9]"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Email <span className="text-red-500">*</span>
                  </label>
                  {emailVerified ? (
                    <div className="flex items-center gap-2 rounded-lg border border-green-300 bg-green-50 px-3 py-2.5 text-sm">
                      <span className="text-green-600">&#10003;</span>
                      <span className="text-gray-700">{guestEmail}</span>
                      <button
                        type="button"
                        onClick={() => { setEmailVerified(false); setOtpSent(false); setOtpCode(''); }}
                        className="ml-auto text-xs text-gray-400 hover:text-gray-600"
                      >
                        Change
                      </button>
                    </div>
                  ) : otpSent ? (
                    <div>
                      <p className="mb-2 text-xs text-gray-500">Code sent to {guestEmail}</p>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          inputMode="numeric"
                          maxLength={4}
                          value={otpCode}
                          onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
                          placeholder="4-digit code"
                          className="flex-1 rounded-lg border border-gray-200 px-3 py-2.5 text-center text-lg font-bold tracking-[0.3em] outline-none focus:border-[#6C2BD9]"
                        />
                        <button
                          type="button"
                          onClick={verifyOtp}
                          disabled={otpLoading || otpCode.length !== 4}
                          className="rounded-lg bg-[#6C2BD9] px-4 py-2.5 text-sm font-bold text-white transition hover:bg-[#5a22b8] disabled:opacity-50"
                        >
                          {otpLoading ? '...' : 'Verify'}
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={sendOtp}
                        disabled={otpLoading}
                        className="mt-1 text-xs text-[#6C2BD9] hover:underline"
                      >
                        Resend code
                      </button>
                      {otpError && <p className="mt-1 text-xs text-red-500">{otpError}</p>}
                    </div>
                  ) : (
                    <div>
                      <p className="text-xs text-gray-500 mb-1">We&apos;ll send a 4-digit code to verify your email — your tickets will be sent here.</p>
                      <div className="flex gap-2">
                        <input
                          type="email"
                          value={guestEmail}
                          onChange={(e) => setGuestEmail(e.target.value)}
                          required
                          placeholder="john@example.com"
                          className="flex-1 rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-[#6C2BD9] focus:ring-1 focus:ring-[#6C2BD9]"
                        />
                        <button
                          type="button"
                          onClick={sendOtp}
                          disabled={otpLoading || !guestEmail.trim()}
                          className="rounded-lg bg-[#6C2BD9] px-4 py-2.5 text-sm font-bold text-white transition hover:bg-[#5a22b8] disabled:opacity-50"
                        >
                          {otpLoading ? '...' : 'Verify'}
                        </button>
                      </div>
                      {otpError && <p className="mt-1 text-xs text-red-500">{otpError}</p>}
                    </div>
                  )}
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Phone <span className="text-xs text-gray-400">(optional)</span>
                  </label>
                  <PhoneInput
                    value={guestPhone}
                    onChange={setGuestPhone}
                    countryCode={cc}
                  />
                </div>
              </div>

              {/* Total price */}
              {totalPrice > 0 && (
                <div className="flex items-center justify-between rounded-xl bg-purple-50 px-4 py-3">
                  <span className="text-sm font-medium text-gray-700">Total</span>
                  <span className="text-lg font-bold text-[#6C2BD9]">
                    {formatCurrency(totalPrice, cc)}
                  </span>
                </div>
              )}

              {/* Error message */}
              {errorMsg && (
                <p className="text-sm text-red-600">{errorMsg}</p>
              )}

              {/* Terms checkbox */}
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={agreedToTerms}
                  onChange={(e) => setAgreedToTerms(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-[#6C2BD9] focus:ring-[#6C2BD9]"
                />
                <span className="text-xs text-gray-500">
                  I agree to {business.name}&apos;s and <a href="/terms" target="_blank" className="text-[#6C2BD9] underline">Waaiio&apos;s terms</a> and policies
                </span>
              </label>

              {/* Submit button */}
              <button
                type="submit"
                disabled={state === 'purchasing' || (hasTicketTypes && !selectedTicketType) || !agreedToTerms}
                className="w-full rounded-xl bg-[#6C2BD9] py-3.5 text-sm font-semibold text-white shadow-lg transition hover:bg-[#5a23b5] disabled:opacity-50"
              >
                {state === 'purchasing'
                  ? 'Processing...'
                  : totalPrice > 0
                    ? `Buy Tickets - ${formatCurrency(totalPrice, cc)}`
                    : 'Get Free Tickets'}
              </button>

              <p className="text-center text-xs text-gray-400">
                {totalPrice > 0
                  ? "You'll be redirected to complete payment securely"
                  : 'No payment required'}
              </p>
            </form>
          )}

          {/* Footer */}
          <div className="mt-8 border-t border-gray-100 pt-4 text-center">
            <a
              href="https://www.waaiio.com"
              className="text-xs text-gray-400 hover:text-[#6C2BD9]"
            >
              Powered by Waaiio
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

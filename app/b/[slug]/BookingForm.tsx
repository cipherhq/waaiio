'use client';

import { useState, useEffect, useCallback } from 'react';
import { PhoneInput } from '@/components/auth/PhoneInput';
import { type CountryCode } from '@/lib/constants';

// ── Types ──

interface BusinessInfo {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  description: string | null;
  address: string | null;
  operating_hours: Record<string, { open?: string; close?: string; closed?: boolean }> | null;
  country_code: string;
}

interface ServiceInfo {
  id: string;
  name: string;
  description: string | null;
  price: number;
  deposit_amount: number | null;
  duration_minutes: number;
  image_url: string | null;
  is_dropoff: boolean;
}

interface TimeSlot {
  time: string;
  available: number;
}

interface BookingFormProps {
  business: BusinessInfo;
  services: ServiceInfo[];
}

// ── Helpers ──

const STEPS = ['Service', 'Date', 'Time', 'Details', 'Confirm'] as const;

function getCurrencySymbol(cc: string): string {
  const map: Record<string, string> = { NG: '\u20a6', GH: 'GH\u20b5', GB: '\u00a3', CA: '$', US: '$' };
  return map[cc] || '$';
}

function formatPrice(amount: number, cc: string): string {
  return `${getCurrencySymbol(cc)}${amount.toLocaleString()}`;
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function getNext30Days(operatingHours: BusinessInfo['operating_hours']): { date: string; label: string; dayName: string; closed: boolean }[] {
  const days: { date: string; label: string; dayName: string; closed: boolean }[] = [];
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const now = new Date();

  for (let i = 0; i < 30; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    const dayName = dayNames[d.getDay()];
    const closed = operatingHours?.[dayName]?.closed === true;

    days.push({
      date: dateStr,
      label: d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' }),
      dayName,
      closed,
    });
  }

  return days;
}

// ── Step Indicator ──

function StepIndicator({ currentStep }: { currentStep: number }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-6">
      {STEPS.map((label, i) => {
        const stepNum = i + 1;
        const isActive = stepNum === currentStep;
        const isComplete = stepNum < currentStep;

        return (
          <div key={label} className="flex items-center gap-2">
            <div
              className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
                isActive
                  ? 'bg-brand text-white'
                  : isComplete
                    ? 'bg-brand-100 text-brand-700'
                    : 'bg-gray-100 text-gray-400'
              }`}
            >
              {isComplete ? (
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                stepNum
              )}
            </div>
            {i < STEPS.length - 1 && (
              <div className={`hidden sm:block h-0.5 w-6 ${isComplete ? 'bg-brand-300' : 'bg-gray-200'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Main Component ──

export default function BookingForm({ business, services }: BookingFormProps) {
  const [step, setStep] = useState(1);
  const [selectedService, setSelectedService] = useState<ServiceInfo | null>(null);
  const [selectedDate, setSelectedDate] = useState('');
  const [selectedTime, setSelectedTime] = useState('');
  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [emailVerified, setEmailVerified] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpError, setOtpError] = useState('');
  const [otpToken, setOtpToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [referenceCode, setReferenceCode] = useState('');
  const [slots, setSlots] = useState<TimeSlot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);

  const dates = getNext30Days(business.operating_hours);

  // Fetch slots when date changes
  const fetchSlots = useCallback(async () => {
    if (!selectedService || !selectedDate) return;
    setLoadingSlots(true);
    setSlots([]);
    setSelectedTime('');

    try {
      const params = new URLSearchParams({
        businessId: business.id,
        serviceId: selectedService.id,
        date: selectedDate,
      });
      const res = await fetch(`/api/bookings/public/slots?${params}`);
      const data = await res.json();
      setSlots(data.slots || []);
    } catch {
      setSlots([]);
    } finally {
      setLoadingSlots(false);
    }
  }, [business.id, selectedService, selectedDate]);

  useEffect(() => {
    if (step === 3 && selectedDate && selectedService) {
      fetchSlots();
    }
  }, [step, selectedDate, selectedService, fetchSlots]);

  function goBack() {
    setError('');
    if (step > 1) setStep(step - 1);
  }

  function selectService(svc: ServiceInfo) {
    setSelectedService(svc);
    setSelectedDate('');
    setSelectedTime('');
    setStep(2);
  }

  function selectDate(dateStr: string) {
    setSelectedDate(dateStr);
    setSelectedTime('');
    // For drop-off services, skip time selection
    if (selectedService?.is_dropoff) {
      setSelectedTime('00:00');
      setStep(4);
    } else {
      setStep(3);
    }
  }

  function selectTime(time: string) {
    setSelectedTime(time);
    setStep(4);
  }

  async function sendOtp() {
    if (!guestEmail.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail)) {
      setOtpError('Enter a valid email first');
      return;
    }
    setOtpLoading(true); setOtpError('');
    try {
      const res = await fetch('/api/auth/email-otp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: guestEmail.trim() }),
      });
      if (!res.ok) { const d = await res.json(); setOtpError(d.error || 'Failed to send code'); }
      else { setOtpSent(true); }
    } catch { setOtpError('Network error'); }
    setOtpLoading(false);
  }

  async function verifyOtp() {
    if (!otpCode || otpCode.length !== 4) { setOtpError('Enter the 4-digit code'); return; }
    setOtpLoading(true); setOtpError('');
    try {
      const res = await fetch('/api/auth/email-otp?action=verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: guestEmail.trim(), code: otpCode }),
      });
      const d = await res.json();
      if (d.verified) { setEmailVerified(true); setOtpToken(d.otpToken || ''); setOtpSent(false); }
      else { setOtpError(d.error || 'Invalid code'); }
    } catch { setOtpError('Network error'); }
    setOtpLoading(false);
  }

  function goToConfirm() {
    if (!guestName.trim() || !guestEmail.trim()) {
      setError('Please fill in your name and email.');
      return;
    }
    if (!emailVerified) {
      setError('Please verify your email first.');
      return;
    }
    setError('');
    setStep(5);
  }

  async function handleBooking() {
    if (!selectedService || !selectedDate || !selectedTime) return;
    setSubmitting(true);
    setError('');

    try {
      const res = await fetch('/api/bookings/public/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessSlug: business.slug,
          serviceId: selectedService.id,
          date: selectedDate,
          time: selectedTime,
          guestName: guestName.trim(),
          guestEmail: guestEmail.trim().toLowerCase(),
          guestPhone: guestPhone || undefined,
          otpToken,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Something went wrong. Please try again.');
        setSubmitting(false);
        return;
      }

      if (data.paymentUrl) {
        window.location.href = data.paymentUrl;
        return;
      }

      setReferenceCode(data.referenceCode || '');
      setSuccess(true);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const cc = business.country_code || 'NG';

  // ── Success State ──
  if (success) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-sm">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
            <svg className="h-8 w-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="mt-4 text-xl font-bold text-gray-900">Booking Confirmed!</h2>
          <p className="mt-2 text-sm text-gray-500">
            Your booking with {business.name} has been confirmed.
          </p>
          {referenceCode && (
            <p className="mt-3 rounded-lg bg-gray-50 px-4 py-2 text-sm font-mono text-gray-700">
              Reference: {referenceCode}
            </p>
          )}
          <p className="mt-4 text-xs text-gray-400">
            A confirmation has been sent to {guestEmail}.
          </p>
          <div className="mt-6">
            <button
              onClick={() => window.location.reload()}
              className="text-sm font-medium text-brand hover:text-brand-700"
            >
              Book another service
            </button>
          </div>
          <PoweredByWaaiio />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-8">
      {/* Header */}
      <div className="bg-white border-b border-gray-100 px-4 py-5">
        <div className="mx-auto max-w-lg flex items-center gap-3">
          {business.logo_url ? (
            <img
              src={business.logo_url}
              alt={business.name}
              className="h-12 w-12 rounded-xl object-cover"
            />
          ) : (
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand text-lg font-bold text-white">
              {business.name.charAt(0)}
            </div>
          )}
          <div>
            <h1 className="text-lg font-bold text-gray-900">{business.name}</h1>
            {business.address && (
              <p className="text-xs text-gray-500">{business.address}</p>
            )}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-lg px-4 pt-6">
        <StepIndicator currentStep={step} />

        <div aria-live="polite" role="alert">
          {error && (
            <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>

        {/* Step 1: Service Selection */}
        {step === 1 && (
          <div>
            <h2 className="mb-4 text-lg font-semibold text-gray-900">Choose a service</h2>
            {services.length === 0 ? (
              <p className="text-sm text-gray-500">No services available at this time.</p>
            ) : (
              <div className="space-y-3">
                {services.map((svc) => (
                  <button
                    key={svc.id}
                    onClick={() => selectService(svc)}
                    className="w-full text-left rounded-xl bg-white p-4 shadow-sm border border-gray-100 hover:border-brand-300 hover:shadow-md transition"
                  >
                    <div className="flex gap-3">
                      {svc.image_url && (
                        <img
                          src={svc.image_url}
                          alt={svc.name}
                          className="h-16 w-16 rounded-lg object-cover flex-shrink-0"
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="font-semibold text-gray-900 truncate">{svc.name}</h3>
                          <span className="text-sm font-semibold text-brand whitespace-nowrap">
                            {svc.price > 0 ? formatPrice(svc.price, cc) : 'Free'}
                          </span>
                        </div>
                        {svc.description && (
                          <p className="mt-0.5 text-xs text-gray-500 line-clamp-2">
                            {svc.description}
                          </p>
                        )}
                        <div className="mt-1.5 flex items-center gap-3 text-xs text-gray-400">
                          {svc.duration_minutes > 0 && (
                            <span className="flex items-center gap-1">
                              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                              {formatDuration(svc.duration_minutes)}
                            </span>
                          )}
                          {svc.deposit_amount && svc.deposit_amount < svc.price && (
                            <span>Deposit: {formatPrice(svc.deposit_amount, cc)}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Step 2: Date Selection */}
        {step === 2 && selectedService && (
          <div>
            <BackButton onClick={goBack} />
            <h2 className="mb-1 text-lg font-semibold text-gray-900">Pick a date</h2>
            <p className="mb-4 text-sm text-gray-500">
              {selectedService.name} &middot; {formatDuration(selectedService.duration_minutes)}
            </p>
            <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1 scrollbar-hide">
              {dates.map((d) => {
                const isToday = d.date === new Date().toISOString().split('T')[0];
                return (
                  <button
                    key={d.date}
                    disabled={d.closed}
                    onClick={() => selectDate(d.date)}
                    className={`flex-shrink-0 flex flex-col items-center rounded-xl px-3 py-3 text-center transition min-w-[72px] ${
                      d.closed
                        ? 'bg-gray-50 text-gray-300 cursor-not-allowed'
                        : selectedDate === d.date
                          ? 'bg-brand text-white shadow-md'
                          : isToday
                            ? 'bg-brand-50 text-brand-700 border-2 border-brand-200 hover:border-brand-400'
                            : 'bg-white text-gray-700 border border-gray-100 hover:border-brand-300'
                    }`}
                  >
                    <span className="text-[10px] font-medium uppercase">
                      {d.label.split(' ')[0]}
                    </span>
                    <span className="text-lg font-bold leading-tight">
                      {d.label.split(' ')[1]}
                    </span>
                    <span className="text-[10px]">
                      {d.label.split(' ')[2]}
                    </span>
                    {d.closed && <span className="text-[9px] mt-0.5">Closed</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Step 3: Time Selection */}
        {step === 3 && selectedService && selectedDate && (
          <div>
            <BackButton onClick={goBack} />
            <h2 className="mb-1 text-lg font-semibold text-gray-900">Choose a time</h2>
            <p className="mb-4 text-sm text-gray-500">
              {selectedService.name} &middot;{' '}
              {new Date(selectedDate + 'T00:00').toLocaleDateString('en-US', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              })}
            </p>

            {loadingSlots ? (
              <div className="flex items-center justify-center py-12">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
              </div>
            ) : slots.length === 0 ? (
              <div className="rounded-xl bg-white p-6 text-center shadow-sm">
                <p className="text-sm text-gray-500">No available slots for this date.</p>
                <button
                  onClick={goBack}
                  className="mt-3 text-sm font-medium text-brand hover:text-brand-700"
                >
                  Pick a different date
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {slots.map((slot) => (
                  <button
                    key={slot.time}
                    onClick={() => selectTime(slot.time)}
                    className={`rounded-lg py-3 text-sm font-medium transition ${
                      selectedTime === slot.time
                        ? 'bg-brand text-white shadow-md'
                        : 'bg-white text-gray-700 border border-gray-100 hover:border-brand-300'
                    }`}
                  >
                    {slot.time}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Step 4: Guest Details */}
        {step === 4 && (
          <div>
            <BackButton onClick={goBack} />
            <h2 className="mb-4 text-lg font-semibold text-gray-900">Your details</h2>
            <div className="space-y-4 rounded-xl bg-white p-5 shadow-sm">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Full Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
                  placeholder="John Doe"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
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
                    <button type="button" onClick={() => { setEmailVerified(false); setOtpSent(false); setOtpCode(''); }} className="ml-auto text-xs text-gray-400 hover:text-gray-600">Change</button>
                  </div>
                ) : otpSent ? (
                  <div>
                    <p className="mb-2 text-xs text-gray-500">Code sent to {guestEmail}</p>
                    <div className="flex gap-2">
                      <input type="text" inputMode="numeric" maxLength={4} value={otpCode} onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="4-digit code" className="flex-1 rounded-lg border border-gray-200 px-3 py-2.5 text-center text-lg font-bold tracking-[0.3em] outline-none focus:border-brand" />
                      <button type="button" onClick={verifyOtp} disabled={otpLoading || otpCode.length !== 4} className="rounded-lg bg-brand px-4 py-2.5 text-sm font-bold text-white hover:bg-brand-600 disabled:opacity-50">{otpLoading ? '...' : 'Verify'}</button>
                    </div>
                    <button type="button" onClick={sendOtp} disabled={otpLoading} className="mt-1 text-xs text-brand hover:underline">Resend code</button>
                    {otpError && <p className="mt-1 text-xs text-red-500">{otpError}</p>}
                  </div>
                ) : (
                  <div>
                    <p className="text-xs text-gray-500 mb-1">We&apos;ll send a code to verify your email — your booking confirmation will be sent here.</p>
                    <div className="flex gap-2">
                      <input type="email" value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} placeholder="john@example.com" className="flex-1 rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand" />
                      <button type="button" onClick={sendOtp} disabled={otpLoading || !guestEmail.trim()} className="rounded-lg bg-brand px-4 py-2.5 text-sm font-bold text-white hover:bg-brand-600 disabled:opacity-50">{otpLoading ? '...' : 'Verify'}</button>
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
                  countryCode={(cc as CountryCode) || 'US'}
                />
              </div>
              <button
                onClick={goToConfirm}
                className="w-full rounded-lg bg-brand py-3 text-sm font-semibold text-white hover:bg-brand-600 transition"
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {/* Step 5: Confirmation */}
        {step === 5 && selectedService && (
          <div>
            <BackButton onClick={goBack} />
            <h2 className="mb-4 text-lg font-semibold text-gray-900">Confirm your booking</h2>
            <div className="rounded-xl bg-white p-5 shadow-sm space-y-4">
              {/* Summary */}
              <div className="space-y-3">
                <SummaryRow label="Service" value={selectedService.name} />
                <SummaryRow
                  label="Date"
                  value={new Date(selectedDate + 'T00:00').toLocaleDateString('en-US', {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}
                />
                {!selectedService.is_dropoff && (
                  <SummaryRow label="Time" value={selectedTime} />
                )}
                <SummaryRow label="Duration" value={formatDuration(selectedService.duration_minutes)} />
                <SummaryRow label="Guest" value={guestName} />

                <div className="border-t border-gray-100 pt-3">
                  <SummaryRow
                    label="Total"
                    value={selectedService.price > 0 ? formatPrice(selectedService.price, cc) : 'Free'}
                    bold
                  />
                  {selectedService.deposit_amount && selectedService.deposit_amount > 0 && selectedService.deposit_amount < selectedService.price && (
                    <p className="mt-1 text-xs text-gray-500">
                      Deposit due now: {formatPrice(selectedService.deposit_amount, cc)}
                    </p>
                  )}
                </div>
              </div>

              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={agreedToTerms}
                  onChange={(e) => setAgreedToTerms(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                />
                <span className="text-xs text-gray-500">
                  I agree to {business.name}&apos;s and <a href="/terms" target="_blank" className="text-brand underline">Waaiio&apos;s terms</a> and policies
                </span>
              </label>

              <button
                onClick={handleBooking}
                disabled={submitting || !agreedToTerms}
                className="w-full rounded-lg bg-brand py-3 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50 transition"
              >
                {submitting
                  ? 'Processing...'
                  : selectedService.price > 0
                    ? `Pay ${formatPrice(selectedService.deposit_amount || selectedService.price, cc)}`
                    : 'Book Now'}
              </button>
            </div>
          </div>
        )}

        <PoweredByWaaiio />
      </div>
    </div>
  );
}

// ── Sub-components ──

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="mb-4 flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 transition"
    >
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
      </svg>
      Back
    </button>
  );
}

function SummaryRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-gray-500">{label}</span>
      <span className={`text-sm ${bold ? 'font-bold text-gray-900' : 'font-medium text-gray-900'}`}>
        {value}
      </span>
    </div>
  );
}

function PoweredByWaaiio() {
  return (
    <p className="mt-8 text-center text-xs text-gray-300">
      Powered by{' '}
      <a
        href="https://waaiio.com"
        target="_blank"
        rel="noopener noreferrer"
        className="text-gray-400 hover:text-brand transition"
      >
        Waaiio
      </a>
    </p>
  );
}

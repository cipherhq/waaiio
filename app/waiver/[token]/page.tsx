'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';

interface WaiverInfo {
  id: string;
  title: string;
  body: string;
  fields: string[];
  business_name: string;
  logo_url: string | null;
}

type PageState = 'loading' | 'ready' | 'submitting' | 'success' | 'error';

export default function WaiverSignPage() {
  const params = useParams();
  const token = params.token as string;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [waiver, setWaiver] = useState<WaiverInfo | null>(null);
  const [state, setState] = useState<PageState>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  // Drawing state
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasDrawn, setHasDrawn] = useState(false);

  // Form state
  const [agreed, setAgreed] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [sendVia, setSendVia] = useState<'email' | 'whatsapp' | 'both'>('email');
  const [emergencyContactName, setEmergencyContactName] = useState('');
  const [emergencyContactPhone, setEmergencyContactPhone] = useState('');
  const [medicalConditions, setMedicalConditions] = useState('');
  const [allergies, setAllergies] = useState('');

  // Fetch waiver details
  useEffect(() => {
    async function fetchWaiver() {
      try {
        const res = await fetch(`/api/waivers/${token}`);
        if (!res.ok) {
          const data = await res.json();
          setErrorMsg(data.error || 'Unable to load waiver');
          setState('error');
          return;
        }
        const data = await res.json();
        setWaiver(data);
        setState('ready');
      } catch {
        setErrorMsg('Unable to load waiver. Please check your link.');
        setState('error');
      }
    }
    if (token) fetchWaiver();
  }, [token]);

  // Initialize signature canvas
  const initCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * 2;
    canvas.height = rect.height * 2;
    ctx.scale(2, 2);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, []);

  useEffect(() => {
    if (state === 'ready') {
      // Small delay to ensure canvas is rendered
      const timer = setTimeout(initCanvas, 100);
      return () => clearTimeout(timer);
    }
  }, [state, initCanvas]);

  function getPoint(e: React.TouchEvent | React.MouseEvent) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    if ('touches' in e) {
      const touch = e.touches[0];
      return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
    }
    return { x: (e as React.MouseEvent).clientX - rect.left, y: (e as React.MouseEvent).clientY - rect.top };
  }

  function startDraw(e: React.TouchEvent | React.MouseEvent) {
    e.preventDefault();
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    setIsDrawing(true);
    setHasDrawn(true);
    const point = getPoint(e);
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
  }

  function draw(e: React.TouchEvent | React.MouseEvent) {
    e.preventDefault();
    if (!isDrawing) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const point = getPoint(e);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
  }

  function endDraw(e: React.TouchEvent | React.MouseEvent) {
    e.preventDefault();
    setIsDrawing(false);
  }

  function clearCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasDrawn(false);
  }

  async function handleSubmit() {
    const canvas = canvasRef.current;
    if (!canvas || !waiver) return;

    setState('submitting');
    const signatureData = canvas.toDataURL('image/png');

    // Build metadata from optional fields
    const metadata: Record<string, string> = {};
    if (emergencyContactName || emergencyContactPhone) {
      metadata.emergency_contact_name = emergencyContactName;
      metadata.emergency_contact_phone = emergencyContactPhone;
    }
    if (medicalConditions) metadata.medical_conditions = medicalConditions;
    if (allergies) metadata.allergies = allergies;

    try {
      const fullName = `${firstName.trim()} ${lastName.trim()}`.trim();
      const res = await fetch('/api/waivers/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          customer_name: fullName,
          customer_phone: customerPhone || undefined,
          customer_email: customerEmail || undefined,
          send_via: sendVia,
          signature: signatureData,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setErrorMsg(data.error || 'Failed to submit waiver');
        setState('error');
        return;
      }

      setState('success');
    } catch {
      setErrorMsg('Failed to submit. Please try again.');
      setState('ready');
    }
  }

  const hasFields = (field: string) => waiver?.fields?.includes(field);
  const needsEmail = sendVia === 'email' || sendVia === 'both';
  const needsPhone = sendVia === 'whatsapp' || sendVia === 'both';
  const canSubmit = firstName.trim() && lastName.trim() && hasDrawn && agreed
    && (!needsEmail || customerEmail.trim())
    && (!needsPhone || customerPhone.trim());

  if (state === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-gray-200 border-t-blue-600" />
          <p className="mt-4 text-gray-500">Loading waiver...</p>
        </div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
            <svg className="h-8 w-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-900">Unable to Load Waiver</h1>
          <p className="mt-2 text-gray-600">{errorMsg}</p>
        </div>
      </div>
    );
  }

  if (state === 'success') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
            <svg className="h-8 w-8 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-900">Waiver Signed!</h1>
          <p className="mt-2 text-gray-600">
            Your waiver for &quot;{waiver?.title}&quot; has been signed successfully.
          </p>
          <p className="mt-2 text-sm text-gray-500">
            {customerPhone || customerEmail
              ? 'A confirmation has been sent to you.'
              : 'Thank you for signing.'}
          </p>
          <p className="mt-6 text-xs text-gray-400">Powered by Waaiio</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      {/* Header */}
      <header className="border-b bg-white px-4 py-4 shadow-sm">
        <div className="mx-auto max-w-lg">
          <div className="flex items-center gap-3">
            {waiver?.logo_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={waiver.logo_url}
                alt={waiver.business_name}
                className="h-10 w-10 rounded-lg object-contain"
              />
            )}
            <p className="text-xs font-medium uppercase tracking-wider text-gray-400">
              {waiver?.business_name}
            </p>
          </div>
          <h1 className="mt-1 text-lg font-bold text-gray-900">{waiver?.title}</h1>
        </div>
      </header>

      {/* Main content */}
      <main className="flex flex-1 flex-col items-center px-4 py-6">
        <div className="w-full max-w-lg space-y-6 pb-24 md:pb-6">

          {/* Waiver body text */}
          <div>
            <h2 className="mb-2 text-sm font-semibold text-gray-700">Waiver / Release</h2>
            <div className="max-h-64 overflow-y-auto rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-gray-700">
                {waiver?.body}
              </pre>
            </div>
          </div>

          {/* Agreement checkbox */}
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={agreed}
              onChange={e => setAgreed(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-600">
              I have read and agree to the above waiver and release
            </span>
          </label>

          {/* Form fields */}
          <div className="space-y-4">
            {/* Name — first and last, always required */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  First Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={firstName}
                  onChange={e => setFirstName(e.target.value)}
                  placeholder="First name"
                  maxLength={100}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Last Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={lastName}
                  onChange={e => setLastName(e.target.value)}
                  placeholder="Last name"
                  maxLength={100}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>

            {/* How to receive signed copy */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Send my signed copy via
              </label>
              <div className="flex gap-2">
                {(['email', 'whatsapp', 'both'] as const).map(opt => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setSendVia(opt)}
                    className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition ${
                      sendVia === opt
                        ? 'border-blue-500 bg-blue-50 text-blue-700'
                        : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {opt === 'email' ? '📧 Email' : opt === 'whatsapp' ? '💬 WhatsApp' : '📧 + 💬 Both'}
                  </button>
                ))}
              </div>
            </div>

            {/* Email — required if send via email or both */}
            {(sendVia === 'email' || sendVia === 'both') && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Email <span className="text-red-500">*</span>
                </label>
                <input
                  type="email"
                  value={customerEmail}
                  onChange={e => setCustomerEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            )}

            {/* Phone — required if send via whatsapp or both */}
            {(sendVia === 'whatsapp' || sendVia === 'both') && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  WhatsApp Number <span className="text-red-500">*</span>
                </label>
                <input
                  type="tel"
                  value={customerPhone}
                  onChange={e => setCustomerPhone(e.target.value)}
                  placeholder="+1 (555) 000-0000"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            )}

            {/* Emergency Contact */}
            {hasFields('emergency_contact') && (
              <div className="space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-4">
                <p className="text-sm font-medium text-gray-700">Emergency Contact</p>
                <input
                  type="text"
                  value={emergencyContactName}
                  onChange={e => setEmergencyContactName(e.target.value)}
                  placeholder="Contact name"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <input
                  type="tel"
                  value={emergencyContactPhone}
                  onChange={e => setEmergencyContactPhone(e.target.value)}
                  placeholder="Contact phone number"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            )}

            {/* Medical Conditions */}
            {hasFields('medical_conditions') && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Medical Conditions
                </label>
                <textarea
                  value={medicalConditions}
                  onChange={e => setMedicalConditions(e.target.value)}
                  placeholder="List any relevant medical conditions or write 'None'"
                  rows={3}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            )}

            {/* Allergies */}
            {hasFields('allergies') && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Allergies
                </label>
                <textarea
                  value={allergies}
                  onChange={e => setAllergies(e.target.value)}
                  placeholder="List any allergies or write 'None'"
                  rows={3}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            )}
          </div>

          {/* Signature area */}
          <div>
            <p className="mb-3 text-center text-sm text-gray-500">
              Draw your signature below using your finger or mouse
            </p>

            <div className="overflow-hidden rounded-xl border-2 border-dashed border-gray-300 bg-white">
              <canvas
                ref={canvasRef}
                className="h-48 w-full cursor-crosshair"
                style={{ touchAction: 'none' }}
                onMouseDown={startDraw}
                onMouseMove={draw}
                onMouseUp={endDraw}
                onMouseLeave={endDraw}
                onTouchStart={startDraw}
                onTouchMove={draw}
                onTouchEnd={endDraw}
              />
            </div>

            {hasDrawn && (
              <button
                onClick={clearCanvas}
                className="mt-2 text-sm font-medium text-blue-600 hover:text-blue-700"
              >
                Clear signature
              </button>
            )}

            {!hasDrawn && (
              <p className="mt-2 text-center text-xs text-gray-400">
                Tap and drag to sign
              </p>
            )}
          </div>

          {/* Legal disclaimer */}
          <div className="rounded-lg bg-gray-100 p-4">
            <p className="text-xs leading-relaxed text-gray-500">
              By signing, you agree that this electronic signature is as valid as a handwritten signature.
              Your signature, IP address, and device information are recorded for verification purposes.
              See our{' '}
              <a href="/privacy" className="font-medium text-blue-600 hover:underline">Privacy Policy</a>.
            </p>
          </div>
        </div>
      </main>

      {/* Sticky footer button on mobile */}
      <div className="fixed bottom-0 left-0 right-0 z-10 border-t border-gray-200 bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:relative md:border-0 md:px-4 md:py-6">
        <div className="mx-auto max-w-lg">
          <button
            onClick={handleSubmit}
            disabled={!canSubmit || state === 'submitting'}
            className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
          >
            {state === 'submitting' ? 'Submitting...' : 'Sign Waiver'}
          </button>
        </div>
      </div>

      <p className="pb-20 md:pb-4 text-center text-xs text-gray-400">Powered by Waaiio</p>
    </div>
  );
}

'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { CapabilityId } from '@/lib/capabilities/types';
import type { StepSuccessProps } from './types';

export function StepSuccess({
  loading,
  successData,
  waMethod,
  waLink,
  selectedCapabilities,
  error,
  setStep,
  setError,
  fbConnectionData,
}: StepSuccessProps) {
  const [qrLoaded, setQrLoaded] = useState(false);
  const qrRef = useRef<{ SVG: React.ComponentType<any>; Canvas: React.ComponentType<any> } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    import('qrcode.react').then(mod => {
      qrRef.current = { SVG: mod.QRCodeSVG, Canvas: mod.QRCodeCanvas };
      setQrLoaded(true);
    }).catch(() => {});
  }, []);

  function handleCopyLink() {
    navigator.clipboard.writeText(waLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function downloadQR() {
    const canvas = document.querySelector('#qr-download-canvas canvas') as HTMLCanvasElement;
    if (!canvas) return;
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = 'waaiio-qr-code.png';
    a.click();
  }

  // Determine the right verb based on capabilities
  const actionVerb = selectedCapabilities.includes('scheduling')
    ? 'book with you'
    : selectedCapabilities.includes('ordering')
    ? 'order from you'
    : selectedCapabilities.includes('ticketing')
    ? 'buy tickets'
    : 'pay you';

  return (
    <div className="text-center">
      {loading ? (
        <div className="py-16">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-brand border-t-transparent" />
          <p className="mt-4 text-sm text-gray-500">Verifying payment...</p>
        </div>
      ) : successData ? (
        <>
          {/* Hero section */}
          <div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 px-3 py-1 text-xs font-bold text-green-700">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
              You&apos;re live!
            </span>
            <h2 className="mt-4 text-2xl font-bold text-gray-900">Print this. Stick it anywhere.</h2>
            <p className="mt-2 text-sm text-gray-500">
              Anyone who scans this QR code can {actionVerb} on WhatsApp instantly. No app download needed.
            </p>
          </div>

          {/* Dedicated number notice */}
          {waMethod !== 'shared' && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-left">
              <p className="text-xs font-semibold text-amber-800">WhatsApp Number Connection</p>
              <p className="mt-1 text-xs text-amber-700">
                Our team is setting up your dedicated WhatsApp number. You&apos;ll receive an email when it&apos;s ready (usually within 24 hours). For now, you can test using our shared number below.
              </p>
            </div>
          )}

          {/* QR Code hero card */}
          <div className="mt-6 rounded-2xl bg-white border border-gray-200 p-8 shadow-lg">
            {qrLoaded && qrRef.current ? (
              <>
                <div className="flex justify-center">
                  {React.createElement(qrRef.current.SVG, {
                    value: waLink,
                    size: 220,
                    level: 'M',
                  })}
                </div>
                {/* Hidden canvas for download */}
                <div id="qr-download-canvas" className="hidden">
                  {React.createElement(qrRef.current.Canvas, {
                    value: waLink,
                    size: 512,
                    level: 'M',
                  })}
                </div>
              </>
            ) : (
              <div className="mx-auto flex h-[220px] w-[220px] items-center justify-center rounded-xl bg-gray-100 text-xs text-gray-400">
                Loading QR Code...
              </div>
            )}
            <p className="mt-4 break-all text-xs font-mono text-gray-400">{waLink}</p>
            <div className="mt-4 flex gap-2 justify-center">
              <button
                type="button"
                onClick={handleCopyLink}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                {copied ? 'Copied!' : 'Copy Link'}
              </button>
              <button
                type="button"
                onClick={downloadQR}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2.5 text-sm font-bold text-white hover:bg-brand-600 transition"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Download QR Code
              </button>
            </div>
          </div>

          {/* Where to put it suggestions */}
          <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { emoji: '\uD83C\uDFEA', label: 'Counter / Checkout' },
              { emoji: '\uD83C\uDFEC', label: 'Window / Door' },
              { emoji: '\uD83D\uDCC4', label: 'Flyers & Posters' },
              { emoji: '\uD83D\uDCF1', label: 'Social Media' },
            ].map(item => (
              <div
                key={item.label}
                className="flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-left"
              >
                <span className="text-lg">{item.emoji}</span>
                <span className="text-xs font-medium text-gray-700">{item.label}</span>
              </div>
            ))}
          </div>

          {/* Test on WhatsApp */}
          <div className="mt-6">
            <a
              href={waLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-xl border-2 border-whatsapp px-5 py-2.5 text-sm font-bold text-whatsapp hover:bg-green-50 transition"
            >
              <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
              Test on WhatsApp
            </a>
          </div>

          {/* ── What to set up next ── */}
          <div className="mt-8 text-left">
            <h3 className="text-lg font-bold text-gray-900">Set up your bot</h3>
            <p className="mt-1 text-xs text-gray-500">Your bot is live but needs content. Add your services, products, or events so customers can interact with it.</p>

            <div className="mt-4 space-y-2">
              {([
                { cap: 'appointment' as CapabilityId, icon: '\uD83D\uDCC5', title: 'Add your appointments', desc: 'Add the services customers can book — name, price, duration, staff.', href: '/dashboard/appointments-management', cta: 'Add appointments' },
                { cap: 'scheduling' as CapabilityId, icon: '\uD83D\uDED1\uFE0F', title: 'Add your services', desc: 'List the services you offer with prices.', href: '/dashboard/services', cta: 'Add services' },
                { cap: 'ordering' as CapabilityId, icon: '\uD83D\uDED2', title: 'Add your products', desc: 'Build your menu or catalog — name, price, photo, description.', href: '/dashboard/products', cta: 'Add products' },
                { cap: 'reservation' as CapabilityId, icon: '\uD83C\uDFE0', title: 'Add your properties', desc: 'Add rooms, apartments, or vehicles with photos and pricing.', href: '/dashboard/properties', cta: 'Add properties' },
                { cap: 'ticketing' as CapabilityId, icon: '\uD83C\uDFAB', title: 'Create your first event', desc: 'Add an event with ticket types, pricing, and venue details.', href: '/dashboard/events', cta: 'Create event' },
                { cap: 'giving' as CapabilityId, icon: '\uD83D\uDE4F', title: 'Set up giving categories', desc: 'Add tithe, offering, or donation categories for your community.', href: '/dashboard/giving', cta: 'Set up giving' },
                { cap: 'payment' as CapabilityId, icon: '\uD83D\uDCB3', title: 'Set up payment categories', desc: 'Add fee types or payment categories customers can pay for.', href: '/dashboard/services', cta: 'Add categories' },
                { cap: 'invoice' as CapabilityId, icon: '\uD83E\uDDFE', title: 'Create your first invoice', desc: 'Send a professional invoice with payment link.', href: '/dashboard/invoices', cta: 'Create invoice' },
              ] as const)
                .filter(item => selectedCapabilities.includes(item.cap))
                .map(item => (
                  <a
                    key={item.cap}
                    href={item.href}
                    className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 transition hover:border-brand hover:bg-brand-50/30"
                  >
                    <span className="text-2xl">{item.icon}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-900">{item.title}</p>
                      <p className="text-xs text-gray-500">{item.desc}</p>
                    </div>
                    <span className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-xs font-bold text-white">{item.cta}</span>
                  </a>
                ))}

              {/* Always show payout setup */}
              <a
                href="/dashboard/payouts"
                className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 transition hover:border-amber-300"
              >
                <span className="text-2xl">{'\uD83C\uDFE6'}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-amber-800">Connect your payout account</p>
                  <p className="text-xs text-amber-700">Add your bank details so you can receive customer payments.</p>
                </div>
                <span className="shrink-0 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-bold text-white">Set up</span>
              </a>
            </div>
          </div>

          <div className="mt-8 border-t border-gray-200 pt-6">
            <a href="/dashboard" className="inline-block rounded-xl bg-brand px-8 py-3.5 text-sm font-bold text-white transition hover:bg-brand-600">Go to Dashboard</a>
            <p className="mt-2 text-xs text-gray-400">You can always set these up later from your dashboard</p>
          </div>
        </>
      ) : (
        <div className="py-16">
          <p className="text-sm text-gray-500">{error || 'Something went wrong. Please contact support.'}</p>
          <button type="button" onClick={() => { setStep('details'); setError(''); }} className="mt-4 text-sm font-semibold text-brand hover:underline">Try again</button>
        </div>
      )}
    </div>
  );
}

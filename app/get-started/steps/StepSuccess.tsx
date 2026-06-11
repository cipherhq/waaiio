'use client';

import React from 'react';
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
  return (
    <div className="text-center">
      {loading ? (
        <div className="py-16">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-brand border-t-transparent" />
          <p className="mt-4 text-sm text-gray-500">Verifying payment...</p>
        </div>
      ) : successData ? (
        <>
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-green-100">
            <svg className="h-10 w-10 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="mt-6 text-2xl font-bold text-gray-900">Your automation is live!</h2>
          <p className="mt-2 text-sm text-gray-500">
            {waMethod === 'shared'
              ? 'Share this link with customers to start taking '
              : 'Your WhatsApp number is being connected. In the meantime, share this test link: '}
            {selectedCapabilities.includes('scheduling') ? 'bookings' : selectedCapabilities.includes('ordering') ? 'orders' : selectedCapabilities.includes('ticketing') ? 'tickets' : 'payments'}
          </p>

          {waMethod !== 'shared' && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-left">
              <p className="text-xs font-semibold text-amber-800">WhatsApp Number Connection</p>
              <p className="mt-1 text-xs text-amber-700">
                Our team is setting up your dedicated WhatsApp number. You&apos;ll receive an email when it&apos;s ready (usually within 24 hours). For now, you can test using our shared number below.
              </p>
            </div>
          )}

          {/* WhatsApp link + QR */}
          <div className="mt-6 rounded-2xl bg-green-50 border border-green-200 p-5">
            <p className="text-xs font-bold uppercase tracking-wider text-green-700">Your WhatsApp Link</p>
            <p className="mt-2 break-all text-sm font-mono text-green-900">{waLink}</p>
            <div className="mt-4 flex gap-2 justify-center">
              <button type="button" onClick={() => navigator.clipboard.writeText(waLink)} className="rounded-lg border border-green-300 px-4 py-2 text-xs font-medium text-green-700 hover:bg-green-100">Copy Link</button>
              <a href={waLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-whatsapp px-4 py-2 text-xs font-bold text-white">
                <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                Test on WhatsApp
              </a>
            </div>
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

'use client';

import React from 'react';
import { formatCurrency } from '@/lib/constants';
import { CAPABILITY_TIER_REQUIREMENTS } from '@/lib/capabilities/types';
import { getAnnualDiscountSync } from '@/lib/platformSettings';
import type { StepPlanProps } from './types';

export function StepPlan({
  selectedPlan,
  setSelectedPlan,
  selectedCapabilities,
  setSelectedCapabilities,
  selectedCountry,
  requiredPlan,
  localTiers,
  billingInterval,
  setStep,
}: StepPlanProps) {
  return (
    <div>
      <button type="button" onClick={() => setStep('category')} className="mb-4 flex items-center gap-1 text-sm text-gray-500 hover:text-brand">
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
        Back
      </button>
      <h2 className="text-2xl font-bold text-gray-900">Choose your plan</h2>
      <p className="mt-1 text-sm text-gray-500">
        Select the plan that fits your business needs. Each tier unlocks more capabilities.
      </p>

      <div className="mt-6 space-y-4">
        {/* Free / Starter */}
        <button type="button" onClick={() => {
          setSelectedPlan('free');
          // Remove capabilities above free tier
          setSelectedCapabilities(prev => prev.filter(c => (CAPABILITY_TIER_REQUIREMENTS[c] || 'free') === 'free'));
        }} className={`relative w-full rounded-2xl border-2 p-5 text-left transition ${selectedPlan === 'free' ? 'border-brand bg-brand-50/30' : 'border-gray-200 hover:border-gray-300'}`}>
          {requiredPlan === 'free' && selectedCapabilities.length > 0 && (
            <span className="absolute -top-3 left-4 rounded-full bg-green-600 px-3 py-0.5 text-[10px] font-bold text-white">Based on your features</span>
          )}
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold text-gray-900">{String(localTiers?.free?.name || 'Starter')}</h3>
              <p className="text-2xl font-bold text-brand">{formatCurrency(0, selectedCountry)} <span className="text-sm font-normal text-gray-400">30-day trial</span></p>
            </div>
            <div className={`flex h-6 w-6 items-center justify-center rounded-full border-2 ${selectedPlan === 'free' ? 'border-brand bg-brand' : 'border-gray-300'}`}>
              {selectedPlan === 'free' && <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
            </div>
          </div>
          <p className="mt-2 text-sm text-gray-600">Try Waaiio risk-free. Accept bookings, collect payments, and chat with customers on WhatsApp.</p>
          <ul className="mt-3 space-y-1.5 text-xs text-gray-500">
            <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Auto-book appointments &amp; take orders</li>
            <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Collect payments via WhatsApp</li>
            <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Up to 50 bookings/month</li>
            <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> {String(localTiers?.free?.feePercentage ?? 2)}% per transaction — no monthly fee</li>
          </ul>
        </button>

        {/* Growth / Pro */}
        <button type="button" onClick={() => {
          setSelectedPlan('growth');
          // Remove capabilities above growth tier
          setSelectedCapabilities(prev => prev.filter(c => {
            const t = CAPABILITY_TIER_REQUIREMENTS[c] || 'free';
            return t === 'free' || t === 'growth';
          }));
        }} className={`relative w-full rounded-2xl border-2 p-5 text-left transition ${selectedPlan === 'growth' ? 'border-brand bg-brand-50/30' : 'border-gray-200 hover:border-gray-300'}`}>
          <span className="absolute -top-3 right-4 rounded-full bg-accent px-3 py-0.5 text-xs font-bold text-gray-900">Most Popular</span>
          {requiredPlan === 'growth' && (
            <span className="absolute -top-3 left-4 rounded-full bg-blue-600 px-3 py-0.5 text-[10px] font-bold text-white">Based on your features</span>
          )}
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold text-gray-900">{String(localTiers?.growth?.name || 'Pro')}</h3>
              {billingInterval === 'year' ? (
                <p className="text-2xl font-bold text-brand">{String(formatCurrency(Math.round((Number(localTiers?.growth?.price) || 0) * 12 * getAnnualDiscountSync().multiplier), selectedCountry))}<span className="text-sm font-normal text-gray-400">/year</span> <span className="text-xs font-medium text-green-600">Save {getAnnualDiscountSync().percentage}%</span></p>
              ) : (
                <p className="text-2xl font-bold text-brand">{String(formatCurrency(Number(localTiers?.growth?.price) || 0, selectedCountry))}<span className="text-sm font-normal text-gray-400">/mo</span></p>
              )}
            </div>
            <div className={`flex h-6 w-6 items-center justify-center rounded-full border-2 ${selectedPlan === 'growth' ? 'border-brand bg-brand' : 'border-gray-300'}`}>
              {selectedPlan === 'growth' && <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
            </div>
          </div>
          <p className="mt-2 text-sm text-gray-600">Grow faster with automated reminders, loyalty rewards, and your own WhatsApp number.</p>
          <ul className="mt-3 space-y-1.5 text-xs text-gray-500">
            <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Everything in Starter</li>
            <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Automated reminders — reduce no-shows by 60%</li>
            <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Loyalty points &amp; referral program — customers come back</li>
            <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Up to 500 bookings/month &middot; Lower {String(localTiers?.growth?.feePercentage ?? 1.5)}% fees{billingInterval === 'year' ? ' · Billed annually' : ''}</li>
            <li className="flex items-center gap-2"><span className="text-brand">&#9733;</span> <span className="font-medium text-gray-700">Connect your own WhatsApp number</span></li>
          </ul>
        </button>

        {/* Business / Premium */}
        <button type="button" onClick={() => setSelectedPlan('business')} className={`relative w-full rounded-2xl border-2 p-5 text-left transition ${selectedPlan === 'business' ? 'border-brand bg-brand-50/30' : 'border-gray-200 hover:border-gray-300'}`}>
          {requiredPlan === 'business' && (
            <span className="absolute -top-3 left-4 rounded-full bg-brand-600 px-3 py-0.5 text-[10px] font-bold text-white">Based on your features</span>
          )}
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold text-gray-900">{String(localTiers?.business?.name || 'Premium')}</h3>
              {billingInterval === 'year' ? (
                <p className="text-2xl font-bold text-brand">{String(formatCurrency(Math.round((Number(localTiers?.business?.price) || 0) * 12 * getAnnualDiscountSync().multiplier), selectedCountry))}<span className="text-sm font-normal text-gray-400">/year</span> <span className="text-xs font-medium text-green-600">Save {getAnnualDiscountSync().percentage}%</span></p>
              ) : (
                <p className="text-2xl font-bold text-brand">{String(formatCurrency(Number(localTiers?.business?.price) || 0, selectedCountry))}<span className="text-sm font-normal text-gray-400">/mo</span></p>
              )}
            </div>
            <div className={`flex h-6 w-6 items-center justify-center rounded-full border-2 ${selectedPlan === 'business' ? 'border-brand bg-brand' : 'border-gray-300'}`}>
              {selectedPlan === 'business' && <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
            </div>
          </div>
          <p className="mt-2 text-sm text-gray-600">Full platform with unlimited bookings, e-signatures, staff management, and your brand — not ours.</p>
          <ul className="mt-3 space-y-1.5 text-xs text-gray-500">
            <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Everything in Pro</li>
            <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Unlimited bookings &amp; conversations</li>
            <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> WhatsApp Sign — send documents for e-signature</li>
            <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Staff management, queue, waitlist, invoices</li>
            <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Whitelabel — your brand, not Waaiio</li>
            <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Lowest fees: {String(localTiers?.business?.feePercentage ?? 1)}% per transaction</li>
          </ul>
        </button>
      </div>

      <div className="mt-8">
        <button type="button" onClick={() => setStep('details')} disabled={!selectedPlan} className="w-full rounded-xl bg-brand py-3.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50">
          Continue
        </button>
      </div>
    </div>
  );
}

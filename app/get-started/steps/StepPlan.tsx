'use client';

import React from 'react';
import { formatCurrency } from '@/lib/constants';
import { CAPABILITY_TIER_REQUIREMENTS } from '@/lib/capabilities/types';
import type { StepPlanProps } from './types';

export function StepPlan({
  selectedPlan,
  setSelectedPlan,
  selectedCapabilities,
  setSelectedCapabilities,
  selectedCountry,
  requiredPlan,
  localTiers,
  setStep,
}: StepPlanProps) {
  const planOrder = ['free', 'growth', 'business'] as const;
  const eligibleCapabilities = selectedCapabilities.filter(capability =>
    planOrder.indexOf(CAPABILITY_TIER_REQUIREMENTS[capability] || 'free') <= planOrder.indexOf(selectedPlan));
  const omittedCount = selectedCapabilities.length - eligibleCapabilities.length;
  const feeLabel = (tier: typeof planOrder[number]) => {
    const pricing = localTiers[tier];
    return `${pricing.feePercentage}%${pricing.feeFlat > 0 ? ` + ${formatCurrency(pricing.feeFlat, selectedCountry)}` : ''} Waaiio fee per transaction`;
  };
  return (
    <div>
      <button type="button" onClick={() => setStep('features')} className="mb-4 flex items-center gap-1 text-sm text-gray-500 hover:text-brand">
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
        Back
      </button>
      <h2 className="text-2xl font-bold text-gray-900">Choose your plan</h2>
      <p className="mt-1 text-sm text-gray-500">
        Start free and upgrade later, or choose a paid plan now for lower transaction fees—even if you only need free features.
      </p>

      <div className="mt-6 space-y-4">
        {/* Free / Starter */}
        <button type="button" aria-pressed={selectedPlan === 'free'} onClick={() => setSelectedPlan('free')} className={`relative w-full rounded-2xl border-2 p-5 text-left transition ${selectedPlan === 'free' ? 'border-brand bg-brand-50/30' : 'border-gray-200 hover:border-gray-300'}`}>
          {requiredPlan === 'free' && selectedCapabilities.length > 0 && (
            <span className="absolute -top-3 left-4 rounded-full bg-green-600 px-3 py-0.5 text-[10px] font-bold text-white">Based on your features</span>
          )}
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold text-gray-900">{String(localTiers?.free?.name || 'Starter')}</h3>
              <p className="text-2xl font-bold text-brand">{formatCurrency(0, selectedCountry)} <span className="text-sm font-normal text-gray-400">free trial</span></p>
            </div>
            <div className={`flex h-6 w-6 items-center justify-center rounded-full border-2 ${selectedPlan === 'free' ? 'border-brand bg-brand' : 'border-gray-300'}`}>
              {selectedPlan === 'free' && <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
            </div>
          </div>
          <p className="mt-2 text-sm text-gray-600">Start with free features. Upgrade from your dashboard whenever you are ready.</p>
          <p className="mt-3 text-sm font-semibold text-gray-900">{feeLabel('free')} after trial — no monthly fee</p>
        </button>

        {/* Growth / Pro */}
        <button type="button" aria-pressed={selectedPlan === 'growth'} onClick={() => setSelectedPlan('growth')} className={`relative w-full rounded-2xl border-2 p-5 text-left transition ${selectedPlan === 'growth' ? 'border-brand bg-brand-50/30' : 'border-gray-200 hover:border-gray-300'}`}>
          {requiredPlan === 'growth' && (
            <span className="absolute -top-3 left-4 rounded-full bg-blue-600 px-3 py-0.5 text-[10px] font-bold text-white">Based on your features</span>
          )}
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold text-gray-900">{String(localTiers?.growth?.name || 'Pro')}</h3>
              <p className="text-2xl font-bold text-brand">{String(formatCurrency(Number(localTiers?.growth?.price), selectedCountry))}<span className="text-sm font-normal text-gray-400">/mo</span></p>
            </div>
            <div className={`flex h-6 w-6 items-center justify-center rounded-full border-2 ${selectedPlan === 'growth' ? 'border-brand bg-brand' : 'border-gray-300'}`}>
              {selectedPlan === 'growth' && <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
            </div>
          </div>
          <p className="mt-2 text-sm text-gray-600">Choose lower transaction fees with the features you need. You do not have to use the extras.</p>
          <p className="mt-3 text-sm font-semibold text-gray-900">{feeLabel('growth')}</p>
        </button>

        {/* Business / Premium */}
        <button type="button" aria-pressed={selectedPlan === 'business'} onClick={() => setSelectedPlan('business')} className={`relative w-full rounded-2xl border-2 p-5 text-left transition ${selectedPlan === 'business' ? 'border-brand bg-brand-50/30' : 'border-gray-200 hover:border-gray-300'}`}>
          {requiredPlan === 'business' && (
            <span className="absolute -top-3 left-4 rounded-full bg-brand-600 px-3 py-0.5 text-[10px] font-bold text-white">Based on your features</span>
          )}
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold text-gray-900">{String(localTiers?.business?.name || 'Premium')}</h3>
              <p className="text-2xl font-bold text-brand">{String(formatCurrency(Number(localTiers?.business?.price), selectedCountry))}<span className="text-sm font-normal text-gray-400">/mo</span></p>
            </div>
            <div className={`flex h-6 w-6 items-center justify-center rounded-full border-2 ${selectedPlan === 'business' ? 'border-brand bg-brand' : 'border-gray-300'}`}>
              {selectedPlan === 'business' && <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
            </div>
          </div>
          <p className="mt-2 text-sm text-gray-600">Choose our lowest plan transaction rate, even if free features cover your needs.</p>
          <p className="mt-3 text-sm font-semibold text-gray-900">{feeLabel('business')}</p>
        </button>
      </div>

      <p className="mt-4 text-sm text-gray-600">Payment-provider processing charges are separate. Selecting a paid plan does not charge you; you will confirm payment at checkout.</p>
      {omittedCount > 0 && <p role="status" className="mt-3 text-sm text-amber-800">{omittedCount} selected feature(s) require a higher plan and will not be included if you continue with this plan. Choose a higher plan to keep them.</p>}
      {eligibleCapabilities.length === 0 && <p role="status" className="mt-2 text-sm text-amber-800">Choose a higher plan or go back and select at least one feature included in this plan.</p>}
      <div className="mt-8">
        <button type="button" onClick={() => { setSelectedCapabilities(eligibleCapabilities); setStep('details'); }} disabled={eligibleCapabilities.length === 0} className={`w-full rounded-xl py-3.5 text-sm font-bold transition disabled:opacity-50 ${selectedPlan === 'free' ? 'bg-brand text-white hover:bg-brand-600' : 'bg-accent text-gray-900 shadow-lg shadow-accent/20 hover:bg-accent-400'}`}>
          {selectedPlan === 'free'
            ? 'Start free — upgrade later'
            : `Continue with ${formatCurrency(Number(localTiers?.[selectedPlan as 'growth' | 'business']?.price) || 0, selectedCountry)}/mo`}
        </button>
      </div>
    </div>
  );
}

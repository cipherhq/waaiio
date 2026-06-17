'use client';

import React from 'react';
import {
  BUSINESS_CATEGORIES,
  type BusinessCategoryKey,
} from '@/lib/constants';
import { getCategoryGroups } from '@/lib/categoryConfig';
import { CATEGORY_DEFAULT_CAPABILITIES } from '@/lib/capabilities/types';
import type { StepCategoryProps } from './types';

/* ─── Group icons for the 2-phase category picker ─── */
const CATEGORY_GROUP_ICONS: Record<string, string> = {
  'Beauty & Wellness': '\uD83D\uDC87',
  'Health & Medical': '\uD83C\uDFE5',
  'Food & Dining': '\uD83C\uDF7D\uFE0F',
  'Delivery & Retail': '\uD83D\uDECD\uFE0F',
  'Home & Auto Services': '\uD83D\uDD27',
  'Professional Services': '\uD83D\uDCBC',
  'Hospitality': '\uD83C\uDFE8',
  'Events & Entertainment': '\uD83C\uDFAA',
  'Faith & Community': '\u26EA',
  'Fitness': '\uD83C\uDFCB\uFE0F',
  'Transport & Logistics': '\uD83D\uDE9A',
  'Education & Training': '\uD83C\uDF93',
  'Pet Services': '\uD83D\uDC3E',
  'Creative & Media': '\uD83D\uDCF7',
  'Real Estate & Property': '\uD83C\uDFE0',
  'Government & Public': '\uD83C\uDFDB\uFE0F',
  'Other': '\u2728',
};

export function StepCategory({
  selectedCountry,
  setSelectedCountry,
  countryList,
  setCity,
  selectedGroup,
  setSelectedGroup,
  category,
  setCategory,
  setSelectedCapabilities,
  setSelectedPlan,
  setStep,
}: StepCategoryProps) {
  return (
    <div>
      {/* Country selection */}
      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700">Which country are you in?</label>
        <div className="flex flex-wrap gap-2">
          {countryList.map(c => (
            <button key={c.code} type="button" onClick={() => { setSelectedCountry(c.code); setCity(''); }}
              className={`flex items-center gap-2 rounded-xl border-2 px-4 py-2.5 text-sm font-medium transition ${selectedCountry === c.code ? 'border-brand bg-brand-50 text-brand' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
              <span>{c.flag}</span><span>{c.name}</span>
            </button>
          ))}
        </div>
      </div>

      {!selectedGroup ? (
        /* ── Phase 1: Show group buttons ── */
        <div className="mt-8">
          <h2 className="text-2xl font-bold text-gray-900">What best describes you?</h2>
          <p className="mt-1 text-sm text-gray-500">30-day free trial. All features included.</p>
          <div className="mt-6 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {/* Personal / Individual option first */}
            <button
              type="button"
              onClick={() => {
                setCategory('events' as BusinessCategoryKey);
                setSelectedCapabilities(CATEGORY_DEFAULT_CAPABILITIES['events'] || []);
                setStep('details');
              }}
              className="flex flex-col items-center gap-2 rounded-xl border-2 border-brand-200 bg-brand-50/30 px-3 py-4 text-center transition hover:border-brand hover:bg-brand-50"
            >
              <span className="text-2xl">🎉</span>
              <span className="text-sm font-medium text-brand-700">Personal / Individual</span>
              <span className="text-[10px] text-gray-500">Parties, events, invites</span>
            </button>
            {getCategoryGroups().map(g => (
              <button
                key={g.group}
                type="button"
                onClick={() => setSelectedGroup(g.group)}
                className="flex flex-col items-center gap-2 rounded-xl border-2 border-gray-200 bg-white px-3 py-4 text-center transition hover:border-brand hover:bg-brand-50/30"
              >
                <span className="text-2xl">{CATEGORY_GROUP_ICONS[g.group] || '\u2728'}</span>
                <span className="text-sm font-medium text-gray-700">{g.group}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        /* ── Phase 2: Show specific types within the group ── */
        <div className="mt-8">
          <button type="button" onClick={() => setSelectedGroup(null)} className="mb-4 flex items-center gap-1 text-sm text-gray-500 hover:text-brand">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            Back to groups
          </button>
          <h2 className="text-2xl font-bold text-gray-900">What specifically?</h2>
          <p className="mt-1 text-sm text-gray-500">Pick the one that best matches your business</p>
          <div className="mt-6 grid grid-cols-2 sm:grid-cols-3 gap-2">
            {(getCategoryGroups()
              .find(g => g.group === selectedGroup)
              ?.categories || BUSINESS_CATEGORIES.filter(c => c.group === selectedGroup)
            ).map(cat => (
                <button
                  key={cat.key}
                  type="button"
                  onClick={() => {
                    const key = cat.key as BusinessCategoryKey;
                    setCategory(key);
                    const defaults = CATEGORY_DEFAULT_CAPABILITIES[key] || ['scheduling'];
                    setSelectedCapabilities([...defaults]);
                    setSelectedPlan('free');
                    setStep('details');
                  }}
                  className="flex items-center gap-3 rounded-xl border-2 border-gray-200 bg-white px-3 py-3 text-left transition hover:border-brand hover:bg-brand-50/30"
                >
                  <span className="text-xl">{cat.icon}</span>
                  <span className="text-xs font-medium text-gray-700">{cat.label}</span>
                </button>
              ))}
            {/* "Other" option for every group */}
            <button
              type="button"
              onClick={() => {
                setCategory('other' as BusinessCategoryKey);
                const groupCats = BUSINESS_CATEGORIES.filter(c => c.group === selectedGroup);
                const firstKey = groupCats[0]?.key as BusinessCategoryKey || 'other';
                const defaults = CATEGORY_DEFAULT_CAPABILITIES[firstKey] || ['appointment', 'feedback', 'chat'];
                setSelectedCapabilities([...defaults]);
                setSelectedPlan('free');
                setStep('details');
              }}
              className="flex items-center gap-3 rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 px-3 py-3 text-left transition hover:border-brand hover:bg-brand-50/30"
            >
              <span className="text-xl">✨</span>
              <span className="text-xs font-medium text-gray-500">Other</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

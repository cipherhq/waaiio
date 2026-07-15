'use client';

import React, { useState, useMemo } from 'react';
import {
  BUSINESS_CATEGORIES,
  type BusinessCategoryKey,
} from '@/lib/constants';
import { getCategoryGroups, getCategoryList } from '@/lib/categoryConfig';
import { CATEGORY_DEFAULT_CAPABILITIES } from '@/lib/capabilities/types';
import type { StepCategoryProps } from './types';

/* ─── Outcome-based tiles: "What do your customers need?" ─── */

const CUSTOMER_OUTCOMES = [
  {
    id: 'book_time',
    icon: '\uD83D\uDCC5',
    title: 'Book a time with me',
    desc: 'Customers pick a date and time to see you',
    examples: 'Salons, clinics, gyms, photographers, vets',
    groups: [
      'Beauty & Wellness', 'Health & Medical', 'Fitness', 'Fitness & Wellness',
      'Professional Services', 'Pet Services', 'Creative & Media', 'Real Estate & Property',
    ],
  },
  {
    id: 'order_products',
    icon: '\uD83D\uDED2',
    title: 'Order products or food',
    desc: 'Customers browse your catalog and place orders',
    examples: 'Restaurants, shops, pharmacies, bakeries',
    groups: ['Food & Dining', 'Food & Drink', 'Delivery & Retail', 'Shops & Commerce'],
  },
  {
    id: 'buy_tickets',
    icon: '\uD83C\uDFAB',
    title: 'Buy event tickets',
    desc: 'Sell tickets with QR code check-in',
    examples: 'Concerts, conferences, shows, workshops',
    groups: ['Events & Entertainment'],
  },
  {
    id: 'reserve_spot',
    icon: '\uD83C\uDFE8',
    title: 'Reserve a table or stay',
    desc: 'Customers book rooms, tables, or rentals',
    examples: 'Hotels, restaurants, car rentals, Airbnbs',
    groups: ['Hospitality'],
  },
  {
    id: 'make_payment',
    icon: '\uD83D\uDCB3',
    title: 'Make a payment or donation',
    desc: 'Collect fees, tithes, dues, or donations',
    examples: 'Churches, schools, NGOs, government',
    groups: ['Faith & Community', 'Education & Training', 'Government & Public'],
  },
  {
    id: 'request_service',
    icon: '\uD83D\uDD27',
    title: 'Request a service',
    desc: 'Customers tell you what they need, you handle it',
    examples: 'Laundry, cleaning, repairs, transport',
    groups: ['Home & Auto Services', 'Transport', 'Transport & Logistics'],
  },
];

/* ─── Search aliases: common words people type → matching category keys ─── */

const SEARCH_ALIASES: Record<string, string[]> = {
  // Medical / Health
  'medical': ['clinic', 'dental', 'veterinary', 'therapy', 'optician', 'physiotherapy', 'medspa'],
  'medicals': ['clinic', 'dental', 'veterinary', 'therapy', 'optician', 'physiotherapy', 'medspa'],
  'hospital': ['clinic'],
  'doctor': ['clinic', 'therapy'],
  'health': ['clinic', 'dental', 'veterinary', 'therapy', 'optician', 'physiotherapy', 'medspa', 'gym', 'yoga'],
  'nurse': ['clinic'],
  'eye': ['optician'],
  'physio': ['physiotherapy'],
  'dentist': ['dental'],
  'vet': ['veterinary'],
  'pet': ['pet_grooming', 'dog_walking', 'pet_boarding', 'pet_training', 'veterinary'],
  'dog': ['dog_walking', 'pet_grooming', 'pet_boarding', 'pet_training'],
  'cat': ['pet_grooming', 'pet_boarding'],
  'animal': ['veterinary', 'pet_grooming', 'pet_boarding'],
  // Beauty
  'beauty': ['salon', 'spa', 'mua', 'nail_tech', 'lash_tech', 'waxing', 'medspa'],
  'hair': ['salon', 'barber'],
  'nails': ['nail_tech'],
  'lash': ['lash_tech'],
  'lashes': ['lash_tech'],
  'makeup': ['mua'],
  'wax': ['waxing'],
  // Food
  'food': ['restaurant', 'cafe', 'bakery', 'catering', 'food_truck', 'food_delivery'],
  'eat': ['restaurant', 'cafe', 'bar', 'lounge'],
  'cook': ['restaurant', 'catering'],
  'coffee': ['cafe'],
  'cake': ['bakery'],
  'bake': ['bakery'],
  'drink': ['bar', 'lounge', 'cafe'],
  // Services
  'fix': ['mechanic', 'plumber', 'electrician', 'handyman', 'hvac'],
  'repair': ['mechanic', 'plumber', 'electrician', 'handyman'],
  'wash': ['laundry', 'car_wash'],
  'clean': ['cleaning', 'laundry'],
  'car': ['mechanic', 'car_wash', 'car_rental', 'driving_school', 'taxi'],
  'auto': ['mechanic', 'car_wash'],
  'home': ['cleaning', 'plumber', 'electrician', 'handyman', 'pest_control', 'hvac', 'landscaping'],
  'garden': ['landscaping'],
  'bug': ['pest_control'],
  'pest': ['pest_control'],
  // Education
  'learn': ['school', 'tutor', 'language_school', 'training_academy'],
  'teach': ['school', 'tutor', 'language_school', 'training_academy'],
  'class': ['school', 'tutor', 'training_academy', 'yoga', 'pilates', 'dance', 'martial_arts'],
  'course': ['training_academy', 'language_school'],
  'child': ['daycare', 'school'],
  'kids': ['daycare', 'school'],
  'baby': ['daycare'],
  'drive': ['driving_school', 'taxi'],
  // Creative
  'photo': ['photographer'],
  'video': ['videographer'],
  'music': ['music_studio', 'dj'],
  'design': ['graphic_designer'],
  'creative': ['photographer', 'videographer', 'dj', 'graphic_designer', 'content_creator'],
  'media': ['photographer', 'videographer', 'content_creator', 'graphic_designer'],
  // Real estate
  'house': ['real_estate', 'property_manager'],
  'property': ['real_estate', 'property_manager', 'mortgage_broker'],
  'rent': ['shortlet', 'car_rental', 'property_manager'],
  'apartment': ['real_estate', 'shortlet', 'property_manager'],
  'land': ['real_estate'],
  'mortgage': ['mortgage_broker'],
  // Events
  'party': ['events', 'event_services', 'dj'],
  'wedding': ['events', 'event_services', 'photographer', 'videographer', 'catering', 'dj'],
  'concert': ['events'],
  'show': ['events', 'cinema'],
  'movie': ['cinema'],
  'film': ['cinema', 'videographer'],
  // Faith
  'church': ['church'],
  'mosque': ['mosque'],
  'tithe': ['church'],
  'offering': ['church', 'mosque'],
  'donate': ['ngo', 'crowdfunding_org', 'church'],
  'charity': ['ngo', 'crowdfunding_org'],
  'faith': ['church', 'mosque'],
  'religion': ['church', 'mosque'],
  'worship': ['church', 'mosque'],
  // Fitness
  'gym': ['gym'],
  'fitness': ['gym', 'yoga', 'pilates', 'dance', 'martial_arts', 'bootcamp'],
  'workout': ['gym', 'bootcamp'],
  'exercise': ['gym', 'yoga', 'pilates', 'bootcamp'],
  'yoga': ['yoga'],
  'dance': ['dance'],
  // Transport
  'taxi': ['taxi'],
  'ride': ['taxi'],
  'delivery': ['food_delivery', 'courier', 'logistics'],
  'ship': ['logistics'],
  'shipping': ['logistics'],
  'courier': ['courier'],
  'bus': ['bus', 'transport'],
  'train': ['bus'],
  'travel': ['travel_agency', 'transport', 'bus'],
  'move': ['moving'],
  'moving': ['moving'],
  // Hospitality
  'hotel': ['hotel'],
  'airbnb': ['shortlet'],
  'stay': ['hotel', 'shortlet'],
  'lodge': ['hotel'],
  'book': ['hotel', 'shortlet', 'salon', 'barber', 'spa', 'clinic'],
  // Government
  'government': ['government'],
  'parking': ['car_park'],
  'park': ['car_park'],
  'permit': ['government'],
  // Professional
  'lawyer': ['legal'],
  'law': ['legal'],
  'legal': ['legal'],
  'notary': ['legal'],
  'tax': ['accounting'],
  'accounting': ['accounting'],
  'consult': ['consultant'],
  'security': ['security'],
  'office': ['coworking', 'government'],
  'cowork': ['coworking'],
  // Misc
  'tailor': ['tailor'],
  'fashion': ['tailor'],
  'sew': ['tailor'],
  'print': ['printing'],
  'funeral': ['funeral'],
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
  const [searchQuery, setSearchQuery] = useState('');
  // Track which outcome was selected (for filtering subcategories)
  const [selectedOutcome, setSelectedOutcome] = useState<string | null>(null);

  // Get all categories for search
  const allCategories = getCategoryList();

  // Get categories filtered by outcome groups
  const getFilteredCategories = (outcomeId: string) => {
    const outcome = CUSTOMER_OUTCOMES.find(o => o.id === outcomeId);
    if (!outcome) return [];

    const groups = getCategoryGroups();
    const matchedCategories: Array<{ key: string; label: string; icon: string; flow: string }> = [];
    const seenKeys = new Set<string>();

    for (const group of groups) {
      if (outcome.groups.includes(group.group)) {
        for (const cat of group.categories) {
          if (!seenKeys.has(cat.key)) {
            seenKeys.add(cat.key);
            matchedCategories.push(cat);
          }
        }
      }
    }

    // Fallback: also check hardcoded BUSINESS_CATEGORIES
    if (matchedCategories.length === 0) {
      for (const cat of BUSINESS_CATEGORIES) {
        if (outcome.groups.includes(cat.group) && !seenKeys.has(cat.key)) {
          seenKeys.add(cat.key);
          matchedCategories.push(cat);
        }
      }
    }

    return matchedCategories;
  };

  // Smart search: matches label, key, group name, and aliases
  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (q.length < 2) return [];

    const matchedKeys = new Set<string>();
    const results: Array<{ key: string; label: string; icon: string; flow: string }> = [];

    // 1. Check alias map — match any word in the query
    const words = q.split(/\s+/);
    for (const word of words) {
      const aliasKeys = SEARCH_ALIASES[word];
      if (aliasKeys) {
        for (const key of aliasKeys) matchedKeys.add(key);
      }
      // Also check partial alias matches (e.g. "medic" matches "medical")
      for (const [alias, keys] of Object.entries(SEARCH_ALIASES)) {
        if (alias.startsWith(word) || word.startsWith(alias)) {
          for (const key of keys) matchedKeys.add(key);
        }
      }
    }

    // 2. Check category labels and keys (substring match)
    for (const cat of allCategories) {
      if (
        cat.label.toLowerCase().includes(q) ||
        cat.key.toLowerCase().includes(q)
      ) {
        matchedKeys.add(cat.key);
      }
    }

    // 3. Check group names (so "medical" finds "Health & Medical" group)
    for (const cat of BUSINESS_CATEGORIES) {
      if (cat.group.toLowerCase().includes(q)) {
        matchedKeys.add(cat.key);
      }
    }

    // Build results from matched keys, preserving category list order
    for (const cat of allCategories) {
      if (matchedKeys.has(cat.key)) {
        results.push(cat);
      }
    }

    return results;
  }, [searchQuery, allCategories]);

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

      {!selectedOutcome ? (
        /* ── Phase 1: Outcome-based selection ── */
        <div className="mt-8">
          <h2 className="text-2xl font-bold text-gray-900">What do your customers need?</h2>
          <p className="mt-1 text-sm text-gray-500">Pick the main thing — you can add more features later.</p>

          <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {CUSTOMER_OUTCOMES.map(outcome => (
              <button
                key={outcome.id}
                type="button"
                onClick={() => setSelectedOutcome(outcome.id)}
                className="flex items-start gap-4 rounded-xl border-2 border-gray-200 bg-white px-4 py-4 text-left transition hover:border-brand hover:bg-brand-50/30"
              >
                <span className="mt-0.5 text-2xl">{outcome.icon}</span>
                <div className="min-w-0">
                  <span className="text-sm font-semibold text-gray-900">{outcome.title}</span>
                  <p className="mt-0.5 text-xs text-gray-500">{outcome.desc}</p>
                  <p className="mt-1.5 text-[10px] text-gray-400">{outcome.examples}</p>
                </div>
              </button>
            ))}
          </div>

          {/* Personal / Individual shortcut */}
          <button
            type="button"
            onClick={() => {
              setCategory('events' as BusinessCategoryKey);
              setSelectedCapabilities(CATEGORY_DEFAULT_CAPABILITIES['events'] || []);
              setStep('features');
            }}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-brand-200 bg-brand-50/20 px-4 py-3 text-center transition hover:border-brand hover:bg-brand-50"
          >
            <span className="text-lg">{'\uD83C\uDF89'}</span>
            <span className="text-sm font-medium text-brand-700">Just planning a personal event or party?</span>
          </button>

          {/* Search fallback */}
          <div className="mt-6">
            <div className="relative">
              <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Or type what you do — e.g. salon, medical, laundry..."
                className="w-full rounded-xl border border-gray-200 bg-gray-50 py-2.5 pl-10 pr-4 text-sm outline-none focus:border-brand focus:bg-white focus:ring-2 focus:ring-brand-100"
              />
            </div>
            {searchResults.length > 0 && (
              <div className="mt-2 max-h-60 overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-sm">
                {searchResults.map(cat => (
                  <button
                    key={cat.key}
                    type="button"
                    onClick={() => {
                      const key = cat.key as BusinessCategoryKey;
                      setCategory(key);
                      const defaults = CATEGORY_DEFAULT_CAPABILITIES[key] || ['scheduling'];
                      setSelectedCapabilities([...defaults]);
                      setSelectedPlan('free');
                      setStep('features');
                    }}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-brand-50 transition border-b border-gray-50 last:border-0"
                  >
                    <span className="text-lg">{cat.icon}</span>
                    <span className="text-sm text-gray-700">{cat.label}</span>
                  </button>
                ))}
              </div>
            )}
            {searchQuery.trim().length >= 2 && searchResults.length === 0 && (
              <p className="mt-2 text-center text-xs text-gray-400">No matches found. Pick an option above or try a different search.</p>
            )}
          </div>
        </div>
      ) : (
        /* ── Phase 2: Specific business type within the selected outcome ── */
        <div className="mt-8">
          <button type="button" onClick={() => { setSelectedOutcome(null); setSearchQuery(''); }} className="mb-4 flex items-center gap-1 text-sm text-gray-500 hover:text-brand">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            Back
          </button>

          {/* Show the selected outcome context */}
          {(() => {
            const outcome = CUSTOMER_OUTCOMES.find(o => o.id === selectedOutcome);
            return outcome ? (
              <div className="mb-6 flex items-center gap-3 rounded-xl bg-brand-50 border border-brand-100 px-4 py-3">
                <span className="text-2xl">{outcome.icon}</span>
                <div>
                  <p className="text-sm font-semibold text-brand-700">{outcome.title}</p>
                  <p className="text-xs text-brand-500">{outcome.desc}</p>
                </div>
              </div>
            ) : null;
          })()}

          <h2 className="text-xl font-bold text-gray-900">What type of business?</h2>
          <p className="mt-1 text-sm text-gray-500">This helps us set up the right experience for your customers.</p>

          <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-2">
            {getFilteredCategories(selectedOutcome).map(cat => (
              <button
                key={cat.key}
                type="button"
                onClick={() => {
                  const key = cat.key as BusinessCategoryKey;
                  setCategory(key);
                  const defaults = CATEGORY_DEFAULT_CAPABILITIES[key] || ['scheduling'];
                  setSelectedCapabilities([...defaults]);
                  setSelectedPlan('free');
                  setStep('features');
                }}
                className="flex items-center gap-3 rounded-xl border-2 border-gray-200 bg-white px-3 py-3 text-left transition hover:border-brand hover:bg-brand-50/30"
              >
                <span className="text-xl">{cat.icon}</span>
                <span className="text-xs font-medium text-gray-700">{cat.label}</span>
              </button>
            ))}
            {/* "Other" option */}
            <button
              type="button"
              onClick={() => {
                setCategory('other' as BusinessCategoryKey);
                const filtered = getFilteredCategories(selectedOutcome);
                const firstKey = filtered[0]?.key as BusinessCategoryKey || 'other';
                const defaults = CATEGORY_DEFAULT_CAPABILITIES[firstKey] || ['appointment', 'feedback', 'chat'];
                setSelectedCapabilities([...defaults]);
                setSelectedPlan('free');
                setStep('features');
              }}
              className="flex items-center gap-3 rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 px-3 py-3 text-left transition hover:border-brand hover:bg-brand-50/30"
            >
              <span className="text-xl">{'\u2728'}</span>
              <span className="text-xs font-medium text-gray-500">Other</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

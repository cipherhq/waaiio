'use client';

import { useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import {
  CAPABILITIES,
  CATEGORY_DEFAULT_CAPABILITIES,
  type CapabilityId,
  canEnableCapability,
  getRequiredTier,
  TIER_LABELS,
} from '@/lib/capabilities/types';
import type { SubscriptionTier } from '@/lib/constants';

export default function CapabilitiesPage() {
  const business = useBusiness();
  const tier = (business.subscription_tier || 'free') as SubscriptionTier;
  const overrides = business.capabilityOverrides || [];
  const [enabled, setEnabled] = useState<CapabilityId[]>(business.capabilities);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const defaults = CATEGORY_DEFAULT_CAPABILITIES[business.category] || ['scheduling'];

  function handleToggle(capId: CapabilityId) {
    // Block if tier is too low and no admin override
    if (!canEnableCapability(capId, tier, overrides)) return;

    const next = enabled.includes(capId)
      ? enabled.filter(c => c !== capId)
      : [...enabled, capId];

    // Must have at least one capability
    if (next.length === 0) return;

    setEnabled(next);
  }

  async function handleSave() {
    setSaving(true);
    const supabase = createClient();

    // Disable all
    await supabase
      .from('business_capabilities')
      .update({ is_enabled: false })
      .eq('business_id', business.id);

    // Enable selected
    for (const cap of enabled) {
      await supabase
        .from('business_capabilities')
        .upsert(
          { business_id: business.id, capability: cap, is_enabled: true },
          { onConflict: 'business_id,capability' },
        );
    }

    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function handleReset() {
    setEnabled([...defaults]);
  }

  // Group capabilities: available vs locked
  const available: CapabilityId[] = [];
  const locked: CapabilityId[] = [];
  for (const cap of CAPABILITIES) {
    if (canEnableCapability(cap.id, tier, overrides)) {
      available.push(cap.id);
    } else {
      locked.push(cap.id);
    }
  }

  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Capabilities</h1>
          <p className="mt-1 text-sm text-gray-500">
            Choose which features your WhatsApp bot and dashboard should support. Changes affect your sidebar navigation and bot behavior.
          </p>
        </div>
      </div>

      {/* Current plan badge */}
      <div className="mt-4 inline-flex items-center gap-2 rounded-lg bg-gray-100 px-3 py-1.5 text-sm">
        <span className="text-gray-500">Current plan:</span>
        <span className="font-semibold text-gray-900">{TIER_LABELS[tier]}</span>
      </div>

      {/* Available capabilities */}
      <div className="mt-6 max-w-2xl space-y-3">
        {CAPABILITIES.filter(cap => available.includes(cap.id)).map((cap) => {
          const isEnabled = enabled.includes(cap.id);
          const isDefault = defaults.includes(cap.id);
          const isOverridden = overrides.includes(cap.id);

          return (
            <button
              key={cap.id}
              type="button"
              onClick={() => handleToggle(cap.id)}
              className={`flex w-full items-center gap-4 rounded-xl border-2 p-5 text-left transition ${
                isEnabled
                  ? 'border-brand bg-brand-50/50'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <span className="text-2xl">{cap.icon}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-bold text-gray-900">{cap.label}</h3>
                  {isDefault && (
                    <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-bold text-brand-700">
                      Default
                    </span>
                  )}
                  {isOverridden && (
                    <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-700">
                      Granted
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-gray-500">{cap.description}</p>
              </div>
              <div className={`flex h-6 w-11 flex-shrink-0 items-center rounded-full transition ${
                isEnabled ? 'bg-brand' : 'bg-gray-200'
              }`}>
                <div className={`h-5 w-5 rounded-full bg-white shadow transition ${
                  isEnabled ? 'translate-x-5' : 'translate-x-0.5'
                }`} />
              </div>
            </button>
          );
        })}
      </div>

      {/* Locked capabilities */}
      {locked.length > 0 && (
        <div className="mt-10 max-w-2xl">
          <h2 className="mb-3 text-sm font-semibold text-gray-500 uppercase tracking-wide">
            Upgrade to Unlock
          </h2>
          <div className="space-y-3">
            {CAPABILITIES.filter(cap => locked.includes(cap.id)).map((cap) => {
              const requiredTier = getRequiredTier(cap.id);

              return (
                <div
                  key={cap.id}
                  className="flex w-full items-center gap-4 rounded-xl border-2 border-dashed border-gray-200 bg-gray-50 p-5 opacity-70"
                >
                  <span className="text-2xl grayscale">{cap.icon}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-bold text-gray-600">{cap.label}</h3>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        requiredTier === 'business'
                          ? 'bg-purple-100 text-purple-700'
                          : 'bg-amber-100 text-amber-700'
                      }`}>
                        {TIER_LABELS[requiredTier]}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-gray-400">{cap.description}</p>
                  </div>
                  <div className="flex h-6 w-11 flex-shrink-0 items-center justify-center">
                    <svg className="h-5 w-5 text-gray-300" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                    </svg>
                  </div>
                </div>
              );
            })}

            {/* Upgrade CTA */}
            <a
              href="/dashboard/settings"
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-amber-500 to-orange-500 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:from-amber-600 hover:to-orange-600 transition"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
              </svg>
              Upgrade Plan
            </a>
          </div>
        </div>
      )}

      <div className="mt-8 flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
        >
          {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Changes'}
        </button>
        <button
          onClick={handleReset}
          className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
        >
          Reset to Defaults
        </button>
      </div>

      <p className="mt-4 text-xs text-gray-400">
        Note: Reload the page after saving to see updated sidebar navigation.
      </p>
    </div>
  );
}

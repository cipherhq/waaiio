'use client';

import { useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { CAPABILITIES, CATEGORY_DEFAULT_CAPABILITIES, type CapabilityId } from '@/lib/capabilities/types';

export default function CapabilitiesPage() {
  const business = useBusiness();
  const [enabled, setEnabled] = useState<CapabilityId[]>(business.capabilities);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const defaults = CATEGORY_DEFAULT_CAPABILITIES[business.category] || ['scheduling'];

  async function handleToggle(capId: CapabilityId) {
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

      <div className="mt-8 max-w-2xl space-y-3">
        {CAPABILITIES.map((cap) => {
          const isEnabled = enabled.includes(cap.id);
          const isDefault = defaults.includes(cap.id);

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

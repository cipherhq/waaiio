'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import {
  CAPABILITIES,
  type CapabilityId,
  type CapabilityDefinition,
  canEnableCapability,
  getRequiredTier,
  TIER_LABELS,
} from '@/lib/capabilities/types';

import type { SubscriptionTier } from '@/lib/constants';

// ── Capability Groups ──
interface CapabilityGroup {
  label: string;
  icon: string;
  ids: CapabilityId[];
}

const CAPABILITY_GROUPS: CapabilityGroup[] = [
  {
    label: 'Booking & Scheduling',
    icon: '\u{1F4C5}',
    ids: ['appointment', 'scheduling', 'table_reservation', 'reservation', 'class_booking'],
  },
  {
    label: 'Payments & Commerce',
    icon: '\u{1F4B0}',
    ids: ['payment', 'ordering', 'giving', 'recurring', 'invoice', 'estimates', 'packages'],
  },
  {
    label: 'Events & Tickets',
    icon: '\u{1F3AB}',
    ids: ['ticketing', 'crowdfunding'],
  },
  {
    label: 'Customer Engagement',
    icon: '\u{1F465}',
    ids: ['chat', 'broadcast', 'feedback', 'survey', 'poll', 'loyalty', 'referral', 'membership', 'promo_verification'],
  },
  {
    label: 'Operations',
    icon: '\u{2699}\u{FE0F}',
    ids: ['staff', 'queue', 'waitlist', 'reminders', 'auto_reply', 'reports', 'multi_location'],
  },
  {
    label: 'Documents',
    icon: '\u{1F4DD}',
    ids: ['whatsapp_sign', 'waiver'],
  },
];

// Map capability ID to its definition for O(1) lookup
const CAP_MAP = new Map<string, CapabilityDefinition>(
  CAPABILITIES.map(c => [c.id, c]),
);

export default function CapabilitiesPage() {
  const business = useBusiness();
  const tier = (business.subscription_tier || 'free') as SubscriptionTier;
  const overrides = business.capabilityOverrides || [];
  // Initialize from selectedCapabilities (includes paused) not effective capabilities
  const selected = business.selectedCapabilities || business.capabilities;
  const [enabled, setEnabled] = useState<CapabilityId[]>(selected);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');

  // ── Drag-and-drop reorder state ──
  const serverOrder = (selected || []) as CapabilityId[];
  const [orderedCaps, setOrderedCaps] = useState<CapabilityId[]>(serverOrder);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [error, setError] = useState('');

  // Sync orderedCaps when enabled changes
  useEffect(() => {
    setOrderedCaps(prev => {
      // Keep existing order for caps that are still enabled
      const stillEnabled = prev.filter(c => enabled.includes(c));
      // Add newly enabled caps at the end
      const newlyEnabled = enabled.filter(c => !prev.includes(c));
      return [...stillEnabled, ...newlyEnabled];
    });
  }, [enabled]);

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverIndex(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    const fromIndex = dragIndex;
    setDragIndex(null);
    setDragOverIndex(null);

    if (fromIndex === null || fromIndex === dropIndex) return;

    // Local-only reorder — no network request. User commits via Save Changes.
    const newOrder = [...orderedCaps];
    const [moved] = newOrder.splice(fromIndex, 1);
    newOrder.splice(dropIndex, 0, moved);
    setOrderedCaps(newOrder);
  }, [dragIndex, orderedCaps]);

  const handleDragEnd = useCallback(() => {
    setDragIndex(null);
    setDragOverIndex(null);
  }, []);

  // Check if business is still in 30-day trial
  const isInTrial = useMemo(() => {
    // Paid plans are never in trial — they have their tier's capabilities
    if (tier !== 'free') return false;
    if (!business.trial_ends_at) return false;
    return new Date(business.trial_ends_at) > new Date();
  }, [business.trial_ends_at, tier]);

  // During trial, everything is toggleable regardless of tier
  const canToggle = (capId: CapabilityId) => {
    if (isInTrial) return true;
    return canEnableCapability(capId, tier, overrides);
  };

  // Tier badge info
  const getTierBadge = (capId: CapabilityId) => {
    const required = getRequiredTier(capId);
    if (required === 'free') return null;
    return {
      label: TIER_LABELS[required],
      className:
        required === 'business'
          ? 'bg-purple-100 text-purple-700'
          : 'bg-blue-100 text-blue-700',
    };
  };

  function handleToggle(capId: CapabilityId) {
    if (!canToggle(capId) || saving) return;

    let nextEnabled = enabled.includes(capId)
      ? enabled.filter(c => c !== capId)
      : [...enabled, capId];

    // Bundle: membership requires loyalty (they share the points system)
    if (capId === 'membership' && nextEnabled.includes('membership') && !nextEnabled.includes('loyalty')) {
      nextEnabled = [...nextEnabled, 'loyalty'];
    }
    // If disabling loyalty, also disable membership (can't work without points)
    if (capId === 'loyalty' && !nextEnabled.includes('loyalty') && nextEnabled.includes('membership')) {
      nextEnabled = nextEnabled.filter(c => c !== 'membership');
    }

    // Must have at least one capability
    if (nextEnabled.length === 0) return;

    // Update local state only — no auto-save. User commits via Save Changes.
    setEnabled(nextEnabled);
  }

  async function handleSave() {
    setSaving(true);
    setError('');

    try {
      // Detect newly enabled vs previous SELECTED state (not effective).
      // A paused selected capability is NOT newly activated.
      const previousSelected = new Set(serverSelected);
      const newlyEnabled = enabled.filter(cap => !previousSelected.has(cap));

      // Use atomic bulk configuration endpoint
      const res = await fetch('/api/capabilities/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId: business.id,
          capabilities: enabled,
          order: orderedCaps,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ reason: 'unknown' }));
        // Rollback to SERVER state (not local draft)
        setEnabled([...serverSelected]);
        setOrderedCaps([...serverOrder]);
        setError(
          data.reason === 'capabilities_denied'
            ? 'Some capabilities require a higher plan. Please upgrade.'
            : data.reason === 'dependency_missing'
              ? `${data.capability} requires ${data.missing_dependencies?.join(', ')} to be enabled.`
              : data.reason === 'configuration_conflict'
                ? 'Configuration changed elsewhere. Please refresh the page.'
                : 'Failed to save capabilities. Please try again.'
        );
        return;
      }

      // Auto-provision templates only for genuinely new capabilities (best-effort)
      for (const cap of newlyEnabled) {
        fetch('/api/whatsapp/templates/provision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ business_id: business.id, capability: cap }),
        }).catch(() => {});
      }

      // Reload to get fresh server state (selectedCapabilities, capabilities, pausedCapabilities)
      window.location.reload();
    } catch {
      // Network error — rollback to SERVER state
      setEnabled([...serverSelected]);
      setOrderedCaps([...serverOrder]);
      setError('Network error. Please check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  // Filter capabilities by search
  const searchLower = search.toLowerCase().trim();

  const filteredGroups = useMemo(() => {
    if (!searchLower) return CAPABILITY_GROUPS;
    return CAPABILITY_GROUPS.map(group => ({
      ...group,
      ids: group.ids.filter(id => {
        const cap = CAP_MAP.get(id);
        if (!cap) return false;
        return (
          cap.label.toLowerCase().includes(searchLower) ||
          cap.description.toLowerCase().includes(searchLower) ||
          cap.id.toLowerCase().includes(searchLower)
        );
      }),
    })).filter(group => group.ids.length > 0);
  }, [searchLower]);

  const enabledCount = enabled.length;
  const totalCount = CAPABILITIES.length;

  // Compare against server-selected (includes paused), NOT effective
  const serverSelected = (business.selectedCapabilities || business.capabilities) as CapabilityId[];
  const hasChanges = (() => {
    // Selection changed?
    if (enabled.length !== serverSelected.length) return true;
    const sorted1 = [...enabled].sort();
    const sorted2 = [...serverSelected].sort();
    if (sorted1.some((v, i) => v !== sorted2[i])) return true;
    // Order changed?
    if (orderedCaps.length !== serverOrder.length) return true;
    return orderedCaps.some((v, i) => v !== serverOrder[i]);
  })();

  return (
    <div className="pb-10">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            Add Features
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Choose the features you want, then click Save Changes to update your account and WhatsApp bot.
            {isInTrial && ' Your 30-day trial includes everything — try them all.'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-2 rounded-lg bg-gray-100 dark:bg-gray-800 px-3 py-1.5 text-sm">
            <span className="text-gray-500 dark:text-gray-400">Plan:</span>
            <span className="font-semibold text-gray-900 dark:text-gray-100">
              {TIER_LABELS[tier]}
            </span>
          </span>
          {isInTrial && (
            <span className="inline-flex items-center rounded-lg bg-green-100 dark:bg-green-900/30 px-3 py-1.5 text-sm font-medium text-green-700 dark:text-green-400">
              Trial Active
            </span>
          )}
        </div>
      </div>

      {/* Counter + Search */}
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          <span className="font-semibold text-gray-900 dark:text-gray-100">{enabledCount}</span>
          {' '}of{' '}
          <span className="font-semibold text-gray-900 dark:text-gray-100">{totalCount}</span>
          {' '}features enabled
        </p>
        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            type="text"
            placeholder="Search features..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 py-2 pl-10 pr-4 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand sm:w-64"
          />
        </div>
      </div>

      {/* Bot Menu Order is on the WhatsApp Setup page */}

      {/* All Features — Toggle On/Off */}
      <div className="mt-6 space-y-8">
        {filteredGroups.map(group => (
          <div key={group.label}>
            {/* Group header */}
            <div className="mb-3 flex items-center gap-2 rounded-lg bg-gray-50 dark:bg-gray-800/50 px-4 py-2.5">
              <span className="text-lg">{group.icon}</span>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
                {group.label}
              </h2>
            </div>

            {/* Capability cards */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3">
              {group.ids.map(capId => {
                const cap = CAP_MAP.get(capId);
                if (!cap) return null;

                const isEnabled = enabled.includes(capId);
                const isToggleable = canToggle(capId);
                const badge = getTierBadge(capId);
                const requiredTier = getRequiredTier(capId);
                const needsUpgrade = !isInTrial && !canEnableCapability(capId, tier, overrides);

                return (
                  <div
                    key={capId}
                    className={`flex items-start gap-3 rounded-xl border-2 p-4 transition ${
                      isEnabled
                        ? 'border-brand bg-brand-50/50 dark:bg-brand-950/20 dark:border-brand-400'
                        : needsUpgrade
                          ? 'border-dashed border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 opacity-75'
                          : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                    }`}
                  >
                    <span className={`text-2xl flex-shrink-0 ${needsUpgrade ? 'grayscale' : ''}`}>
                      {cap.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <h3 className={`text-sm font-semibold ${needsUpgrade ? 'text-gray-600 dark:text-gray-500' : 'text-gray-900 dark:text-gray-100'}`}>
                          {cap.label}
                        </h3>
                        {badge && (
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${badge.className}`}>
                            {badge.label}
                          </span>
                        )}
                      </div>
                      <p className={`mt-1 text-xs leading-relaxed ${needsUpgrade ? 'text-gray-400 dark:text-gray-500' : 'text-gray-500 dark:text-gray-400'}`}>
                        {cap.description}
                      </p>
                    </div>
                    <div className="flex-shrink-0 pt-0.5">
                      {needsUpgrade ? (
                        <a
                          href="/dashboard/settings"
                          className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition ${
                            requiredTier === 'business'
                              ? 'bg-purple-600 hover:bg-purple-700'
                              : 'bg-blue-600 hover:bg-blue-700'
                          }`}
                        >
                          <svg aria-hidden="true" className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                          </svg>
                          Upgrade
                        </a>
                      ) : (
                        <button
                          onClick={() => handleToggle(capId)}
                          className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                            isEnabled
                              ? 'bg-brand text-white hover:bg-brand-600'
                              : 'border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                          }`}
                        >
                          {isEnabled ? 'Enabled \u2713' : 'Enable'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* No results */}
      {filteredGroups.length === 0 && (
        <div className="mt-12 text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No features match &ldquo;{search}&rdquo;
          </p>
          <button
            onClick={() => setSearch('')}
            className="mt-2 text-sm font-medium text-brand hover:underline"
          >
            Clear search
          </button>
        </div>
      )}

      {/* Sticky save bar */}
      {hasChanges && (
        <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-3 shadow-lg md:left-64">
          <div className="mx-auto flex max-w-4xl items-center justify-between">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              You have unsaved changes
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={() => {
                  setEnabled([...serverSelected]);
                  setOrderedCaps([...serverOrder]);
                }}
                className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                Discard
              </button>
              <button
                id="cap-save-btn"
                onClick={handleSave}
                disabled={saving}
                className="rounded-lg bg-brand px-6 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

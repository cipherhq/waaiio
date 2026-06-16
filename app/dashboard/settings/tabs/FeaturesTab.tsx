'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { PhoneInput } from '@/components/auth/PhoneInput';
import type { CountryCode } from '@/lib/constants';
import type { SettingsTabProps } from './types';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
const DAY_LABELS: Record<string, string> = {
  monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu',
  friday: 'Fri', saturday: 'Sat', sunday: 'Sun',
};

type ArDaySchedule = { open: string; close: string; enabled: boolean };

export function FeaturesTab({ business, capabilities, country, curr, saving, setSaving, saved, setSaved, openSections, toggleSection }: SettingsTabProps) {
  const meta = (business.metadata || {}) as Record<string, unknown>;

  // Queue settings from business.metadata
  const [queueAvgMinutes, setQueueAvgMinutes] = useState<number>((meta.queue_avg_service_minutes as number) || 10);
  const [queueNotifyStaff, setQueueNotifyStaff] = useState<boolean>(meta.queue_notify_staff !== false);
  const [queuePaused, setQueuePaused] = useState<boolean>((meta.queue_paused as boolean) || false);

  // Ordering settings from business.metadata
  const [orderingQuickAdd, setOrderingQuickAdd] = useState<boolean>(meta.ordering_quick_add !== false);
  const [orderingBrowseByCategory, setOrderingBrowseByCategory] = useState<boolean>((meta.ordering_browse_by_category as boolean) || false);
  const [logisticsMode, setLogisticsMode] = useState<boolean>((meta.logistics_mode as boolean) || false);

  // Custom order settings from business.metadata
  const customConfig = (meta.custom_order_config || {}) as Record<string, unknown>;
  const [customOrderMode, setCustomOrderMode] = useState<boolean>((meta.custom_order_mode as boolean) || false);
  const [customDepositPct, setCustomDepositPct] = useState<number>((customConfig.deposit_percentage as number) || 50);
  const [customMeasurementFields, setCustomMeasurementFields] = useState<string>(
    ((customConfig.measurement_fields as string[]) || []).join('\n')
  );
  const [customRequirePhoto, setCustomRequirePhoto] = useState<boolean>(customConfig.require_style_photo !== false);
  const [customRequireMeasurements, setCustomRequireMeasurements] = useState<boolean>(customConfig.require_measurements !== false);
  const [customRequireDeadline, setCustomRequireDeadline] = useState<boolean>(customConfig.require_deadline !== false);

  // Auto-reply settings (from whatsapp_config)
  const [arEnabled, setArEnabled] = useState(false);
  const [arAwayMessage, setArAwayMessage] = useState('Thanks for your message! We\'re currently closed. We\'ll get back to you during business hours.');
  const [arInstantEnabled, setArInstantEnabled] = useState(true);
  const [arInstantMessage, setArInstantMessage] = useState('Hi! Thanks for reaching out. We\'ll be with you shortly.');
  const [arTimezone, setArTimezone] = useState('Africa/Lagos');
  const [arHours, setArHours] = useState<Record<string, ArDaySchedule>>(
    Object.fromEntries(DAYS.map(d => [d, { open: '09:00', close: '17:00', enabled: d !== 'sunday' }]))
  );
  const [arLoading, setArLoading] = useState(true);
  const [arSaving, setArSaving] = useState(false);
  const [arSaved, setArSaved] = useState(false);

  // Notification preferences state
  const [notifEmailEnabled, setNotifEmailEnabled] = useState(true);
  const [notifSoundEnabled, setNotifSoundEnabled] = useState(true);
  const [notifWhatsAppEnabled, setNotifWhatsAppEnabled] = useState(false);
  const [notifWhatsAppPhone, setNotifWhatsAppPhone] = useState('');
  const [notifMonthlyCount, setNotifMonthlyCount] = useState(0);
  const [balanceReminders, setBalanceReminders] = useState(true);
  const [includePayLinks, setIncludePayLinks] = useState(true);
  const [notifSaving, setNotifSaving] = useState(false);
  const [notifSaved, setNotifSaved] = useState(false);

  // Load auto-reply config from whatsapp_config
  useEffect(() => {
    async function loadAutoReply() {
      setArLoading(true);
      const supabase = createClient();
      const { data } = await supabase
        .from('whatsapp_config')
        .select('auto_reply_enabled, business_hours, away_message, instant_reply_enabled, instant_reply_message')
        .eq('business_id', business.id)
        .maybeSingle();
      if (data) {
        setArEnabled(data.auto_reply_enabled ?? false);
        if (data.away_message) setArAwayMessage(data.away_message);
        setArInstantEnabled(data.instant_reply_enabled ?? true);
        if (data.instant_reply_message) setArInstantMessage(data.instant_reply_message);
        const bh = data.business_hours as Record<string, unknown> | null;
        if (bh && typeof bh === 'object') {
          if (bh.timezone) setArTimezone(bh.timezone as string);
          const loaded: Record<string, ArDaySchedule> = {};
          for (const d of DAYS) {
            const ds = bh[d] as ArDaySchedule | undefined;
            if (ds) {
              loaded[d] = { open: ds.open || '09:00', close: ds.close || '17:00', enabled: ds.enabled ?? true };
            } else {
              loaded[d] = { open: '09:00', close: '17:00', enabled: d !== 'sunday' };
            }
          }
          setArHours(loaded);
        }
      }
      setArLoading(false);
    }
    loadAutoReply();
  }, [business.id]);

  // Load notification preferences
  useEffect(() => {
    async function loadNotifPrefs() {
      const supabase = createClient();
      const { data } = await supabase
        .from('whatsapp_config')
        .select('notify_email_enabled, notify_sound_enabled, notify_whatsapp_enabled, notify_whatsapp_phone, notify_monthly_count, send_balance_reminders, include_payment_links')
        .eq('business_id', business.id)
        .maybeSingle();
      if (data) {
        setNotifEmailEnabled(data.notify_email_enabled !== false);
        setNotifSoundEnabled(data.notify_sound_enabled !== false);
        setNotifWhatsAppEnabled(data.notify_whatsapp_enabled ?? false);
        setNotifWhatsAppPhone(data.notify_whatsapp_phone || '');
        setNotifMonthlyCount(data.notify_monthly_count || 0);
        setBalanceReminders(data.send_balance_reminders !== false);
        setIncludePayLinks(data.include_payment_links !== false);
      }
    }
    loadNotifPrefs();
  }, [business.id]);

  async function handleSaveAutoReply() {
    setArSaving(true);
    const supabase = createClient();
    const businessHours: Record<string, unknown> = { timezone: arTimezone };
    for (const d of DAYS) {
      businessHours[d] = arHours[d];
    }
    await supabase
      .from('whatsapp_config')
      .upsert({
        business_id: business.id,
        auto_reply_enabled: arEnabled,
        business_hours: businessHours,
        away_message: arAwayMessage,
        instant_reply_enabled: arInstantEnabled,
        instant_reply_message: arInstantMessage,
      }, { onConflict: 'business_id' });
    setArSaving(false);
    setArSaved(true);
    setTimeout(() => setArSaved(false), 2000);
  }

  return (
        <div className="mt-6 max-w-3xl space-y-4">
          {capabilities.includes('queue') && (
            <div>
              <button onClick={() => toggleSection('queue')} className="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3.5 hover:bg-gray-50 transition shadow-sm cursor-pointer">
                <h3 className="text-sm font-bold text-gray-900">Queue</h3>
                <svg aria-hidden="true" className={`h-5 w-5 text-brand transition-transform ${openSections.includes('queue') ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
              </button>
              {openSections.includes('queue') && (
                <div className="mt-4">
        {/* Queue Settings Tab */}
        <div className="mt-6 max-w-xl">
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-bold text-gray-900">Queue Settings</h2>
            <p className="mt-1 text-xs text-gray-500">
              Configure how your queue behaves, including wait-time estimates and notifications.
            </p>

            <div className="mt-5 space-y-5">
              {/* Average service time */}
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Average service time (minutes)</label>
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={queueAvgMinutes || ''}
                  onFocus={e => e.target.select()}
                  onChange={(e) => setQueueAvgMinutes(Math.max(1, Math.min(120, Number(e.target.value))))}
                  className="w-32 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                />
                <p className="mt-1 text-xs text-gray-400">Used to estimate wait times for customers. Default is 10 minutes.</p>
              </div>

              {/* Notify staff on check-in */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-700">Notify staff on check-in</p>
                  <p className="text-xs text-gray-400">
                    {queueNotifyStaff
                      ? 'Audio chime and browser notification when a customer checks in.'
                      : 'Notifications are disabled — check-ins happen silently.'}
                  </p>
                </div>
                <button
                  onClick={() => setQueueNotifyStaff(!queueNotifyStaff)}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition ${queueNotifyStaff ? 'bg-brand' : 'bg-gray-200'}`}
                >
                  <div
                    className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition"
                    style={{ left: queueNotifyStaff ? '22px' : '2px' }}
                  />
                </button>
              </div>

              {/* Queue paused */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-700">Pause queue</p>
                  <p className="text-xs text-gray-400">
                    {queuePaused
                      ? 'Queue is paused — customers cannot check in via WhatsApp.'
                      : 'Queue is active — customers can check in normally.'}
                  </p>
                </div>
                <button
                  onClick={() => setQueuePaused(!queuePaused)}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition ${queuePaused ? 'bg-yellow-500' : 'bg-gray-200'}`}
                >
                  <div
                    className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition"
                    style={{ left: queuePaused ? '22px' : '2px' }}
                  />
                </button>
              </div>
            </div>

            <button
              onClick={async () => {
                setSaving(true);
                const supabase = createClient();
                await supabase
                  .from('businesses')
                  .update({
                    metadata: {
                      ...meta,
                      queue_avg_service_minutes: queueAvgMinutes,
                      queue_notify_staff: queueNotifyStaff,
                      queue_paused: queuePaused,
                    },
                  })
                  .eq('id', business.id);
                setSaving(false);
                setSaved(true);
                setTimeout(() => setSaved(false), 2000);
              }}
              disabled={saving}
              className="mt-6 rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Queue Settings'}
            </button>
          </div>
        </div>
                </div>
              )}
            </div>
          )}
          {capabilities.includes('ordering') && (
            <div>
              <button onClick={() => toggleSection('ordering')} className="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3.5 hover:bg-gray-50 transition shadow-sm cursor-pointer">
                <h3 className="text-sm font-bold text-gray-900">Ordering</h3>
                <svg aria-hidden="true" className={`h-5 w-5 text-brand transition-transform ${openSections.includes('ordering') ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
              </button>
              {openSections.includes('ordering') && (
                <div className="mt-4">
        {/* Ordering Tab */}
        <div className="mt-6 max-w-xl">
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-bold text-gray-900">Ordering Settings</h2>
            <p className="mt-1 text-xs text-gray-500">
              Control how customers browse and order from your WhatsApp bot.
            </p>

            <div className="mt-5 space-y-6">
              {/* Quick Add Toggle */}
              <div>
                <div className="flex items-center justify-between">
                  <div className="pr-8">
                    <p className="text-sm font-medium text-gray-700">Quick Add</p>
                    <p className="mt-0.5 text-xs text-gray-400">
                      {orderingQuickAdd
                        ? 'Customers tap a product to instantly add 1 to cart. Great for restaurants and food ordering.'
                        : 'Customers select a product, then type the quantity they want. Better for bulk or wholesale orders.'}
                    </p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={orderingQuickAdd}
                    aria-label="Quick Add"
                    onClick={() => setOrderingQuickAdd(!orderingQuickAdd)}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 ${orderingQuickAdd ? 'bg-brand' : 'bg-gray-200'}`}
                  >
                    <div
                      className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition"
                      style={{ left: orderingQuickAdd ? '22px' : '2px' }}
                    />
                  </button>
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-medium text-brand">See example flow</summary>
                  <div className="mt-1 rounded-lg bg-gray-50 px-3 py-2">
                    <p className="text-xs text-gray-500">
                      {orderingQuickAdd
                        ? 'Customer taps "Jollof Rice" \u2192 added to cart \u2192 menu shown again. Fast!'
                        : 'Customer taps "Jollof Rice" \u2192 "How many?" \u2192 types "3" \u2192 added to cart.'}
                    </p>
                  </div>
                </details>
              </div>

              {/* Browse by Category Toggle */}
              <div>
                <div className="flex items-center justify-between">
                  <div className="pr-8">
                    <p className="text-sm font-medium text-gray-700">Browse by Category</p>
                    <p className="mt-0.5 text-xs text-gray-400">
                      {orderingBrowseByCategory
                        ? 'Customers pick a category first, then see products in that category. Best for large menus.'
                        : 'All products shown at once, grouped by category in sections. Best for smaller menus.'}
                    </p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={orderingBrowseByCategory}
                    aria-label="Browse by Category"
                    onClick={() => setOrderingBrowseByCategory(!orderingBrowseByCategory)}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 ${orderingBrowseByCategory ? 'bg-brand' : 'bg-gray-200'}`}
                  >
                    <div
                      className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition"
                      style={{ left: orderingBrowseByCategory ? '22px' : '2px' }}
                    />
                  </button>
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-medium text-brand">See example flow</summary>
                  <div className="mt-1 rounded-lg bg-gray-50 px-3 py-2">
                    <p className="text-xs text-gray-500">
                      {orderingBrowseByCategory
                        ? 'Customer sees categories (Grill, Sides, Drinks...) \u2192 taps one \u2192 sees items in that category.'
                        : 'Customer sees full menu with all products in one list, organized by category sections.'}
                    </p>
                  </div>
                </details>
              </div>

              {/* Logistics Mode Toggle — visually separated as a major mode change */}
              <hr className="border-gray-100" />
              <div className={`rounded-lg border p-4 ${logisticsMode ? 'border-amber-200 bg-amber-50' : 'border-gray-100 bg-white'}`}>
                <div className="flex items-center justify-between">
                  <div className="pr-8">
                    <p className="text-sm font-medium text-gray-700">Logistics Mode</p>
                    <p className={`mt-0.5 text-xs ${logisticsMode ? 'text-amber-600' : 'text-gray-400'}`}>
                      {logisticsMode
                        ? 'This replaces the standard ordering flow with a courier/delivery flow.'
                        : 'Standard flow. Customers select a delivery zone or enter one address.'}
                    </p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={logisticsMode}
                    aria-label="Logistics Mode"
                    onClick={() => { if (!logisticsMode) setCustomOrderMode(false); setLogisticsMode(!logisticsMode); }}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 ${logisticsMode ? 'bg-brand' : 'bg-gray-200'}`}
                  >
                    <div
                      className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition"
                      style={{ left: logisticsMode ? '22px' : '2px' }}
                    />
                  </button>
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-medium text-brand">See example flow</summary>
                  <div className="mt-1 rounded-lg bg-gray-50 px-3 py-2">
                    <p className="text-xs text-gray-500">
                      {logisticsMode
                        ? 'Customer enters pickup address \u2192 drop-off address \u2192 package details \u2192 optional photo \u2192 review.'
                        : 'Customer selects delivery zone or chooses pickup/delivery \u2192 enters one address.'}
                    </p>
                  </div>
                </details>
              </div>
            </div>

            <div className="sticky bottom-4 z-10 mt-6 flex justify-end">
              <button
                onClick={async () => {
                  setSaving(true);
                  const supabase = createClient();
                  const measurementFields = customMeasurementFields
                    .split('\n')
                    .map(f => f.trim())
                    .filter(f => f.length > 0);
                  await supabase
                    .from('businesses')
                    .update({
                      metadata: {
                        ...meta,
                        ordering_quick_add: orderingQuickAdd,
                        ordering_browse_by_category: orderingBrowseByCategory,
                        logistics_mode: logisticsMode,
                        custom_order_mode: customOrderMode,
                        custom_order_config: {
                          deposit_percentage: customDepositPct,
                          measurement_fields: measurementFields,
                          require_style_photo: customRequirePhoto,
                          require_measurements: customRequireMeasurements,
                          require_deadline: customRequireDeadline,
                        },
                      },
                    })
                    .eq('id', business.id);
                  setSaving(false);
                  setSaved(true);
                  setTimeout(() => setSaved(false), 2000);
                }}
                disabled={saving}
                className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white shadow-lg hover:bg-brand-600 disabled:opacity-50"
              >
                {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Ordering Settings'}
              </button>
            </div>
          </div>

          {/* Custom Orders */}
          <div className="mt-6 rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-bold text-gray-900">Custom Orders</h2>
            <p className="mt-1 text-xs text-gray-500">
              For tailors, furniture makers, bakers, and other made-to-order businesses. Customers send style photos, measurements, and notes.
            </p>

            <div className="mt-5 space-y-6">
              {/* Enable Custom Order Mode */}
              <div>
                <div className="flex items-center justify-between">
                  <div className="pr-8">
                    <p className="text-sm font-medium text-gray-700">Enable Custom Order Mode</p>
                    <p className="mt-0.5 text-xs text-gray-400">
                      {customOrderMode
                        ? 'Customers provide photos, measurements, and notes. All orders go through price request.'
                        : 'Standard ordering flow. Customers select products and pay at listed prices.'}
                    </p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={customOrderMode}
                    aria-label="Custom Order Mode"
                    onClick={() => { if (!customOrderMode) setLogisticsMode(false); setCustomOrderMode(!customOrderMode); }}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 ${customOrderMode ? 'bg-brand' : 'bg-gray-200'}`}
                  >
                    <div
                      className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition"
                      style={{ left: customOrderMode ? '22px' : '2px' }}
                    />
                  </button>
                </div>
              </div>

              {customOrderMode && (
                <>
                  {/* Deposit Percentage */}
                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">
                      Deposit Percentage
                    </label>
                    <p className="mb-2 text-xs text-gray-400">
                      When a price is accepted, this percentage is charged upfront. The rest is charged when the order is ready.
                    </p>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={customDepositPct || ''}
                        onFocus={e => e.target.select()}
                        onChange={(e) => setCustomDepositPct(Math.min(100, Math.max(0, parseInt(e.target.value) || 0)))}
                        className="w-24 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                      />
                      <span className="text-sm text-gray-500">%</span>
                      <span className="ml-2 text-xs text-gray-400">
                        {customDepositPct === 0 ? 'Full payment on price accept' : customDepositPct === 100 ? 'Full payment upfront' : `${customDepositPct}% upfront, ${100 - customDepositPct}% on completion`}
                      </span>
                    </div>
                  </div>

                  {/* Measurement Fields */}
                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">
                      Measurement Fields
                    </label>
                    <p className="mb-2 text-xs text-gray-400">
                      One field per line. Customers will be asked for each measurement.
                    </p>
                    <textarea
                      value={customMeasurementFields}
                      onChange={(e) => setCustomMeasurementFields(e.target.value)}
                      placeholder={'Chest\nWaist\nHip\nShoulder\nArm Length'}
                      rows={5}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                  </div>

                  {/* Requirement Toggles */}
                  <div className="space-y-3">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Requirements</p>
                    {[
                      { label: 'Require style reference photo', value: customRequirePhoto, set: setCustomRequirePhoto },
                      { label: 'Require measurements', value: customRequireMeasurements, set: setCustomRequireMeasurements },
                      { label: 'Require deadline', value: customRequireDeadline, set: setCustomRequireDeadline },
                    ].map(({ label, value, set }) => (
                      <div key={label} className="flex items-center justify-between">
                        <span className="text-sm text-gray-600">{label}</span>
                        <button
                          role="switch"
                          aria-checked={value}
                          aria-label={label}
                          onClick={() => set(!value)}
                          className={`relative h-5 w-9 shrink-0 rounded-full transition focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 ${value ? 'bg-brand' : 'bg-gray-200'}`}
                        >
                          <div
                            className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition"
                            style={{ left: value ? '18px' : '2px' }}
                          />
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
                </div>
              )}
            </div>
          )}
          <div>
            <button onClick={() => toggleSection('auto_reply')} className="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3.5 hover:bg-gray-50 transition shadow-sm cursor-pointer">
              <h3 className="text-sm font-bold text-gray-900">Auto Reply</h3>
              <svg aria-hidden="true" className={`h-5 w-5 text-brand transition-transform ${openSections.includes('auto_reply') ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
            {openSections.includes('auto_reply') && (
              <div className="mt-4">
        {/* Auto Reply & Business Hours Tab */}
        <div className="mt-6 max-w-2xl space-y-6">
          {arLoading ? (
            <div className="flex items-center justify-center py-12">
              <svg aria-hidden="true" className="h-6 w-6 animate-spin text-gray-400" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
          ) : (
            <>
              {/* Auto-reply toggle */}
              <div className="rounded-xl border border-gray-100 bg-white p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-bold text-gray-900">Auto-reply outside business hours</h2>
                    <p className="mt-1 text-xs text-gray-500">
                      When enabled, customers who message outside your business hours will receive an away message automatically.
                    </p>
                  </div>
                  <button
                    onClick={() => setArEnabled(!arEnabled)}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${arEnabled ? 'bg-brand' : 'bg-gray-200'}`}
                  >
                    <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${arEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                </div>

                {arEnabled && (
                  <div className="mt-4">
                    <label className="text-sm font-medium text-gray-700">Away message</label>
                    <textarea
                      value={arAwayMessage}
                      onChange={(e) => setArAwayMessage(e.target.value)}
                      rows={3}
                      className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                      placeholder="Thanks for your message! We're currently closed..."
                    />
                  </div>
                )}
              </div>

              {/* Business hours grid */}
              {arEnabled && (
                <div className="rounded-xl border border-gray-100 bg-white p-6">
                  <h2 className="text-sm font-bold text-gray-900">Business Hours</h2>
                  <p className="mt-1 text-xs text-gray-500">Set the hours when your bot is active. Outside these hours, the away message will be sent.</p>

                  {/* Timezone */}
                  <div className="mt-4">
                    <label className="text-sm font-medium text-gray-700">Timezone</label>
                    <select
                      value={arTimezone}
                      onChange={(e) => setArTimezone(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                    >
                      <option value="Africa/Lagos">Africa/Lagos (WAT)</option>
                      <option value="Africa/Johannesburg">Africa/Johannesburg (SAST)</option>
                      <option value="Africa/Nairobi">Africa/Nairobi (EAT)</option>
                      <option value="Africa/Cairo">Africa/Cairo (EET)</option>
                      <option value="Africa/Accra">Africa/Accra (GMT)</option>
                      <option value="Europe/London">Europe/London (GMT/BST)</option>
                      <option value="Europe/Paris">Europe/Paris (CET)</option>
                      <option value="America/New_York">America/New_York (EST)</option>
                      <option value="America/Chicago">America/Chicago (CST)</option>
                      <option value="America/Los_Angeles">America/Los_Angeles (PST)</option>
                      <option value="Asia/Dubai">Asia/Dubai (GST)</option>
                      <option value="Asia/Kolkata">Asia/Kolkata (IST)</option>
                      <option value="Asia/Singapore">Asia/Singapore (SGT)</option>
                      <option value="Pacific/Auckland">Pacific/Auckland (NZST)</option>
                    </select>
                  </div>

                  {/* Days grid */}
                  <div className="mt-4 space-y-2">
                    {DAYS.map((day) => (
                      <div key={day} className="flex items-center gap-3">
                        <button
                          onClick={() => setArHours(prev => ({ ...prev, [day]: { ...prev[day], enabled: !prev[day].enabled } }))}
                          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${arHours[day]?.enabled ? 'bg-brand' : 'bg-gray-200'}`}
                        >
                          <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform ${arHours[day]?.enabled ? 'translate-x-4' : 'translate-x-0'}`} />
                        </button>
                        <span className="w-10 text-sm font-medium text-gray-700">{DAY_LABELS[day]}</span>
                        {arHours[day]?.enabled ? (
                          <div className="flex items-center gap-2">
                            <input
                              type="time"
                              value={arHours[day]?.open || '09:00'}
                              onChange={(e) => setArHours(prev => ({ ...prev, [day]: { ...prev[day], open: e.target.value } }))}
                              className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                            />
                            <span className="text-xs text-gray-400">to</span>
                            <input
                              type="time"
                              value={arHours[day]?.close || '17:00'}
                              onChange={(e) => setArHours(prev => ({ ...prev, [day]: { ...prev[day], close: e.target.value } }))}
                              className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                            />
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">Closed</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Instant reply */}
              <div className="rounded-xl border border-gray-100 bg-white p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-bold text-gray-900">Instant reply during business hours</h2>
                    <p className="mt-1 text-xs text-gray-500">
                      Send an automatic acknowledgment when a customer first messages you.
                    </p>
                  </div>
                  <button
                    onClick={() => setArInstantEnabled(!arInstantEnabled)}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${arInstantEnabled ? 'bg-brand' : 'bg-gray-200'}`}
                  >
                    <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${arInstantEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                </div>

                {arInstantEnabled && (
                  <div className="mt-4">
                    <label className="text-sm font-medium text-gray-700">Instant reply message</label>
                    <textarea
                      value={arInstantMessage}
                      onChange={(e) => setArInstantMessage(e.target.value)}
                      rows={2}
                      className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                      placeholder="Hi! Thanks for reaching out. We'll be with you shortly."
                    />
                  </div>
                )}
              </div>

              {/* Save button */}
              <div className="flex items-center gap-3">
                <button
                  onClick={handleSaveAutoReply}
                  disabled={arSaving}
                  className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
                >
                  {arSaving ? 'Saving...' : 'Save Changes'}
                </button>
                {arSaved && <span className="text-sm text-green-600">Saved!</span>}
              </div>
            </>
          )}
        </div>
              </div>
            )}
          </div>
          <div>
            <button onClick={() => toggleSection('notifications')} className="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3.5 hover:bg-gray-50 transition shadow-sm cursor-pointer">
              <h3 className="text-sm font-bold text-gray-900">Notifications</h3>
              <svg aria-hidden="true" className={`h-5 w-5 text-brand transition-transform ${openSections.includes('notifications') ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
            {openSections.includes('notifications') && (
              <div className="mt-4">
        {/* Notification Preferences Tab */}
        <div className="mt-6 max-w-xl space-y-6">
          <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
            <h3 className="text-base font-bold text-gray-900 dark:text-gray-100">How do you want to be notified?</h3>
            <p className="mt-1 text-sm text-gray-500">Choose how you&apos;ll hear about new sales, bookings, and orders.</p>

            <div className="mt-6 space-y-5">
              {/* Email */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Email notifications</p>
                  <p className="text-xs text-gray-500">Get an email every time a customer makes a purchase or booking. Free.</p>
                </div>
                <button
                  onClick={() => setNotifEmailEnabled(!notifEmailEnabled)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${notifEmailEnabled ? 'bg-brand' : 'bg-gray-300'}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${notifEmailEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>

              {/* Dashboard Sound */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Dashboard sound alert</p>
                  <p className="text-xs text-gray-500">Play a sound when a new sale comes in (while dashboard is open). Free.</p>
                </div>
                <button
                  onClick={() => setNotifSoundEnabled(!notifSoundEnabled)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${notifSoundEnabled ? 'bg-brand' : 'bg-gray-300'}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${notifSoundEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>

              {/* Balance Reminders */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Balance payment reminders</p>
                  <p className="text-xs text-gray-500">Automatically remind customers about outstanding balances before their appointment or check-in.</p>
                </div>
                <button
                  onClick={() => setBalanceReminders(!balanceReminders)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${balanceReminders ? 'bg-brand' : 'bg-gray-300'}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${balanceReminders ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>

              {/* Payment Links in Reminders */}
              {balanceReminders && (
                <div className="flex items-center justify-between pl-4 border-l-2 border-brand-100">
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Include payment links</p>
                    <p className="text-xs text-gray-500">Add a pay-now link in balance reminder messages so customers can pay instantly.</p>
                  </div>
                  <button
                    onClick={() => setIncludePayLinks(!includePayLinks)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${includePayLinks ? 'bg-brand' : 'bg-gray-300'}`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${includePayLinks ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                </div>
              )}

              {/* WhatsApp */}
              <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-700/30">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">WhatsApp notifications</p>
                    <p className="text-xs text-gray-500">
                      Get a WhatsApp message on your personal phone for every sale.
                      {business.subscription_tier === 'free' ? ' Free tier: 50/month.' : ' Unlimited on your plan.'}
                    </p>
                  </div>
                  <button
                    onClick={() => setNotifWhatsAppEnabled(!notifWhatsAppEnabled)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${notifWhatsAppEnabled ? 'bg-whatsapp' : 'bg-gray-300'}`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${notifWhatsAppEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                </div>

                {notifWhatsAppEnabled && (
                  <div className="mt-4 space-y-3">
                    <div>
                      <label className="text-xs font-medium text-gray-700 dark:text-gray-300">Your personal WhatsApp number</label>
                      <p className="text-[11px] text-gray-400 mb-1">This must be different from your bot number. We&apos;ll send sale alerts here.</p>
                      <PhoneInput
                        value={notifWhatsAppPhone}
                        onChange={setNotifWhatsAppPhone}
                        countryCode={(business.country_code || 'US') as CountryCode}
                      />
                    </div>
                    {business.subscription_tier === 'free' && (
                      <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 px-3 py-2">
                        <p className="text-xs text-amber-700 dark:text-amber-400">
                          {notifMonthlyCount}/50 WhatsApp notifications used this month.
                          {notifMonthlyCount >= 45 && ' Running low — upgrade for unlimited.'}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Save Button */}
            <div className="mt-6 flex items-center gap-3">
              <button
                onClick={async () => {
                  setNotifSaving(true);
                  const supabase = createClient();
                  await supabase.from('whatsapp_config').upsert({
                    business_id: business.id,
                    notify_email_enabled: notifEmailEnabled,
                    notify_sound_enabled: notifSoundEnabled,
                    notify_whatsapp_enabled: notifWhatsAppEnabled,
                    notify_whatsapp_phone: notifWhatsAppPhone.trim() || null,
                    send_balance_reminders: balanceReminders,
                    include_payment_links: includePayLinks,
                  }, { onConflict: 'business_id' });
                  setNotifSaving(false);
                  setNotifSaved(true);
                  setTimeout(() => setNotifSaved(false), 3000);
                }}
                disabled={notifSaving}
                className="rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              >
                {notifSaving ? 'Saving...' : 'Save Preferences'}
              </button>
              {notifSaved && <span className="text-sm text-green-600">Saved!</span>}
            </div>
          </div>

          {/* Info box */}
          <div className="rounded-xl border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-900/20 p-4">
            <p className="text-xs text-blue-700 dark:text-blue-400">
              Dashboard notifications (the bell icon) are always on and free. Email and sound are also free.
              WhatsApp notifications use your plan&apos;s message quota — Free plan gets 50/month, Pro and Premium plans get unlimited.
            </p>
          </div>
        </div>
              </div>
            )}
          </div>
        </div>
  );
}

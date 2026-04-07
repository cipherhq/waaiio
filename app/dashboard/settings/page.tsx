'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useBusiness, useCapabilities } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { BUSINESS_CATEGORIES, CATEGORY_LABELS, PRICING_TIERS, formatCurrency, type BusinessCategoryKey, type CountryCode, type PaymentGatewayName } from '@/lib/constants';
import { getCountry } from '@/lib/countries';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
const DAY_LABELS: Record<string, string> = {
  monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu',
  friday: 'Fri', saturday: 'Sat', sunday: 'Sun',
};

type DaySchedule = { open: string; close: string; closed?: boolean };
type WeekSchedule = Record<string, DaySchedule>;

const DEFAULT_HOURS: WeekSchedule = Object.fromEntries(
  DAYS.map((d) => [d, { open: '09:00', close: '17:00', closed: d === 'sunday' }])
);

export default function SettingsPage() {
  const business = useBusiness();
  const country = (business.country_code || 'NG') as CountryCode;
  const { capabilities } = useCapabilities();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [activeTab, setActiveTab] = useState<'profile' | 'hours' | 'gateway' | 'recurring' | 'queue'>('profile');
  const [recurringEnabled, setRecurringEnabled] = useState(business.recurring_enabled ?? false);
  const [selectedGateway, setSelectedGateway] = useState<string>(business.payment_gateway || 'auto');

  // Queue settings from business.metadata
  const meta = (business.metadata || {}) as Record<string, unknown>;
  const [queueAvgMinutes, setQueueAvgMinutes] = useState<number>((meta.queue_avg_service_minutes as number) || 10);
  const [queueNotifyStaff, setQueueNotifyStaff] = useState<boolean>(meta.queue_notify_staff !== false);
  const [queuePaused, setQueuePaused] = useState<boolean>((meta.queue_paused as boolean) || false);

  const [form, setForm] = useState({
    name: business.name,
    description: business.description || '',
    address: business.address,
    phone: business.phone,
    email: business.email || '',
    deposit_per_guest: business.deposit_per_guest,
  });

  const [hours, setHours] = useState<WeekSchedule>(() => {
    const saved = business.operating_hours as WeekSchedule | null;
    if (saved && Object.keys(saved).length > 0) return { ...DEFAULT_HOURS, ...saved };
    return DEFAULT_HOURS;
  });

  const category = BUSINESS_CATEGORIES.find((c) => c.key === business.category);
  const labels = CATEGORY_LABELS[business.category as BusinessCategoryKey] || CATEGORY_LABELS.other;
  const tier = PRICING_TIERS[business.subscription_tier as keyof typeof PRICING_TIERS];

  async function handleSave() {
    setSaving(true);
    const supabase = createClient();
    await supabase
      .from('businesses')
      .update({
        name: form.name,
        description: form.description || null,
        address: form.address,
        phone: form.phone,
        email: form.email || null,
        deposit_per_guest: form.deposit_per_guest,
      })
      .eq('id', business.id);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function handleSaveHours() {
    setSaving(true);
    const supabase = createClient();
    await supabase
      .from('businesses')
      .update({ operating_hours: hours })
      .eq('id', business.id);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function updateDay(day: string, field: keyof DaySchedule, value: string | boolean) {
    setHours((prev) => ({
      ...prev,
      [day]: { ...prev[day], [field]: value },
    }));
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Settings</h1>

      {/* Tabs */}
      <div className="mt-4 flex gap-1 rounded-lg bg-gray-100 p-1 w-fit">
        <button
          onClick={() => setActiveTab('profile')}
          className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
            activeTab === 'profile' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Profile
        </button>
        <button
          onClick={() => setActiveTab('hours')}
          className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
            activeTab === 'hours' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Operating Hours
        </button>
        {(capabilities.includes('payment') || capabilities.includes('ordering') || capabilities.includes('ticketing') || capabilities.includes('crowdfunding')) && (
          <button
            onClick={() => setActiveTab('gateway')}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
              activeTab === 'gateway' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Payment Gateway
          </button>
        )}
        {(capabilities.includes('payment') || capabilities.includes('crowdfunding')) && (
          <button
            onClick={() => setActiveTab('recurring')}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
              activeTab === 'recurring' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Recurring
          </button>
        )}
        {capabilities.includes('queue') && (
          <button
            onClick={() => setActiveTab('queue')}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
              activeTab === 'queue' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Queue
          </button>
        )}
      </div>

      {activeTab === 'profile' ? (
        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          {/* Business Profile */}
          <div className="lg:col-span-2 space-y-6">
            <div className="rounded-xl border border-gray-100 bg-white p-6">
              <h2 className="text-sm font-semibold text-gray-900">Business Profile</h2>

              <div className="mt-4 space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Business Name</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Description</label>
                  <textarea
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    rows={3}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">Phone</label>
                    <input
                      type="tel"
                      value={form.phone}
                      onChange={(e) => setForm({ ...form, phone: e.target.value })}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">Email</label>
                    <input
                      type="email"
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Address</label>
                  <input
                    type="text"
                    value={form.address}
                    onChange={(e) => setForm({ ...form, address: e.target.value })}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Deposit per {labels.personLabel} ({formatCurrency(0, country).charAt(0)})</label>
                  <input
                    type="number"
                    min={0}
                    value={form.deposit_per_guest}
                    onChange={(e) => setForm({ ...form, deposit_per_guest: Number(e.target.value) })}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
                  <p className="mt-1 text-xs text-gray-400">Set to 0 to disable deposits</p>
                </div>

                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
                >
                  {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Changes'}
                </button>
              </div>
            </div>
          </div>

          {/* Sidebar info */}
          <div className="space-y-6">
            {/* Subscription */}
            <div className="rounded-xl border border-gray-100 bg-white p-6">
              <h2 className="text-sm font-semibold text-gray-900">Subscription</h2>
              <div className="mt-3">
                <span className="inline-flex rounded-full bg-brand-50 px-3 py-1 text-sm font-semibold text-brand">
                  {tier?.name || business.subscription_tier}
                </span>
                {tier?.price != null && tier.price > 0 && (
                  <p className="mt-2 text-sm text-gray-600">
                    {formatCurrency(tier.price, country)}/month
                  </p>
                )}
                <p className="mt-1 text-xs text-gray-400">
                  {tier?.maxBookings === Infinity ? 'Unlimited' : `${tier?.maxBookings || 50} ${labels.entityNamePlural}/month`}
                </p>
              </div>
            </div>

            {/* Business Info */}
            <div className="rounded-xl border border-gray-100 bg-white p-6">
              <h2 className="text-sm font-semibold text-gray-900">Business Info</h2>
              <div className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Category</span>
                  <span className="font-medium text-gray-900">{category?.label || business.category}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">City</span>
                  <span className="font-medium text-gray-900 capitalize">{business.city.replace('_', ' ')}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Status</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${business.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                    {business.status}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Bot Code</span>
                  <code className="font-mono text-xs text-brand">{business.bot_code || '\u2014'}</code>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : activeTab === 'hours' ? (
        /* Operating Hours Tab */
        <div className="mt-6 max-w-xl">
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-semibold text-gray-900">Weekly Schedule</h2>
            <p className="mt-1 text-xs text-gray-500">Set when your business is open. The WhatsApp bot uses these hours to let customers know your availability.</p>

            <div className="mt-5 space-y-3">
              {DAYS.map((day) => {
                const schedule = hours[day];
                const isClosed = schedule?.closed ?? false;
                return (
                  <div key={day} className="flex items-center gap-3">
                    <div className="w-10 text-sm font-medium text-gray-700">{DAY_LABELS[day]}</div>

                    <button
                      onClick={() => updateDay(day, 'closed', !isClosed)}
                      className={`relative h-6 w-11 shrink-0 rounded-full transition ${!isClosed ? 'bg-brand' : 'bg-gray-200'}`}
                    >
                      <div
                        className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition"
                        style={{ left: !isClosed ? '22px' : '2px' }}
                      />
                    </button>

                    {isClosed ? (
                      <span className="text-sm text-gray-400">Closed</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <input
                          type="time"
                          value={schedule?.open || '09:00'}
                          onChange={(e) => updateDay(day, 'open', e.target.value)}
                          className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm outline-none focus:border-brand"
                        />
                        <span className="text-xs text-gray-400">to</span>
                        <input
                          type="time"
                          value={schedule?.close || '17:00'}
                          onChange={(e) => updateDay(day, 'close', e.target.value)}
                          className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm outline-none focus:border-brand"
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <button
              onClick={handleSaveHours}
              disabled={saving}
              className="mt-6 rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Hours'}
            </button>
          </div>
        </div>
      ) : activeTab === 'gateway' ? (
        /* Payment Gateway Tab */
        <div className="mt-6 max-w-xl">
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-semibold text-gray-900">Payment Gateway</h2>
            <p className="mt-1 text-xs text-gray-500">
              Choose which payment gateway to use. &quot;Auto&quot; selects the best gateway for your country.
            </p>

            <div className="mt-5 space-y-2">
              {(['auto', 'paystack', 'stripe', 'flutterwave'] as const).map((gw) => {
                const countryDefault = getCountry(country)?.payment_gateway;
                const gwLabels: Record<string, { name: string; desc: string }> = {
                  auto: { name: 'Auto (Recommended)', desc: `Uses ${countryDefault || 'paystack'} based on your country (${country})` },
                  paystack: { name: 'Paystack', desc: 'Best for Nigeria and Ghana. Supports cards, bank transfer, USSD.' },
                  stripe: { name: 'Stripe', desc: 'Best for US, UK, Canada. Supports cards and wallets.' },
                  flutterwave: { name: 'Flutterwave', desc: 'Supports Africa-wide payments. Cards, mobile money, bank transfer.' },
                };
                const info = gwLabels[gw];
                return (
                  <button
                    key={gw}
                    type="button"
                    onClick={() => setSelectedGateway(gw)}
                    className={`flex w-full items-center gap-3 rounded-lg border-2 p-4 text-left transition ${
                      selectedGateway === gw ? 'border-brand bg-brand-50/50' : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2 ${
                      selectedGateway === gw ? 'border-brand bg-brand' : 'border-gray-300'
                    }`}>
                      {selectedGateway === gw && (
                        <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900">{info.name}</p>
                      <p className="text-xs text-gray-500">{info.desc}</p>
                    </div>
                  </button>
                );
              })}
            </div>

            <button
              onClick={async () => {
                setSaving(true);
                const supabase = createClient();
                await supabase
                  .from('businesses')
                  .update({ payment_gateway: selectedGateway === 'auto' ? null : selectedGateway })
                  .eq('id', business.id);
                setSaving(false);
                setSaved(true);
                setTimeout(() => setSaved(false), 2000);
              }}
              disabled={saving}
              className="mt-6 rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Gateway'}
            </button>
          </div>

          {/* Capabilities link */}
          <div className="mt-4 rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-semibold text-gray-900">Capabilities</h2>
            <p className="mt-1 text-xs text-gray-500">
              Manage which features your business supports (scheduling, payments, ordering, etc.)
            </p>
            <Link
              href="/dashboard/capabilities"
              className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline"
            >
              Manage Capabilities
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          </div>
        </div>
      ) : activeTab === 'recurring' ? (
        /* Recurring Payments Tab */
        <div className="mt-6 max-w-xl">
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-semibold text-gray-900">Recurring Payments</h2>
            <p className="mt-1 text-xs text-gray-500">
              Enable automatic recurring payments so customers can set up weekly or monthly charges (e.g. tithes, memberships, subscriptions).
            </p>

            <div className="mt-5 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-700">Enable Recurring Payments</p>
                <p className="text-xs text-gray-400">
                  {recurringEnabled
                    ? 'Customers will be offered recurring payment setup after each payment.'
                    : 'Recurring payments are currently disabled for this business.'}
                </p>
              </div>
              <button
                onClick={() => setRecurringEnabled(!recurringEnabled)}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${recurringEnabled ? 'bg-brand' : 'bg-gray-200'}`}
              >
                <div
                  className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition"
                  style={{ left: recurringEnabled ? '22px' : '2px' }}
                />
              </button>
            </div>

            {recurringEnabled && (
              <div className="mt-4 rounded-lg border border-blue-100 bg-blue-50 p-4">
                <p className="text-xs text-blue-700">
                  When enabled, customers paying via WhatsApp will be asked if they want to make their payment recurring.
                  You can also share your recurring payment link: <code className="font-mono">/recurring/{business.slug}</code>
                </p>
              </div>
            )}

            <button
              onClick={async () => {
                setSaving(true);
                const supabase = createClient();
                await supabase
                  .from('businesses')
                  .update({ recurring_enabled: recurringEnabled })
                  .eq('id', business.id);
                setSaving(false);
                setSaved(true);
                setTimeout(() => setSaved(false), 2000);
              }}
              disabled={saving}
              className="mt-6 rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Setting'}
            </button>
          </div>

          {/* Link to recurring dashboard */}
          {recurringEnabled && (
            <div className="mt-4 rounded-xl border border-gray-100 bg-white p-6">
              <h2 className="text-sm font-semibold text-gray-900">Manage Subscribers</h2>
              <p className="mt-1 text-xs text-gray-500">View and manage your recurring payment subscribers.</p>
              <Link
                href="/dashboard/recurring"
                className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline"
              >
                View Recurring Dashboard
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </Link>
            </div>
          )}
        </div>
      ) : activeTab === 'queue' ? (
        /* Queue Settings Tab */
        <div className="mt-6 max-w-xl">
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-semibold text-gray-900">Queue Settings</h2>
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
                  value={queueAvgMinutes}
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
      ) : null}
    </div>
  );
}

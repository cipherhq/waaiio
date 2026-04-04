'use client';

import { useEffect, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { BUSINESS_CATEGORIES, PRICING_TIERS, formatCurrency, type CountryCode } from '@/lib/constants';

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
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [activeTab, setActiveTab] = useState<'profile' | 'hours'>('profile');
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
                  <label className="mb-1 block text-sm font-medium text-gray-700">Deposit per Guest ({formatCurrency(0, country).charAt(0)})</label>
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
                  {tier?.maxBookings === Infinity ? 'Unlimited' : `${tier?.maxBookings || 50} bookings/month`}
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
      ) : (
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
      )}
    </div>
  );
}

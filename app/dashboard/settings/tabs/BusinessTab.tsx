'use client';

import { useRef, useState } from 'react';
import { useCategoryConfig } from '@/hooks/useCategoryConfig';
import { getCategoryByKey } from '@/lib/categoryConfig';
import { PRICING_TIERS, formatCurrency } from '@/lib/constants';
import { createClient } from '@/lib/supabase/client';
import { PhoneInput } from '@/components/auth/PhoneInput';
import PlacesAutocomplete from '@/components/ui/PlacesAutocomplete';
import type { SettingsTabProps } from './types';

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

export function BusinessTab({ business, capabilities, country, curr, saving, setSaving, saved, setSaved, openSections, toggleSection }: SettingsTabProps) {
  const meta = (business.metadata || {}) as Record<string, unknown>;

  // Logo upload state
  const [logoUrl, setLogoUrl] = useState(business.logo_url);
  const [uploadingLogo, setUploadingLogo] = useState(false);

  // Bot code editing
  const [editingBotCode, setEditingBotCode] = useState(false);
  const [newBotCode, setNewBotCode] = useState(business.bot_code || '');
  const [botCodeCheckStatus, setBotCodeCheckStatus] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle');
  const [botCodeSaving, setBotCodeSaving] = useState(false);
  const botCodeTimerRef = useRef<NodeJS.Timeout | null>(null);

  function handleBotCodeEdit(value: string) {
    const cleaned = value.toUpperCase().replace(/\s+/g, '-').replace(/[^A-Z0-9-]/g, '').replace(/-+/g, '-').slice(0, 30);
    setNewBotCode(cleaned);
    if (botCodeTimerRef.current) clearTimeout(botCodeTimerRef.current);
    if (!cleaned || cleaned.length < 2 || cleaned === business.bot_code) {
      setBotCodeCheckStatus('idle');
      return;
    }
    setBotCodeCheckStatus('checking');
    botCodeTimerRef.current = setTimeout(async () => {
      const supabase = createClient();
      const { data } = await supabase.from('businesses').select('id').eq('bot_code', cleaned).neq('id', business.id).maybeSingle();
      setBotCodeCheckStatus(data ? 'taken' : 'available');
    }, 400);
  }

  async function saveBotCode() {
    if (!newBotCode || newBotCode.length < 2 || newBotCode === business.bot_code || botCodeCheckStatus === 'taken') return;
    setBotCodeSaving(true);
    const supabase = createClient();
    const { error } = await supabase.from('businesses').update({ bot_code: newBotCode }).eq('id', business.id);
    setBotCodeSaving(false);
    if (!error) {
      setEditingBotCode(false);
      // Refresh — the bot_code comes from the layout server component
      window.location.reload();
    }
  }

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

  const categoryTemplate = getCategoryByKey(business.category);
  const { labels } = useCategoryConfig(business.category);
  const tier = PRICING_TIERS[business.subscription_tier as keyof typeof PRICING_TIERS];

  // Booking settings from business.metadata
  const [slotInterval, setSlotInterval] = useState<number>((meta.slot_interval_minutes as number) || 60);
  const [maxAdvanceDays, setMaxAdvanceDays] = useState<number>((meta.max_advance_days as number) || 30);
  const [maxPartySize, setMaxPartySize] = useState<number>((meta.max_party_size as number) || 20);
  const [dateRangeDays, setDateRangeDays] = useState<number>((meta.date_range_days as number) || 7);
  const [prepayMode, setPrepayMode] = useState<string>((meta.prepay_mode as string) || 'auto');
  const [reminderHours, setReminderHours] = useState<string>(
    (meta.reminder_hours as number[])?.join(', ') || '24, 2'
  );
  const [maxTicketQuantity, setMaxTicketQuantity] = useState<number>((meta.max_ticket_quantity as number) || 10);
  const [specialRequestsEnabled, setSpecialRequestsEnabled] = useState<boolean>(meta.special_requests_enabled !== false);
  const [specialRequestOptions, setSpecialRequestOptions] = useState<string>(
    ((meta.special_request_options as Array<{ id: string; title: string }>)?.map(o => o.title).join('\n')) || ''
  );
  const [preBookingQuestions, setPreBookingQuestions] = useState<Array<{ id: string; question: string; required: boolean }>>(
    (meta.pre_booking_questions as Array<{ id: string; question: string; required: boolean }>) || []
  );

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
    // Validate hours: close must be after open
    for (const day of DAYS) {
      const schedule = hours[day];
      if (schedule && !schedule.closed && schedule.open && schedule.close && schedule.open >= schedule.close) {
        alert(`${DAY_LABELS[day] || day}: closing time must be after opening time`);
        return;
      }
    }
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
        <div className="mt-6 max-w-3xl space-y-4">
          <div>
            <button onClick={() => toggleSection('profile')} className="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3.5 hover:bg-gray-50 transition shadow-sm cursor-pointer">
              <h3 className="text-sm font-bold text-gray-900">Profile</h3>
              <svg aria-hidden="true" className={`h-5 w-5 text-brand transition-transform ${openSections.includes('profile') ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
            {openSections.includes('profile') && (
              <div className="mt-4">
        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          {/* Business Profile */}
          <div className="lg:col-span-2 space-y-6">
            <div className="rounded-xl border border-gray-100 bg-white p-6">
              <h2 className="text-sm font-bold text-gray-900">Business Profile</h2>

              <div className="mt-4 space-y-4">
                {/* Logo Upload */}
                <div>
                  <div className="flex items-center gap-1.5 mb-1">
                    <label className="text-sm font-medium text-gray-700">Business Logo</label>
                    <span className="group relative">
                      <svg aria-hidden="true" className="h-3.5 w-3.5 text-gray-400 cursor-help" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" strokeWidth="2"/><path strokeLinecap="round" d="M12 16v-4m0-4h.01" strokeWidth="2"/></svg>
                      <span className="invisible group-hover:visible absolute left-5 -top-1 z-10 w-52 rounded-lg bg-gray-900 p-2 text-xs text-white shadow-lg">Your logo appears on invoices and your public page. Paid plans only.</span>
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    {logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={logoUrl}
                        alt="Business logo"
                        className="h-12 w-12 rounded-lg border border-gray-200 object-contain"
                      />
                    ) : (
                      <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-dashed border-gray-300 bg-gray-50">
                        <svg aria-hidden="true" className="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                      </div>
                    )}
                    <div>
                      <label className="cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50">
                        {uploadingLogo ? 'Uploading...' : 'Upload Logo'}
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          className="hidden"
                          disabled={uploadingLogo}
                          onChange={async (e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            setUploadingLogo(true);
                            try {
                              const fd = new FormData();
                              fd.append('file', file);
                              fd.append('business_id', business.id);
                              const res = await fetch('/api/business/upload-logo', { method: 'POST', body: fd });
                              const data = await res.json();
                              if (res.ok && data.url) {
                                setLogoUrl(data.url);
                              } else {
                                alert(data.error || 'Upload failed');
                              }
                            } catch {
                              alert('Upload failed');
                            } finally {
                              setUploadingLogo(false);
                              e.target.value = '';
                            }
                          }}
                        />
                      </label>
                      {business.subscription_tier === 'free' && (
                        <p className="mt-1 text-xs text-gray-400">Logo appears on invoices on Pro plan and above</p>
                      )}
                    </div>
                  </div>
                </div>

                <div>
                  <div className="flex items-center gap-1.5 mb-1">
                    <label className="text-sm font-medium text-gray-700">Business Name</label>
                    <span className="group relative">
                      <svg aria-hidden="true" className="h-3.5 w-3.5 text-gray-400 cursor-help" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" strokeWidth="2"/><path strokeLinecap="round" d="M12 16v-4m0-4h.01" strokeWidth="2"/></svg>
                      <span className="invisible group-hover:visible absolute left-5 -top-1 z-10 w-52 rounded-lg bg-gray-900 p-2 text-xs text-white shadow-lg">Displayed on invoices, receipts, and your booking page</span>
                    </span>
                  </div>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
                </div>
                <div>
                  <div className="flex items-center gap-1.5 mb-1">
                    <label className="text-sm font-medium text-gray-700">Description</label>
                    <span className="group relative">
                      <svg aria-hidden="true" className="h-3.5 w-3.5 text-gray-400 cursor-help" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" strokeWidth="2"/><path strokeLinecap="round" d="M12 16v-4m0-4h.01" strokeWidth="2"/></svg>
                      <span className="invisible group-hover:visible absolute left-5 -top-1 z-10 w-52 rounded-lg bg-gray-900 p-2 text-xs text-white shadow-lg">Shown on your public booking page to describe your business</span>
                    </span>
                  </div>
                  <textarea
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    rows={3}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
                </div>
                <div>
                  <div className="flex items-center gap-1.5 mb-1">
                    <label className="text-sm font-medium text-gray-700">Phone</label>
                    <span className="group relative">
                      <svg aria-hidden="true" className="h-3.5 w-3.5 text-gray-400 cursor-help" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" strokeWidth="2"/><path strokeLinecap="round" d="M12 16v-4m0-4h.01" strokeWidth="2"/></svg>
                      <span className="invisible group-hover:visible absolute left-5 -top-1 z-10 w-52 rounded-lg bg-gray-900 p-2 text-xs text-white shadow-lg">Customer-facing contact number with country code</span>
                    </span>
                  </div>
                  <PhoneInput
                    value={form.phone}
                    onChange={(val) => setForm({ ...form, phone: val })}
                    countryCode={country}
                  />
                </div>
                <div>
                  <div className="flex items-center gap-1.5 mb-1">
                    <label className="text-sm font-medium text-gray-700">Email</label>
                    <span className="group relative">
                      <svg aria-hidden="true" className="h-3.5 w-3.5 text-gray-400 cursor-help" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" strokeWidth="2"/><path strokeLinecap="round" d="M12 16v-4m0-4h.01" strokeWidth="2"/></svg>
                      <span className="invisible group-hover:visible absolute left-5 -top-1 z-10 w-52 rounded-lg bg-gray-900 p-2 text-xs text-white shadow-lg">Used for notifications and displayed on invoices</span>
                    </span>
                  </div>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
                </div>
                <div>
                  <div className="flex items-center gap-1.5 mb-1">
                    <label className="text-sm font-medium text-gray-700">Address</label>
                    <span className="group relative">
                      <svg aria-hidden="true" className="h-3.5 w-3.5 text-gray-400 cursor-help" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" strokeWidth="2"/><path strokeLinecap="round" d="M12 16v-4m0-4h.01" strokeWidth="2"/></svg>
                      <span className="invisible group-hover:visible absolute left-5 -top-1 z-10 w-52 rounded-lg bg-gray-900 p-2 text-xs text-white shadow-lg">Your business location shown on the booking page</span>
                    </span>
                  </div>
                  <PlacesAutocomplete
                    value={form.address}
                    onChange={(value) => setForm({ ...form, address: value })}
                    placeholder="Enter your business address"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
                </div>
                <div>
                  <div className="flex items-center gap-1.5 mb-1">
                    <label className="text-sm font-medium text-gray-700">Deposit per {labels.personLabel} ({formatCurrency(0, country).charAt(0)})</label>
                    <span className="group relative">
                      <svg aria-hidden="true" className="h-3.5 w-3.5 text-gray-400 cursor-help" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" strokeWidth="2"/><path strokeLinecap="round" d="M12 16v-4m0-4h.01" strokeWidth="2"/></svg>
                      <span className="invisible group-hover:visible absolute left-5 -top-1 z-10 w-52 rounded-lg bg-gray-900 p-2 text-xs text-white shadow-lg">Upfront charge per guest when booking. Set to 0 to disable</span>
                    </span>
                  </div>
                  <input
                    type="number"
                    min={0}
                    value={form.deposit_per_guest || ''}
                    onChange={(e) => setForm({ ...form, deposit_per_guest: Number(e.target.value) })}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
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
              <h2 className="text-sm font-bold text-gray-900">Subscription</h2>
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
              <h2 className="text-sm font-bold text-gray-900">Business Info</h2>
              <div className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Category</span>
                  <span className="font-medium text-gray-900">{categoryTemplate?.label || business.category}</span>
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
                <div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">WhatsApp Name</span>
                    {!editingBotCode ? (
                      <div className="flex items-center gap-2">
                        <code className="font-mono text-xs text-brand">{business.bot_code || '\u2014'}</code>
                        <button
                          onClick={() => { setEditingBotCode(true); setNewBotCode(business.bot_code || ''); setBotCodeCheckStatus('idle'); }}
                          className="text-xs text-gray-400 hover:text-brand"
                        >
                          Edit
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-gray-400">Editing...</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-gray-400">Customers text this name to reach your business on WhatsApp</p>
                  {editingBotCode && (
                    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                      <p className="mb-2 text-xs font-medium text-amber-800">
                        Changing this will affect your existing QR codes, WhatsApp links, and returning customers who use the current name. Make sure to update your printed materials.
                      </p>
                      <input
                        type="text"
                        value={newBotCode}
                        onChange={(e) => handleBotCodeEdit(e.target.value)}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-xs uppercase outline-none focus:border-brand"
                        placeholder="YOUR-BOT-CODE"
                      />
                      {botCodeCheckStatus === 'checking' && (
                        <p className="mt-1.5 text-xs text-gray-500">Checking...</p>
                      )}
                      {botCodeCheckStatus === 'available' && newBotCode !== business.bot_code && (
                        <p className="mt-1.5 text-xs text-green-600">Available</p>
                      )}
                      {botCodeCheckStatus === 'taken' && (
                        <p className="mt-1.5 text-xs text-red-600">Already taken</p>
                      )}
                      <div className="mt-2 flex gap-2">
                        <button
                          onClick={saveBotCode}
                          disabled={!newBotCode || newBotCode.length < 2 || newBotCode === business.bot_code || botCodeCheckStatus === 'taken' || botCodeSaving}
                          className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
                        >
                          {botCodeSaving ? 'Saving...' : 'Save'}
                        </button>
                        <button
                          onClick={() => setEditingBotCode(false)}
                          className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
              </div>
            )}
          </div>
          <div>
            <button onClick={() => toggleSection('hours')} className="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3.5 hover:bg-gray-50 transition shadow-sm cursor-pointer">
              <h3 className="text-sm font-bold text-gray-900">Operating Hours</h3>
              <svg aria-hidden="true" className={`h-5 w-5 text-brand transition-transform ${openSections.includes('hours') ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
            {openSections.includes('hours') && (
              <div className="mt-4">
        {/* Operating Hours Tab */}
        <div className="mt-6 max-w-xl">
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-bold text-gray-900">Weekly Schedule</h2>
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
              </div>
            )}
          </div>
          <div>
            <button onClick={() => toggleSection('booking')} className="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3.5 hover:bg-gray-50 transition shadow-sm cursor-pointer">
              <h3 className="text-sm font-bold text-gray-900">WhatsApp & Booking</h3>
              <svg aria-hidden="true" className={`h-5 w-5 text-brand transition-transform ${openSections.includes('booking') ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
            {openSections.includes('booking') && (
              <div className="mt-4">
        {/* Bot & Booking Settings Tab */}
        <div className="mt-6 max-w-xl space-y-4">
          {(capabilities.includes('scheduling') || business.flow_type === 'scheduling') && (
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-bold text-gray-900">Scheduling Settings</h2>
            <p className="mt-1 text-xs text-gray-500">Control how customers book appointments through your WhatsApp bot.</p>

            <div className="mt-5 space-y-5">
              {/* Slot Interval */}
              <div>
                <div className="flex items-center gap-1.5">
                  <label className="text-sm font-medium text-gray-700">Time Slot Interval</label>
                  <span className="group relative">
                    <svg aria-hidden="true" className="h-3.5 w-3.5 text-gray-400 cursor-help" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" strokeWidth="2"/><path strokeLinecap="round" d="M12 16v-4m0-4h.01" strokeWidth="2"/></svg>
                    <span className="invisible group-hover:visible absolute left-5 -top-1 z-10 w-52 rounded-lg bg-gray-900 p-2 text-xs text-white shadow-lg">How often time slots appear in the booking menu. E.g. 30 = every 30 minutes.</span>
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  {[15, 30, 45, 60].map(v => (
                    <button
                      key={v}
                      onClick={() => setSlotInterval(v)}
                      className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition ${slotInterval === v ? 'border-brand bg-brand-50 text-brand' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}
                    >
                      {v}min
                    </button>
                  ))}
                  <input
                    type="number"
                    value={slotInterval || ''}
                    onFocus={e => e.target.select()}
                    onChange={e => setSlotInterval(Number(e.target.value) || 60)}
                    min={5}
                    max={240}
                    className="w-20 rounded-lg border border-gray-200 px-2 py-1.5 text-sm outline-none focus:border-brand"
                  />
                </div>
              </div>

              {/* Time Display Format */}
              <div>
                <div className="flex items-center gap-1.5">
                  <label className="text-sm font-medium text-gray-700">Time Format</label>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  {[
                    { value: '12hr', label: '12-hour (2:00 PM)' },
                    { value: '24hr', label: '24-hour (14:00)' },
                  ].map(opt => (
                    <button
                      key={opt.value}
                      onClick={async () => {
                        const supabase = (await import('@/lib/supabase/client')).createClient();
                        const meta = (business as any).metadata || {};
                        await supabase.from('businesses').update({ metadata: { ...meta, time_format: opt.value } }).eq('id', business.id);
                        window.location.reload();
                      }}
                      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                        ((business as any).metadata?.time_format || '12hr') === opt.value
                          ? 'bg-brand text-white'
                          : 'border border-gray-200 text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Max Advance Days */}
              <div>
                <div className="flex items-center gap-1.5">
                  <label className="text-sm font-medium text-gray-700">Max Advance Booking</label>
                  <span className="group relative">
                    <svg aria-hidden="true" className="h-3.5 w-3.5 text-gray-400 cursor-help" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" strokeWidth="2"/><path strokeLinecap="round" d="M12 16v-4m0-4h.01" strokeWidth="2"/></svg>
                    <span className="invisible group-hover:visible absolute left-5 -top-1 z-10 w-52 rounded-lg bg-gray-900 p-2 text-xs text-white shadow-lg">How far in the future customers can book. Set higher for venues (e.g. 365), lower for barbers (e.g. 7).</span>
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <input
                    type="number"
                    value={maxAdvanceDays || ''}
                    onFocus={e => e.target.select()}
                    onChange={e => setMaxAdvanceDays(Number(e.target.value) || 30)}
                    min={1}
                    max={365}
                    className="w-20 rounded-lg border border-gray-200 px-2 py-1.5 text-sm outline-none focus:border-brand"
                  />
                  <span className="text-sm text-gray-500">days</span>
                </div>
              </div>

              {/* Date Range */}
              <div>
                <div className="flex items-center gap-1.5">
                  <label className="text-sm font-medium text-gray-700">Date Picker Range</label>
                  <span className="group relative">
                    <svg aria-hidden="true" className="h-3.5 w-3.5 text-gray-400 cursor-help" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" strokeWidth="2"/><path strokeLinecap="round" d="M12 16v-4m0-4h.01" strokeWidth="2"/></svg>
                    <span className="invisible group-hover:visible absolute left-5 -top-1 z-10 w-52 rounded-lg bg-gray-900 p-2 text-xs text-white shadow-lg">Number of upcoming days shown in the date selector. Max 10 (WhatsApp limit). Customers can also type a date.</span>
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <input
                    type="number"
                    value={dateRangeDays || ''}
                    onFocus={e => e.target.select()}
                    onChange={e => setDateRangeDays(Math.min(10, Number(e.target.value) || 7))}
                    min={3}
                    max={10}
                    className="w-20 rounded-lg border border-gray-200 px-2 py-1.5 text-sm outline-none focus:border-brand"
                  />
                  <span className="text-sm text-gray-500">days shown</span>
                </div>
              </div>

              {/* Max Party Size */}
              <div>
                <div className="flex items-center gap-1.5">
                  <label className="text-sm font-medium text-gray-700">Max Party / Quantity</label>
                  <span className="group relative">
                    <svg aria-hidden="true" className="h-3.5 w-3.5 text-gray-400 cursor-help" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" strokeWidth="2"/><path strokeLinecap="round" d="M12 16v-4m0-4h.01" strokeWidth="2"/></svg>
                    <span className="invisible group-hover:visible absolute left-5 -top-1 z-10 w-52 rounded-lg bg-gray-900 p-2 text-xs text-white shadow-lg">Maximum guests/units a customer can book at once. Set based on your capacity.</span>
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <input
                    type="number"
                    value={maxPartySize || ''}
                    onFocus={e => e.target.select()}
                    onChange={e => setMaxPartySize(Number(e.target.value) || 20)}
                    min={1}
                    max={500}
                    className="w-20 rounded-lg border border-gray-200 px-2 py-1.5 text-sm outline-none focus:border-brand"
                  />
                </div>
              </div>
            </div>
          </div>
          )}

          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-bold text-gray-900">General WhatsApp Settings</h2>
            <p className="mt-1 text-xs text-gray-500">Settings that apply across all bot flows (ordering, ticketing, payments, etc.).</p>

            <div className="mt-5 space-y-5">
              {/* Max Ticket Quantity */}
              <div>
                <div className="flex items-center gap-1.5">
                  <label className="text-sm font-medium text-gray-700">Max Tickets Per Order</label>
                  <span className="group relative">
                    <svg aria-hidden="true" className="h-3.5 w-3.5 text-gray-400 cursor-help" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" strokeWidth="2"/><path strokeLinecap="round" d="M12 16v-4m0-4h.01" strokeWidth="2"/></svg>
                    <span className="invisible group-hover:visible absolute left-5 -top-1 z-10 w-52 rounded-lg bg-gray-900 p-2 text-xs text-white shadow-lg">Maximum tickets a customer can purchase in a single order. Only applies to the ticketing/events flow.</span>
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <input
                    type="number"
                    value={maxTicketQuantity || ''}
                    onFocus={e => e.target.select()}
                    onChange={e => setMaxTicketQuantity(Number(e.target.value) || 10)}
                    min={1}
                    max={100}
                    className="w-20 rounded-lg border border-gray-200 px-2 py-1.5 text-sm outline-none focus:border-brand"
                  />
                </div>
              </div>

              {/* Prepay Mode */}
              <div>
                <div className="flex items-center gap-1.5">
                  <label className="text-sm font-medium text-gray-700">Payment Collection</label>
                  <span className="group relative">
                    <svg aria-hidden="true" className="h-3.5 w-3.5 text-gray-400 cursor-help" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" strokeWidth="2"/><path strokeLinecap="round" d="M12 16v-4m0-4h.01" strokeWidth="2"/></svg>
                    <span className="invisible group-hover:visible absolute left-5 -top-1 z-10 w-56 rounded-lg bg-gray-900 p-2 text-xs text-white shadow-lg">Auto = uses category defaults (salons charge full, restaurants use deposits). Full = always charge full price. Deposit Only = only charge explicit service deposits. Free = no upfront payment.</span>
                  </span>
                </div>
                <div className="mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {[
                    { value: 'auto', label: 'Auto (category default)', desc: 'Uses smart defaults for your business type' },
                    { value: 'full', label: 'Full price upfront', desc: 'Charge entire service price before booking' },
                    { value: 'deposit_only', label: 'Deposit only', desc: 'Only charge if service has explicit deposit' },
                    { value: 'free', label: 'No upfront payment', desc: 'Bookings are free, collect payment later' },
                  ].map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setPrepayMode(opt.value)}
                      className={`rounded-lg border p-3 text-left transition ${prepayMode === opt.value ? 'border-brand bg-brand-50' : 'border-gray-200 hover:border-gray-300'}`}
                    >
                      <p className={`text-sm font-medium ${prepayMode === opt.value ? 'text-brand' : 'text-gray-700'}`}>{opt.label}</p>
                      <p className="mt-0.5 text-xs text-gray-500">{opt.desc}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Reminder Hours */}
              <div>
                <div className="flex items-center gap-1.5">
                  <label className="text-sm font-medium text-gray-700">Reminder Schedule</label>
                  <span className="group relative">
                    <svg aria-hidden="true" className="h-3.5 w-3.5 text-gray-400 cursor-help" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" strokeWidth="2"/><path strokeLinecap="round" d="M12 16v-4m0-4h.01" strokeWidth="2"/></svg>
                    <span className="invisible group-hover:visible absolute left-5 -top-1 z-10 w-52 rounded-lg bg-gray-900 p-2 text-xs text-white shadow-lg">Hours before appointment to send reminders. Comma-separated. E.g. &quot;24, 2&quot; sends reminders 24h and 2h before.</span>
                  </span>
                </div>
                <input
                  type="text"
                  value={reminderHours}
                  onChange={e => setReminderHours(e.target.value)}
                  placeholder="24, 2"
                  className="mt-1.5 w-40 rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-brand"
                />
                <p className="mt-1 text-xs text-gray-400">Hours before booking (comma-separated)</p>
              </div>
            </div>
          </div>

          {/* Special Requests */}
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold text-gray-900">Special Requests</h2>
                <p className="mt-1 text-xs text-gray-500">Quick-reply options shown to customers before confirming their booking.</p>
              </div>
              <button
                onClick={() => setSpecialRequestsEnabled(!specialRequestsEnabled)}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${specialRequestsEnabled ? 'bg-brand' : 'bg-gray-200'}`}
              >
                <div
                  className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left]"
                  style={{ left: specialRequestsEnabled ? '22px' : '2px' }}
                />
              </button>
            </div>

            {specialRequestsEnabled && (
              <div className="mt-4">
                <div className="flex items-center gap-1.5">
                  <label className="text-sm font-medium text-gray-700">Custom Options</label>
                  <span className="group relative">
                    <svg aria-hidden="true" className="h-3.5 w-3.5 text-gray-400 cursor-help" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" strokeWidth="2"/><path strokeLinecap="round" d="M12 16v-4m0-4h.01" strokeWidth="2"/></svg>
                    <span className="invisible group-hover:visible absolute left-5 -top-1 z-10 w-52 rounded-lg bg-gray-900 p-2 text-xs text-white shadow-lg">One option per line (max 2). Leave blank to use category defaults. These become WhatsApp quick-reply buttons.</span>
                  </span>
                </div>
                <textarea
                  value={specialRequestOptions}
                  onChange={e => setSpecialRequestOptions(e.target.value)}
                  placeholder={"Birthday celebration\nWindow seat preferred"}
                  rows={3}
                  className="mt-1.5 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                />
                <p className="mt-1 text-xs text-gray-400">One per line. Leave empty for category defaults. Customers can always type their own.</p>
              </div>
            )}
          </div>

          {/* Pre-Booking Questions */}
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <div>
              <h2 className="text-sm font-bold text-gray-900">Pre-Booking Questions</h2>
              <p className="mt-1 text-xs text-gray-500">Custom questions asked before a booking is confirmed. Answers are saved with the booking.</p>
            </div>
            <div className="mt-4 space-y-2">
              {preBookingQuestions.map((q, i) => (
                <div key={q.id} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={q.question}
                    onChange={e => {
                      const updated = [...preBookingQuestions];
                      updated[i] = { ...updated[i], question: e.target.value };
                      setPreBookingQuestions(updated);
                    }}
                    placeholder="e.g. Do you have any allergies?"
                    className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
                  <label className="flex items-center gap-1 text-xs text-gray-500 shrink-0">
                    <input
                      type="checkbox"
                      checked={q.required !== false}
                      onChange={e => {
                        const updated = [...preBookingQuestions];
                        updated[i] = { ...updated[i], required: e.target.checked };
                        setPreBookingQuestions(updated);
                      }}
                      className="rounded border-gray-300 text-brand focus:ring-brand"
                    />
                    Required
                  </label>
                  <button
                    onClick={() => setPreBookingQuestions(preBookingQuestions.filter((_, j) => j !== i))}
                    className="rounded p-1 text-gray-300 hover:text-red-500 transition"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
              ))}
              {preBookingQuestions.length < 3 && (
                <button
                  onClick={() => setPreBookingQuestions([...preBookingQuestions, { id: `q${Date.now()}`, question: '', required: true }])}
                  className="text-sm font-medium text-brand hover:text-brand-600 transition"
                >
                  + Add Question {preBookingQuestions.length > 0 && `(${preBookingQuestions.length}/3)`}
                </button>
              )}
              {preBookingQuestions.length === 0 && (
                <p className="text-xs text-gray-400">No questions yet. Add up to 3 questions that customers answer before booking.</p>
              )}
            </div>
          </div>

          {/* Save */}
          <button
            onClick={async () => {
              setSaving(true);
              const parsedReminders = reminderHours.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0);
              const parsedOptions = specialRequestOptions.trim()
                ? specialRequestOptions.trim().split('\n').filter(Boolean).slice(0, 2).map((title, i) => ({
                    id: `custom_${i}`,
                    title: title.trim().slice(0, 24),
                  }))
                : [];
              const supabase = createClient();
              await supabase
                .from('businesses')
                .update({
                  metadata: {
                    ...meta,
                    slot_interval_minutes: slotInterval,
                    max_advance_days: maxAdvanceDays,
                    max_party_size: maxPartySize,
                    date_range_days: dateRangeDays,
                    prepay_mode: prepayMode,
                    reminder_hours: parsedReminders.length > 0 ? parsedReminders : [24, 2],
                    max_ticket_quantity: maxTicketQuantity,
                    special_requests_enabled: specialRequestsEnabled,
                    special_request_options: parsedOptions.length > 0 ? parsedOptions : null,
                    pre_booking_questions: preBookingQuestions.filter(q => q.question.trim()).length > 0
                      ? preBookingQuestions.filter(q => q.question.trim())
                      : null,
                  },
                })
                .eq('id', business.id);
              setSaving(false);
              setSaved(true);
              setTimeout(() => setSaved(false), 2000);
            }}
            disabled={saving}
            className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Booking Settings'}
          </button>
        </div>
              </div>
            )}
          </div>
        </div>
  );
}

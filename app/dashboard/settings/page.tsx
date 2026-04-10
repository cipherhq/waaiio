'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
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
  const router = useRouter();
  const curr = formatCurrency(0, country).charAt(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [activeTab, setActiveTab] = useState<'profile' | 'hours' | 'gateway' | 'recurring' | 'queue' | 'shipping' | 'delivery_zones' | 'account'>('profile');

  // Account tab state
  const [downgrading, setDowngrading] = useState(false);
  const [downgraded, setDowngraded] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [recurringEnabled, setRecurringEnabled] = useState(business.recurring_enabled ?? false);
  const [selectedGateway, setSelectedGateway] = useState<string>(business.payment_gateway || 'auto');

  // Queue settings from business.metadata
  const meta = (business.metadata || {}) as Record<string, unknown>;
  const [queueAvgMinutes, setQueueAvgMinutes] = useState<number>((meta.queue_avg_service_minutes as number) || 10);
  const [queueNotifyStaff, setQueueNotifyStaff] = useState<boolean>(meta.queue_notify_staff !== false);
  const [queuePaused, setQueuePaused] = useState<boolean>((meta.queue_paused as boolean) || false);

  // Shipping settings from business.metadata
  const [shippingMode, setShippingMode] = useState<'none' | 'flat' | 'per_product'>((meta.shipping_mode as 'none' | 'flat' | 'per_product') || 'none');
  const [defaultShippingFee, setDefaultShippingFee] = useState<number>((meta.default_shipping_fee as number) || 0);
  const [minOrderAmount, setMinOrderAmount] = useState<number>((meta.min_order_amount as number) || 0);

  // Delivery Zones state
  interface DeliveryZone {
    id?: string;
    name: string;
    price: number;
    estimated_time: string;
    is_negotiable: boolean;
    is_pickup: boolean;
    is_active: boolean;
    sort_order: number;
  }
  const [deliveryZones, setDeliveryZones] = useState<DeliveryZone[]>([]);
  const [zonesLoading, setZonesLoading] = useState(false);
  const [zonesSaving, setZonesSaving] = useState(false);
  const [zonesSaved, setZonesSaved] = useState(false);

  // BYO (Bring Your Own) gateway state
  const [byoEnabled, setByoEnabled] = useState(false);
  const [byoGateway, setByoGateway] = useState<'paystack' | 'flutterwave' | 'stripe'>('paystack');
  const [byoSecretKey, setByoSecretKey] = useState('');
  const [byoPublicKey, setByoPublicKey] = useState('');
  const [byoVerifying, setByoVerifying] = useState(false);
  const [byoError, setByoError] = useState('');
  const [byoCredential, setByoCredential] = useState<{ id: string; gateway: string; verified_at: string; connection_type?: string; connect_account_id?: string } | null>(null);
  const [byoWebhookUrl, setByoWebhookUrl] = useState('');
  const [byoDisconnecting, setByoDisconnecting] = useState(false);
  const [connectingGateway, setConnectingGateway] = useState<string | null>(null);
  const [showFlutterwaveForm, setShowFlutterwaveForm] = useState(false);

  // Paystack inline bank form state
  const [showPaystackForm, setShowPaystackForm] = useState(false);
  const [paystackBanks, setPaystackBanks] = useState<{ code: string; name: string }[]>([]);
  const [paystackBanksLoading, setPaystackBanksLoading] = useState(false);
  const [paystackBankCode, setPaystackBankCode] = useState('');
  const [paystackBankName, setPaystackBankName] = useState('');
  const [paystackAccountNumber, setPaystackAccountNumber] = useState('');
  const [paystackResolvedName, setPaystackResolvedName] = useState('');
  const [paystackStep, setPaystackStep] = useState<'idle' | 'resolving' | 'confirming' | 'creating'>('idle');

  // Load BYO credentials on mount + handle Connect callback URL params
  useEffect(() => {
    async function loadByoCredentials() {
      try {
        const res = await fetch(`/api/settings/payment-credentials?business_id=${business.id}`);
        if (res.ok) {
          const data = await res.json();
          if (data.credentials?.length > 0) {
            const cred = data.credentials[0];
            setByoCredential(cred);
            setByoGateway(cred.gateway);
            setByoEnabled(true);
            setByoWebhookUrl(data.webhookUrl);
          }
        }
      } catch {}
    }
    loadByoCredentials();

    // Check for Connect callback success
    const params = new URLSearchParams(window.location.search);
    if (params.get('connected')) {
      setActiveTab('gateway');
      // Reload credentials after redirect
      setTimeout(() => loadByoCredentials(), 500);
    }
    if (params.get('tab') === 'gateway') {
      setActiveTab('gateway');
    }
  }, [business.id]);

  // Load delivery zones
  useEffect(() => {
    async function loadZones() {
      setZonesLoading(true);
      const supabase = createClient();
      const { data } = await supabase
        .from('delivery_zones')
        .select('*')
        .eq('business_id', business.id)
        .order('sort_order');
      setDeliveryZones((data as DeliveryZone[]) || []);
      setZonesLoading(false);
    }
    loadZones();
  }, [business.id]);

  async function handleSaveZones() {
    setZonesSaving(true);
    const supabase = createClient();

    // Get existing zone IDs
    const { data: existingZones } = await supabase
      .from('delivery_zones')
      .select('id')
      .eq('business_id', business.id);
    const existingIds = new Set((existingZones || []).map(z => z.id));
    const currentIds = new Set(deliveryZones.filter(z => z.id).map(z => z.id));

    // Delete removed zones
    for (const id of existingIds) {
      if (!currentIds.has(id)) {
        await supabase.from('delivery_zones').delete().eq('id', id);
      }
    }

    // Upsert zones
    for (let i = 0; i < deliveryZones.length; i++) {
      const zone = deliveryZones[i];
      const payload = {
        business_id: business.id,
        name: zone.name.trim(),
        price: zone.price || 0,
        estimated_time: zone.estimated_time?.trim() || null,
        is_negotiable: zone.is_negotiable,
        is_pickup: zone.is_pickup,
        is_active: zone.is_active,
        sort_order: i,
      };
      if (zone.id) {
        await supabase.from('delivery_zones').update(payload).eq('id', zone.id);
      } else {
        const { data } = await supabase.from('delivery_zones').insert(payload).select('id').single();
        if (data) {
          const updated = [...deliveryZones];
          updated[i] = { ...updated[i], id: data.id };
          setDeliveryZones(updated);
        }
      }
    }

    setZonesSaving(false);
    setZonesSaved(true);
    setTimeout(() => setZonesSaved(false), 2000);
  }

  async function handleByoVerify() {
    setByoVerifying(true);
    setByoError('');
    try {
      const res = await fetch('/api/settings/payment-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: business.id,
          gateway: byoGateway,
          secret_key: byoSecretKey,
          public_key: byoPublicKey || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setByoError(data.error || 'Verification failed');
        return;
      }
      setByoCredential(data.credential);
      setByoWebhookUrl(data.webhookUrl);
      setByoSecretKey('');
      setByoPublicKey('');
    } catch {
      setByoError('Network error. Please try again.');
    } finally {
      setByoVerifying(false);
    }
  }

  async function handleByoDisconnect() {
    setByoDisconnecting(true);
    try {
      await fetch(`/api/settings/payment-credentials?business_id=${business.id}&gateway=${byoGateway}`, {
        method: 'DELETE',
      });
      setByoCredential(null);
      setByoEnabled(false);
      setByoWebhookUrl('');
    } catch {} finally {
      setByoDisconnecting(false);
    }
  }

  async function handlePaystackExpand() {
    setShowPaystackForm(!showPaystackForm);
    if (!showPaystackForm && paystackBanks.length === 0) {
      setPaystackBanksLoading(true);
      try {
        const res = await fetch(`/api/payouts/banks?gateway=paystack&country=${country}`);
        const data = await res.json();
        if (data.banks) setPaystackBanks(data.banks);
      } catch {} finally {
        setPaystackBanksLoading(false);
      }
    }
  }

  const resolveTimerRef = useRef<NodeJS.Timeout | null>(null);

  function handlePaystackAccountChange(value: string) {
    const cleaned = value.replace(/\D/g, '').slice(0, 10);
    setPaystackAccountNumber(cleaned);
    setPaystackResolvedName('');
    setPaystackStep('idle');

    if (resolveTimerRef.current) clearTimeout(resolveTimerRef.current);

    if (cleaned.length === 10 && paystackBankCode) {
      setPaystackStep('resolving');
      resolveTimerRef.current = setTimeout(async () => {
        try {
          const res = await fetch('/api/payouts/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gateway: 'paystack', bank_code: paystackBankCode, account_number: cleaned }),
          });
          const data = await res.json();
          if (res.ok && data.account_name) {
            setPaystackResolvedName(data.account_name);
            setPaystackStep('confirming');
          } else {
            setByoError(data.error || 'Could not resolve account name');
            setPaystackStep('idle');
          }
        } catch {
          setByoError('Network error resolving account.');
          setPaystackStep('idle');
        }
      }, 500);
    }
  }

  function handlePaystackBankChange(code: string) {
    setPaystackBankCode(code);
    const bank = paystackBanks.find(b => b.code === code);
    setPaystackBankName(bank?.name || '');
    setPaystackResolvedName('');
    setPaystackStep('idle');

    // Re-trigger resolve if account number already filled
    if (paystackAccountNumber.length === 10 && code) {
      handlePaystackAccountChange(paystackAccountNumber);
    }
  }

  async function handlePaystackConfirm() {
    setPaystackStep('creating');
    setByoError('');
    try {
      const res = await fetch('/api/settings/paystack-connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: business.id,
          bank_code: paystackBankCode,
          bank_name: paystackBankName,
          account_number: paystackAccountNumber,
          account_name: paystackResolvedName,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setByoError(data.error || 'Failed to connect Paystack');
        setPaystackStep('confirming');
        return;
      }
      // Success — reload credentials
      const credRes = await fetch(`/api/settings/payment-credentials?business_id=${business.id}`);
      if (credRes.ok) {
        const credData = await credRes.json();
        if (credData.credentials?.length > 0) {
          setByoCredential(credData.credentials[0]);
          setByoGateway(credData.credentials[0].gateway);
          setByoEnabled(true);
          setByoWebhookUrl(credData.webhookUrl);
        }
      }
      setShowPaystackForm(false);
      setPaystackStep('idle');
      setPaystackAccountNumber('');
      setPaystackBankCode('');
      setPaystackResolvedName('');
    } catch {
      setByoError('Network error. Please try again.');
      setPaystackStep('confirming');
    }
  }

  async function handleConnectStripe() {
    setConnectingGateway('stripe');
    setByoError('');
    try {
      const res = await fetch('/api/payouts/stripe-connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: business.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setByoError(data.error || 'Failed to start Stripe Connect');
        return;
      }
      if (data.url) {
        window.location.href = data.url;
      }
    } catch {
      setByoError('Network error. Please try again.');
    } finally {
      setConnectingGateway(null);
    }
  }

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
        {capabilities.includes('ordering') && (
          <button
            onClick={() => setActiveTab('shipping')}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
              activeTab === 'shipping' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Shipping
          </button>
        )}
        {capabilities.includes('ordering') && (
          <button
            onClick={() => setActiveTab('delivery_zones')}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
              activeTab === 'delivery_zones' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Delivery Zones
          </button>
        )}
        <button
          onClick={() => setActiveTab('account')}
          className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
            activeTab === 'account' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Account
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

          {/* BYO Gateway Section */}
          <div className="mt-4 rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-semibold text-gray-900">Use Your Own Gateway</h2>
            <p className="mt-1 text-xs text-gray-500">
              Connect your own payment account. Payments go directly to you, platform fee is auto-deducted.
            </p>

            {byoError && (
              <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3">
                <p className="text-xs text-red-700">{byoError}</p>
              </div>
            )}

            {!byoCredential && (
              <div className="mt-5 space-y-3">
                {/* Paystack — inline bank details */}
                <div className="rounded-lg border-2 border-gray-200">
                  <button
                    onClick={handlePaystackExpand}
                    className="flex w-full items-center gap-3 p-4 text-left transition hover:bg-gray-50"
                  >
                    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-blue-50">
                      <svg className="h-5 w-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-gray-900">Connect with Paystack</p>
                      <p className="text-xs text-gray-500">Enter your bank details. Payments split automatically.</p>
                    </div>
                    <svg className={`h-5 w-5 flex-shrink-0 text-gray-400 transition ${showPaystackForm ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>

                  {showPaystackForm && (
                    <div className="border-t border-gray-200 p-4 space-y-4">
                      {paystackBanksLoading ? (
                        <p className="text-xs text-gray-500">Loading banks...</p>
                      ) : (
                        <>
                          <div>
                            <label className="mb-1 block text-sm font-medium text-gray-700">Bank</label>
                            <select
                              value={paystackBankCode}
                              onChange={(e) => handlePaystackBankChange(e.target.value)}
                              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                            >
                              <option value="">Select your bank</option>
                              {paystackBanks.map((b) => (
                                <option key={b.code} value={b.code}>{b.name}</option>
                              ))}
                            </select>
                          </div>

                          <div>
                            <label className="mb-1 block text-sm font-medium text-gray-700">Account Number</label>
                            <input
                              type="text"
                              inputMode="numeric"
                              value={paystackAccountNumber}
                              onChange={(e) => handlePaystackAccountChange(e.target.value)}
                              placeholder="0123456789"
                              maxLength={10}
                              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand font-mono"
                            />
                          </div>

                          {paystackStep === 'resolving' && (
                            <p className="text-xs text-gray-500">Verifying account...</p>
                          )}

                          {paystackResolvedName && paystackStep !== 'resolving' && (
                            <div className="rounded-lg border border-green-200 bg-green-50 p-3">
                              <p className="text-sm font-medium text-green-800">{paystackResolvedName}</p>
                              <p className="text-xs text-green-600 mt-0.5">Account name verified</p>
                            </div>
                          )}

                          <button
                            onClick={handlePaystackConfirm}
                            disabled={paystackStep !== 'confirming' || !paystackResolvedName}
                            className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
                          >
                            {paystackStep === 'creating' ? 'Connecting...' : 'Confirm & Connect'}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>

                {/* Stripe Connect */}
                <button
                  onClick={handleConnectStripe}
                  disabled={connectingGateway === 'stripe'}
                  className="flex w-full items-center gap-3 rounded-lg border-2 border-gray-200 p-4 text-left transition hover:border-brand hover:bg-brand-50/30 disabled:opacity-60"
                >
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-purple-50">
                    <svg className="h-5 w-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                    </svg>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-900">
                      {connectingGateway === 'stripe' ? 'Connecting...' : 'Connect with Stripe'}
                    </p>
                    <p className="text-xs text-gray-500">One-click setup. Complete onboarding on Stripe to receive payments.</p>
                  </div>
                  <svg className="h-5 w-5 flex-shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>

                {/* Flutterwave — manual key entry */}
                <div className="rounded-lg border-2 border-gray-200">
                  <button
                    onClick={() => setShowFlutterwaveForm(!showFlutterwaveForm)}
                    className="flex w-full items-center gap-3 p-4 text-left transition hover:bg-gray-50"
                  >
                    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-orange-50">
                      <svg className="h-5 w-5 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-gray-900">Flutterwave</p>
                      <p className="text-xs text-gray-500">Enter your API keys manually from your Flutterwave dashboard.</p>
                    </div>
                    <svg className={`h-5 w-5 flex-shrink-0 text-gray-400 transition ${showFlutterwaveForm ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>

                  {showFlutterwaveForm && (
                    <div className="border-t border-gray-200 p-4 space-y-4">
                      <p className="text-xs text-gray-500">
                        Get your API keys from{' '}
                        <a href="https://dashboard.flutterwave.com/settings/apis" target="_blank" rel="noopener noreferrer" className="text-brand underline">
                          Flutterwave Dashboard &rarr; Settings &rarr; API Keys
                        </a>
                      </p>

                      <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">Secret Key</label>
                        <input
                          type="password"
                          value={byoSecretKey}
                          onChange={(e) => { setByoSecretKey(e.target.value); setByoGateway('flutterwave'); }}
                          placeholder="FLWSECK-..."
                          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand font-mono"
                        />
                      </div>

                      <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">Public Key <span className="text-gray-400">(optional)</span></label>
                        <input
                          type="text"
                          value={byoPublicKey}
                          onChange={(e) => setByoPublicKey(e.target.value)}
                          placeholder="FLWPUBK-..."
                          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand font-mono"
                        />
                      </div>

                      <button
                        onClick={() => { setByoGateway('flutterwave'); handleByoVerify(); }}
                        disabled={byoVerifying || !byoSecretKey}
                        className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
                      >
                        {byoVerifying ? 'Verifying...' : 'Verify & Connect'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {byoCredential && (
              <div className="mt-5">
                {/* Connected state */}
                <div className="rounded-lg border border-green-200 bg-green-50 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <svg className="h-5 w-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <p className="text-sm font-semibold text-green-800">
                      {byoCredential.gateway.charAt(0).toUpperCase() + byoCredential.gateway.slice(1)} connected
                      {byoCredential.connection_type === 'connect' && (
                        <span className="ml-2 inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
                          Connect
                        </span>
                      )}
                    </p>
                  </div>
                  <p className="text-xs text-green-700 mb-3">
                    Payments go directly to your {byoCredential.gateway} account. Platform fee is auto-deducted via split.
                  </p>

                  {/* Only show webhook URL for manual BYO mode (Connect uses platform webhook) */}
                  {byoWebhookUrl && byoCredential.connection_type !== 'connect' && (
                    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                      <p className="text-xs font-medium text-amber-800 mb-1">Webhook URL (set this in your {byoCredential.gateway} dashboard):</p>
                      <code className="block text-xs text-amber-900 bg-amber-100 rounded p-2 break-all select-all">
                        {byoWebhookUrl}
                      </code>
                    </div>
                  )}

                  <button
                    onClick={handleByoDisconnect}
                    disabled={byoDisconnecting}
                    className="mt-4 rounded-lg border border-red-200 px-4 py-2 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    {byoDisconnecting ? 'Disconnecting...' : 'Disconnect'}
                  </button>
                </div>
              </div>
            )}
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
      ) : activeTab === 'shipping' ? (
        /* Shipping Settings Tab */
        <div className="mt-6 max-w-xl">
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-semibold text-gray-900">Shipping Settings</h2>
            <p className="mt-1 text-xs text-gray-500">
              Configure how shipping costs are calculated for delivery orders placed via WhatsApp.
            </p>

            <div className="mt-5 space-y-3">
              {([
                { value: 'none', label: 'No shipping cost', desc: 'Customers are not charged for shipping (pickup only, or free delivery).' },
                { value: 'flat', label: 'Flat rate', desc: 'A single shipping fee is added to every delivery order.' },
                { value: 'per_product', label: 'Per product', desc: 'Each product has its own shipping cost. Set it in the product form.' },
              ] as const).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setShippingMode(opt.value)}
                  className={`flex w-full items-center gap-3 rounded-lg border-2 p-4 text-left transition ${
                    shippingMode === opt.value ? 'border-brand bg-brand-50/50' : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2 ${
                    shippingMode === opt.value ? 'border-brand bg-brand' : 'border-gray-300'
                  }`}>
                    {shippingMode === opt.value && (
                      <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">{opt.label}</p>
                    <p className="text-xs text-gray-500">{opt.desc}</p>
                  </div>
                </button>
              ))}
            </div>

            {(shippingMode === 'flat' || shippingMode === 'per_product') && (
              <div className="mt-5">
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  {shippingMode === 'flat' ? 'Flat shipping fee' : 'Default shipping fee'}
                  {' '}({formatCurrency(0, country).charAt(0)})
                </label>
                <div className="relative w-48">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">
                    {formatCurrency(0, country).charAt(0)}
                  </span>
                  <input
                    type="number"
                    min={0}
                    value={defaultShippingFee || ''}
                    onChange={(e) => setDefaultShippingFee(Number(e.target.value) || 0)}
                    placeholder="0"
                    className="w-full rounded-lg border border-gray-200 py-2 pl-7 pr-3 text-sm outline-none focus:border-brand"
                  />
                </div>
                <p className="mt-1 text-xs text-gray-400">
                  {shippingMode === 'flat'
                    ? 'This fee is added to every delivery order.'
                    : 'Used for products that don\u2019t have a per-product shipping cost set.'}
                </p>
              </div>
            )}

            {/* Minimum Order Amount */}
            <div className="mt-6 border-t border-gray-100 pt-5">
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Minimum order amount ({formatCurrency(0, country).charAt(0)})
              </label>
              <div className="relative w-48">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">
                  {formatCurrency(0, country).charAt(0)}
                </span>
                <input
                  type="number"
                  min={0}
                  value={minOrderAmount || ''}
                  onChange={(e) => setMinOrderAmount(Number(e.target.value) || 0)}
                  placeholder="0"
                  className="w-full rounded-lg border border-gray-200 py-2 pl-7 pr-3 text-sm outline-none focus:border-brand"
                />
              </div>
              <p className="mt-1 text-xs text-gray-400">
                Set to 0 for no minimum. Orders below this amount will be asked to add more items.
              </p>
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
                      shipping_mode: shippingMode,
                      default_shipping_fee: defaultShippingFee,
                      min_order_amount: minOrderAmount || 0,
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
              {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Shipping Settings'}
            </button>
          </div>
        </div>
      ) : activeTab === 'delivery_zones' ? (
        /* Delivery Zones Tab */
        <div className="mt-6 max-w-2xl">
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-semibold text-gray-900">Delivery Zones</h2>
            <p className="mt-1 text-xs text-gray-500">
              Define zones with specific delivery prices. When zones are configured, they replace flat shipping for WhatsApp orders.
            </p>

            {zonesLoading ? (
              <div className="mt-6 flex justify-center">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
              </div>
            ) : (
              <div className="mt-5 space-y-3">
                {deliveryZones.map((zone, idx) => (
                  <div key={zone.id || idx} className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="mb-1 block text-xs font-medium text-gray-600">Zone Name</label>
                        <input
                          type="text"
                          value={zone.name}
                          onChange={(e) => {
                            const updated = [...deliveryZones];
                            updated[idx] = { ...updated[idx], name: e.target.value };
                            setDeliveryZones(updated);
                          }}
                          placeholder="e.g. Lagos Island, Mainland"
                          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium text-gray-600">Price ({curr})</label>
                        <div className="relative">
                          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">{curr}</span>
                          <input
                            type="number"
                            min={0}
                            value={zone.price || ''}
                            onChange={(e) => {
                              const updated = [...deliveryZones];
                              updated[idx] = { ...updated[idx], price: Number(e.target.value) || 0 };
                              setDeliveryZones(updated);
                            }}
                            placeholder="0 = Free"
                            className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-7 pr-3 text-sm outline-none focus:border-brand"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <div>
                        <label className="mb-1 block text-xs font-medium text-gray-600">Estimated Time</label>
                        <input
                          type="text"
                          value={zone.estimated_time || ''}
                          onChange={(e) => {
                            const updated = [...deliveryZones];
                            updated[idx] = { ...updated[idx], estimated_time: e.target.value };
                            setDeliveryZones(updated);
                          }}
                          placeholder="e.g. 30-45 mins"
                          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand"
                        />
                      </div>
                      <div className="flex items-end gap-4">
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={zone.is_pickup}
                            onChange={(e) => {
                              const updated = [...deliveryZones];
                              updated[idx] = { ...updated[idx], is_pickup: e.target.checked, price: e.target.checked ? 0 : updated[idx].price };
                              setDeliveryZones(updated);
                            }}
                            className="rounded border-gray-300 text-brand focus:ring-brand"
                          />
                          <span className="text-gray-700">Pickup</span>
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={zone.is_negotiable}
                            onChange={(e) => {
                              const updated = [...deliveryZones];
                              updated[idx] = { ...updated[idx], is_negotiable: e.target.checked };
                              setDeliveryZones(updated);
                            }}
                            className="rounded border-gray-300 text-brand focus:ring-brand"
                          />
                          <span className="text-gray-700">Negotiable</span>
                        </label>
                      </div>
                    </div>

                    <div className="mt-3 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            const updated = [...deliveryZones];
                            updated[idx] = { ...updated[idx], is_active: !updated[idx].is_active };
                            setDeliveryZones(updated);
                          }}
                          className={`relative h-5 w-9 shrink-0 rounded-full transition ${zone.is_active ? 'bg-brand' : 'bg-gray-200'}`}
                        >
                          <div className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition" style={{ left: zone.is_active ? '18px' : '2px' }} />
                        </button>
                        <span className="text-xs text-gray-500">{zone.is_active ? 'Active' : 'Inactive'}</span>
                      </div>
                      <button
                        onClick={() => setDeliveryZones(deliveryZones.filter((_, i) => i !== idx))}
                        className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
                      >
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}

                {deliveryZones.length < 10 && (
                  <button
                    onClick={() => setDeliveryZones([...deliveryZones, {
                      name: '',
                      price: 0,
                      estimated_time: '',
                      is_negotiable: false,
                      is_pickup: false,
                      is_active: true,
                      sort_order: deliveryZones.length,
                    }])}
                    className="w-full rounded-lg border border-dashed border-gray-300 py-3 text-sm font-medium text-gray-500 hover:border-brand hover:text-brand"
                  >
                    + Add Zone
                  </button>
                )}

                {deliveryZones.length === 0 && (
                  <div className="rounded-lg bg-blue-50 p-3">
                    <p className="text-xs text-blue-700">
                      No delivery zones configured. When you add zones, WhatsApp customers will choose a zone instead of flat shipping.
                      Without zones, the existing Shipping settings apply.
                    </p>
                  </div>
                )}

                {deliveryZones.length >= 10 && (
                  <p className="text-xs text-amber-600">Maximum 10 zones (WhatsApp list limit).</p>
                )}
              </div>
            )}

            <button
              onClick={handleSaveZones}
              disabled={zonesSaving}
              className="mt-6 rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {zonesSaving ? 'Saving...' : zonesSaved ? 'Saved!' : 'Save Delivery Zones'}
            </button>
          </div>
        </div>
      ) : activeTab === 'account' ? (
        /* Account Tab */
        <div className="mt-6 max-w-xl space-y-6">
          {/* Cancel Subscription Card */}
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-semibold text-gray-900">Subscription</h2>

            {business.subscription_tier === 'free' ? (
              <div className="mt-3">
                <p className="text-sm text-gray-600">
                  You&apos;re on the <span className="font-semibold">Free</span> plan.
                </p>
                <Link
                  href="/pricing"
                  className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline"
                >
                  Upgrade from the pricing page
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </Link>
              </div>
            ) : (
              <div className="mt-3">
                <p className="text-sm text-gray-600">
                  Current plan:{' '}
                  <span className="font-semibold">{tier?.name || business.subscription_tier}</span>
                  {tier?.price != null && tier.price > 0 && (
                    <span className="text-gray-400"> ({formatCurrency(tier.price, country)}/month)</span>
                  )}
                </p>
                <p className="mt-2 text-xs text-gray-500">
                  Downgrading removes paid-tier benefits and increases platform fees.
                </p>

                {downgraded ? (
                  <p className="mt-4 text-sm font-medium text-green-600">
                    Downgraded to Free plan successfully.
                  </p>
                ) : (
                  <button
                    onClick={async () => {
                      if (!confirm('Are you sure you want to downgrade to the Free plan? You will lose paid-tier benefits.')) return;
                      setDowngrading(true);
                      const supabase = createClient();
                      await supabase
                        .from('businesses')
                        .update({ subscription_tier: 'free' })
                        .eq('id', business.id);
                      setDowngrading(false);
                      setDowngraded(true);
                    }}
                    disabled={downgrading}
                    className="mt-4 rounded-lg border border-gray-300 px-5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {downgrading ? 'Downgrading...' : 'Downgrade to Free'}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Delete Account Card */}
          <div className="rounded-xl border-2 border-red-200 bg-white p-6">
            <h2 className="text-sm font-semibold text-red-600">Danger Zone</h2>
            <p className="mt-2 text-sm text-gray-600">
              Permanently delete your Waaiio account and all associated data. This action cannot be undone.
            </p>

            <div className="mt-4">
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Type <span className="font-semibold">&quot;{business.name}&quot;</span> to confirm:
              </label>
              <input
                type="text"
                value={deleteConfirmName}
                onChange={(e) => {
                  setDeleteConfirmName(e.target.value);
                  setDeleteError('');
                }}
                placeholder={business.name}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-red-300"
              />
            </div>

            {deleteError && (
              <p className="mt-2 text-sm text-red-600">{deleteError}</p>
            )}

            <button
              onClick={async () => {
                setDeleting(true);
                setDeleteError('');
                try {
                  const res = await fetch('/api/account', { method: 'DELETE' });
                  if (!res.ok) {
                    const data = await res.json();
                    setDeleteError(data.error || 'Failed to delete account');
                    setDeleting(false);
                    return;
                  }
                  const supabase = createClient();
                  await supabase.auth.signOut();
                  router.push('/');
                } catch {
                  setDeleteError('Something went wrong. Please try again.');
                  setDeleting(false);
                }
              }}
              disabled={deleteConfirmName !== business.name || deleting}
              className="mt-4 rounded-lg bg-red-600 px-5 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {deleting ? 'Deleting...' : 'Delete My Account'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

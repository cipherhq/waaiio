'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useBusiness, useCapabilities } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { PRICING_TIERS, getPricingTiers, formatCurrency, type CountryCode, type PaymentGatewayName, type SubscriptionTier } from '@/lib/constants';
import { useCategoryConfig } from '@/hooks/useCategoryConfig';
import { PhoneInput } from '@/components/auth/PhoneInput';
import { getCategoryByKey } from '@/lib/categoryConfig';
import { getCountry } from '@/lib/countries';
import {
  CAPABILITIES,
  CAPABILITY_TIER_REQUIREMENTS,
  type CapabilityId,
  TIER_LABELS,
} from '@/lib/capabilities/types';

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
  const [activeTab, setActiveTab] = useState<'profile' | 'hours' | 'booking' | 'gateway' | 'recurring' | 'queue' | 'shipping' | 'delivery_zones' | 'ordering' | 'auto_reply' | 'notifications' | 'account'>('profile');

  // Notification preferences state
  const [notifEmailEnabled, setNotifEmailEnabled] = useState(true);
  const [notifSoundEnabled, setNotifSoundEnabled] = useState(true);
  const [notifWhatsAppEnabled, setNotifWhatsAppEnabled] = useState(false);
  const [notifWhatsAppPhone, setNotifWhatsAppPhone] = useState('');
  const [notifMonthlyCount, setNotifMonthlyCount] = useState(0);
  const [notifSaving, setNotifSaving] = useState(false);
  const [notifSaved, setNotifSaved] = useState(false);

  // Account tab state
  const searchParams = useSearchParams();
  const [downgrading, setDowngrading] = useState(false);
  const [downgraded, setDowngraded] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [upgraded, setUpgraded] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [waChannel, setWaChannel] = useState<{ wa_method: string; channel: { phone_number: string; display_name: string; connection_status: string } | null } | null>(null);
  const [waDisconnecting, setWaDisconnecting] = useState(false);
  // Post-upgrade capabilities modal state
  const [showCapModal, setShowCapModal] = useState(false);
  const [upgradedTier, setUpgradedTier] = useState<SubscriptionTier | null>(null);
  const [newCapSelections, setNewCapSelections] = useState<CapabilityId[]>([]);
  const [capSaving, setCapSaving] = useState(false);

  // Logo upload state
  const [logoUrl, setLogoUrl] = useState(business.logo_url);
  const [uploadingLogo, setUploadingLogo] = useState(false);

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

  // T&C checkout setting
  const [requireTerms, setRequireTerms] = useState<boolean>(meta.require_terms_before_payment !== false);
  const [termsText, setTermsText] = useState<string>((meta.terms_text as string) || '');
  const [maxPaymentAmount, setMaxPaymentAmount] = useState<number>((meta.max_payment_amount as number) || 10_000_000);

  // Auto-reply settings (from whatsapp_config)
  const [arEnabled, setArEnabled] = useState(false);
  const [arAwayMessage, setArAwayMessage] = useState('Thanks for your message! We\'re currently closed. We\'ll get back to you during business hours.');
  const [arInstantEnabled, setArInstantEnabled] = useState(true);
  const [arInstantMessage, setArInstantMessage] = useState('Hi! Thanks for reaching out. We\'ll be with you shortly.');
  const [arTimezone, setArTimezone] = useState('Africa/Lagos');
  type ArDaySchedule = { open: string; close: string; enabled: boolean };
  const [arHours, setArHours] = useState<Record<string, ArDaySchedule>>(
    Object.fromEntries(DAYS.map(d => [d, { open: '09:00', close: '17:00', enabled: d !== 'sunday' }]))
  );
  const [arLoading, setArLoading] = useState(true);
  const [arSaving, setArSaving] = useState(false);
  const [arSaved, setArSaved] = useState(false);

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
        .select('notify_email_enabled, notify_sound_enabled, notify_whatsapp_enabled, notify_whatsapp_phone, notify_monthly_count')
        .eq('business_id', business.id)
        .maybeSingle();
      if (data) {
        setNotifEmailEnabled(data.notify_email_enabled !== false);
        setNotifSoundEnabled(data.notify_sound_enabled !== false);
        setNotifWhatsAppEnabled(data.notify_whatsapp_enabled ?? false);
        setNotifWhatsAppPhone(data.notify_whatsapp_phone || '');
        setNotifMonthlyCount(data.notify_monthly_count || 0);
      }
    }
    loadNotifPrefs();
  }, [business.id]);

  // Load WhatsApp channel info
  useEffect(() => {
    fetch(`/api/settings/whatsapp-channel?business_id=${business.id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setWaChannel(data); })
      .catch(() => {});
  }, [business.id]);

  // Localized pricing tiers for upgrade cards
  const localTiers = getPricingTiers(country);

  // Verify payment after returning from gateway
  useEffect(() => {
    if (searchParams.get('upgraded') !== 'true') return;
    const reference = searchParams.get('reference') || searchParams.get('trxref');
    const targetPlan = (searchParams.get('plan') || 'growth') as SubscriptionTier;
    setActiveTab('account');
    setVerifying(true);

    fetch('/api/onboarding/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_id: business.id, plan: targetPlan, reference }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.status === 'success') {
          setUpgraded(true);
          // Show capabilities modal with newly unlocked capabilities
          const previousTier = (business.subscription_tier || 'free') as SubscriptionTier;
          const newTier = (data.plan || targetPlan) as SubscriptionTier;
          const tierRank: Record<string, number> = { free: 0, growth: 1, business: 2 };

          const newlyUnlocked = CAPABILITIES.filter(cap => {
            const reqTier = CAPABILITY_TIER_REQUIREMENTS[cap.id];
            const wasAvailable = tierRank[previousTier] >= tierRank[reqTier];
            const nowAvailable = tierRank[newTier] >= tierRank[reqTier];
            return nowAvailable && !wasAvailable;
          }).map(cap => cap.id);

          if (newlyUnlocked.length > 0) {
            setUpgradedTier(newTier);
            setNewCapSelections([...newlyUnlocked]);
            setShowCapModal(true);
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        setVerifying(false);
        // Clean URL params
        window.history.replaceState({}, '', '/dashboard/settings');
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleUpgrade(plan: SubscriptionTier) {
    setUpgrading(true);
    try {
      const res = await fetch('/api/onboarding/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: business.id,
          plan,
          callback: `/dashboard/settings?upgraded=true&plan=${plan}`,
        }),
      });
      const data = await res.json();
      if (data.authorization_url) {
        window.location.href = data.authorization_url;
      } else {
        setUpgrading(false);
      }
    } catch {
      setUpgrading(false);
    }
  }

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

  const categoryTemplate = getCategoryByKey(business.category);
  const { labels } = useCategoryConfig(business.category);
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
      <div className="relative mt-4">
        <div className="flex gap-1 overflow-x-auto scrollbar-hide rounded-lg bg-gray-100 p-1">
          <button
            onClick={() => setActiveTab('profile')}
            className={`shrink-0 rounded-md px-4 py-2.5 text-sm font-medium transition ${
              activeTab === 'profile' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Profile
          </button>
          <button
            onClick={() => setActiveTab('hours')}
            className={`shrink-0 rounded-md px-4 py-2.5 text-sm font-medium transition ${
              activeTab === 'hours' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Operating Hours
          </button>
          <button
            onClick={() => setActiveTab('booking')}
            className={`shrink-0 rounded-md px-4 py-2.5 text-sm font-medium transition ${
              activeTab === 'booking' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Bot & Booking
          </button>
          {(capabilities.includes('payment') || capabilities.includes('ordering') || capabilities.includes('ticketing') || capabilities.includes('crowdfunding')) && (
            <button
              onClick={() => setActiveTab('gateway')}
              className={`shrink-0 rounded-md px-4 py-2.5 text-sm font-medium transition ${
                activeTab === 'gateway' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Payment Gateway
            </button>
          )}
          {(capabilities.includes('payment') || capabilities.includes('crowdfunding')) && (
            <button
              onClick={() => setActiveTab('recurring')}
              className={`shrink-0 rounded-md px-4 py-2.5 text-sm font-medium transition ${
                activeTab === 'recurring' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Recurring
            </button>
          )}
          {capabilities.includes('queue') && (
            <button
              onClick={() => setActiveTab('queue')}
              className={`shrink-0 rounded-md px-4 py-2.5 text-sm font-medium transition ${
                activeTab === 'queue' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Queue
            </button>
          )}
          {capabilities.includes('ordering') && (
            <button
              onClick={() => setActiveTab('shipping')}
              className={`shrink-0 rounded-md px-4 py-2.5 text-sm font-medium transition ${
                activeTab === 'shipping' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Shipping
            </button>
          )}
          {capabilities.includes('ordering') && (
            <button
              onClick={() => setActiveTab('delivery_zones')}
              className={`shrink-0 rounded-md px-4 py-2.5 text-sm font-medium transition ${
                activeTab === 'delivery_zones' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Delivery Zones
            </button>
          )}
          {capabilities.includes('ordering') && (
            <button
              onClick={() => setActiveTab('ordering')}
              className={`shrink-0 rounded-md px-4 py-2.5 text-sm font-medium transition ${
                activeTab === 'ordering' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Ordering
            </button>
          )}
          <button
            onClick={() => setActiveTab('auto_reply')}
            className={`shrink-0 rounded-md px-4 py-2.5 text-sm font-medium transition ${
              activeTab === 'auto_reply' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Auto Reply
          </button>
          <button
            onClick={() => setActiveTab('notifications')}
            className={`shrink-0 rounded-md px-4 py-2.5 text-sm font-medium transition ${
              activeTab === 'notifications' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Notifications
          </button>
          <button
            onClick={() => setActiveTab('account')}
            className={`shrink-0 rounded-md px-4 py-2.5 text-sm font-medium transition ${
              activeTab === 'account' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Account
          </button>
        </div>
        <div className="pointer-events-none absolute right-0 top-0 h-full w-8 bg-gradient-to-l from-gray-100 to-transparent rounded-r-lg" />
      </div>

      {activeTab === 'profile' ? (
        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          {/* Business Profile */}
          <div className="lg:col-span-2 space-y-6">
            <div className="rounded-xl border border-gray-100 bg-white p-6">
              <h2 className="text-sm font-semibold text-gray-900">Business Profile</h2>

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
                  <input
                    type="text"
                    value={form.address}
                    onChange={(e) => setForm({ ...form, address: e.target.value })}
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
      ) : activeTab === 'booking' ? (
        /* Bot & Booking Settings Tab */
        <div className="mt-6 max-w-xl space-y-4">
          {(capabilities.includes('scheduling') || business.flow_type === 'scheduling') && (
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-semibold text-gray-900">Scheduling Settings</h2>
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
            <h2 className="text-sm font-semibold text-gray-900">General Bot Settings</h2>
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
                <h2 className="text-sm font-semibold text-gray-900">Special Requests</h2>
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
                        <svg aria-hidden="true" className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                      <svg aria-hidden="true" className="h-5 w-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-gray-900">Connect with Paystack</p>
                      <p className="text-xs text-gray-500">Enter your bank details. Payments split automatically.</p>
                    </div>
                    <svg aria-hidden="true" className={`h-5 w-5 flex-shrink-0 text-gray-400 transition ${showPaystackForm ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                    <svg aria-hidden="true" className="h-5 w-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                    </svg>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-900">
                      {connectingGateway === 'stripe' ? 'Connecting...' : 'Connect with Stripe'}
                    </p>
                    <p className="text-xs text-gray-500">One-click setup. Complete onboarding on Stripe to receive payments.</p>
                  </div>
                  <svg aria-hidden="true" className="h-5 w-5 flex-shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                      <svg aria-hidden="true" className="h-5 w-5 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-gray-900">Flutterwave</p>
                      <p className="text-xs text-gray-500">Enter your API keys manually from your Flutterwave dashboard.</p>
                    </div>
                    <svg aria-hidden="true" className={`h-5 w-5 flex-shrink-0 text-gray-400 transition ${showFlutterwaveForm ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                    <svg aria-hidden="true" className="h-5 w-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
              <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          </div>

          {/* Checkout Settings */}
          <div className="mt-4 rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-semibold text-gray-900">Checkout Settings</h2>
            <p className="mt-1 text-xs text-gray-500">Configure the customer checkout experience</p>

            {/* T&C Toggle */}
            <div className="mt-4 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-1.5">
                  <p className="text-sm font-medium text-gray-700">Terms & Conditions</p>
                  <span className="group relative">
                    <svg aria-hidden="true" className="h-3.5 w-3.5 text-gray-400 cursor-help" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" strokeWidth="2"/><path strokeLinecap="round" d="M12 16v-4m0-4h.01" strokeWidth="2"/></svg>
                    <span className="invisible group-hover:visible absolute left-5 -top-1 z-10 w-52 rounded-lg bg-gray-900 p-2 text-xs text-white shadow-lg">When enabled, customers must accept terms before paying. Applies to all flows (booking, ordering, ticketing, etc.)</span>
                  </span>
                </div>
                <p className="text-xs text-gray-400">
                  {requireTerms
                    ? 'Customers must accept terms before payment.'
                    : 'Terms acceptance is disabled — customers go straight to payment.'}
                </p>
              </div>
              <button
                onClick={() => setRequireTerms(!requireTerms)}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${requireTerms ? 'bg-brand' : 'bg-gray-200'}`}
              >
                <div
                  className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left]"
                  style={{ left: requireTerms ? '22px' : '2px' }}
                />
              </button>
            </div>

            {/* T&C Custom Text */}
            {requireTerms && (
              <div className="mt-4">
                <div className="flex items-center gap-1.5">
                  <label className="text-sm font-medium text-gray-700">Custom Terms Text</label>
                  <span className="group relative">
                    <svg aria-hidden="true" className="h-3.5 w-3.5 text-gray-400 cursor-help" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" strokeWidth="2"/><path strokeLinecap="round" d="M12 16v-4m0-4h.01" strokeWidth="2"/></svg>
                    <span className="invisible group-hover:visible absolute left-5 -top-1 z-10 w-56 rounded-lg bg-gray-900 p-2 text-xs text-white shadow-lg">Custom message shown before payment. Leave blank for the default terms. Supports WhatsApp formatting (*bold*, _italic_).</span>
                  </span>
                </div>
                <textarea
                  value={termsText}
                  onChange={e => setTermsText(e.target.value)}
                  placeholder="Leave blank for default terms. E.g.: By paying, you agree to our cancellation policy. No refunds within 24 hours of appointment."
                  rows={3}
                  className="mt-1.5 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                />
              </div>
            )}

            {/* Max Payment Amount */}
            <div className="mt-4 border-t border-gray-100 pt-4">
              <div className="flex items-center gap-1.5">
                <label className="text-sm font-medium text-gray-700">Maximum Payment Amount</label>
                <span className="group relative">
                  <svg aria-hidden="true" className="h-3.5 w-3.5 text-gray-400 cursor-help" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" strokeWidth="2"/><path strokeLinecap="round" d="M12 16v-4m0-4h.01" strokeWidth="2"/></svg>
                  <span className="invisible group-hover:visible absolute left-5 -top-1 z-10 w-52 rounded-lg bg-gray-900 p-2 text-xs text-white shadow-lg">Maximum single payment a customer can make via WhatsApp. Prevents accidental large payments.</span>
                </span>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <input
                  type="number"
                  value={maxPaymentAmount || ''}
                  onFocus={e => e.target.select()}
                  onChange={e => setMaxPaymentAmount(Number(e.target.value) || 10_000_000)}
                  min={1000}
                  className="w-40 rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-brand"
                />
              </div>
            </div>

            {/* Save Checkout Settings */}
            <button
              onClick={async () => {
                setSaving(true);
                const supabase = createClient();
                await supabase
                  .from('businesses')
                  .update({
                    metadata: {
                      ...meta,
                      require_terms_before_payment: requireTerms,
                      terms_text: termsText.trim() || null,
                      max_payment_amount: maxPaymentAmount,
                    },
                  })
                  .eq('id', business.id);
                setSaving(false);
                setSaved(true);
                setTimeout(() => setSaved(false), 2000);
              }}
              disabled={saving}
              className="mt-5 rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Checkout Settings'}
            </button>
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
                <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                      <svg aria-hidden="true" className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                    placeholder="Enter amount"
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
                  placeholder="Enter amount"
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
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                        <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
      ) : activeTab === 'ordering' ? (
        /* Ordering Tab */
        <div className="mt-6 max-w-xl">
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-semibold text-gray-900">Ordering Settings</h2>
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
            <h2 className="text-sm font-semibold text-gray-900">Custom Orders</h2>
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
      ) : activeTab === 'auto_reply' ? (
        /* Auto Reply & Business Hours Tab */
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
                    <h2 className="text-sm font-semibold text-gray-900">Auto-reply outside business hours</h2>
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
                  <h2 className="text-sm font-semibold text-gray-900">Business Hours</h2>
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
                    <h2 className="text-sm font-semibold text-gray-900">Instant reply during business hours</h2>
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
      ) : activeTab === 'notifications' ? (
        /* Notification Preferences Tab */
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
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${notifWhatsAppEnabled ? 'bg-[#25D366]' : 'bg-gray-300'}`}
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
      ) : activeTab === 'account' ? (
        /* Account Tab */
        <div className="mt-6 max-w-xl space-y-6">
          {/* Subscription & Upgrade */}
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-semibold text-gray-900">Subscription</h2>

            {verifying && (
              <div className="mt-4 flex items-center gap-2 rounded-lg bg-blue-50 p-3">
                <svg aria-hidden="true" className="h-4 w-4 animate-spin text-blue-600" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span className="text-sm text-blue-700">Verifying your payment...</span>
              </div>
            )}

            {upgraded && (
              <div className="mt-4 rounded-lg bg-green-50 p-4">
                <p className="text-sm font-medium text-green-700">
                  Upgraded successfully!
                </p>
                {upgradedTier && (
                  <button
                    onClick={() => setShowCapModal(true)}
                    className="mt-2 text-sm font-semibold text-brand hover:underline"
                  >
                    Configure new capabilities &rarr;
                  </button>
                )}
                {!upgradedTier && (
                  <p className="mt-1 text-xs text-green-600">
                    Refresh the page to see your new features.
                  </p>
                )}
              </div>
            )}

            {!verifying && !upgraded && (
              <>
                <p className="mt-3 text-sm text-gray-600">
                  Current plan:{' '}
                  <span className="font-semibold">{tier?.name || business.subscription_tier}</span>
                  {tier?.price != null && tier.price > 0 && (
                    <span className="text-gray-400"> ({formatCurrency(tier.price, country)}/month)</span>
                  )}
                </p>

                {/* Upgrade cards */}
                {business.subscription_tier !== 'business' && (
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {(['growth', 'business'] as SubscriptionTier[])
                      .filter((p) => {
                        if (business.subscription_tier === 'free') return true;
                        if (business.subscription_tier === 'growth') return p === 'business';
                        return false;
                      })
                      .map((p) => {
                        const t = localTiers[p];
                        return (
                          <div key={p} className="rounded-lg border border-gray-200 p-4">
                            <h3 className="text-sm font-semibold text-gray-900">{t.name}</h3>
                            <p className="mt-1 text-lg font-bold text-gray-900">
                              {formatCurrency(t.price, country)}
                              <span className="text-sm font-normal text-gray-500">/month</span>
                            </p>
                            <ul className="mt-3 space-y-1.5">
                              {t.features.slice(0, 4).map((f) => (
                                <li key={f} className="flex items-start gap-1.5 text-xs text-gray-600">
                                  <svg aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                  </svg>
                                  {f}
                                </li>
                              ))}
                            </ul>
                            <button
                              onClick={() => handleUpgrade(p)}
                              disabled={upgrading}
                              className="mt-4 w-full rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
                            >
                              {upgrading ? 'Redirecting...' : `Upgrade to ${t.name}`}
                            </button>
                          </div>
                        );
                      })}
                  </div>
                )}

                {business.subscription_tier === 'business' && (
                  <p className="mt-3 text-xs text-gray-500">You&apos;re on the highest plan.</p>
                )}

                {/* Downgrade */}
                {business.subscription_tier !== 'free' && (
                  <div className="mt-4 border-t border-gray-100 pt-4">
                    <p className="text-xs text-gray-500">
                      Downgrading removes paid-tier benefits and increases platform fees.
                    </p>
                    {downgraded ? (
                      <p className="mt-3 text-sm font-medium text-green-600">
                        Downgraded to Free plan successfully.
                      </p>
                    ) : (
                      <button
                        onClick={async () => {
                          if (!confirm('Are you sure you want to downgrade to the Free plan? You will lose paid-tier benefits and capabilities that require Pro or Premium plans.')) return;
                          setDowngrading(true);
                          const supabase = createClient();
                          // Update subscription tier
                          await supabase
                            .from('businesses')
                            .update({ subscription_tier: 'free' })
                            .eq('id', business.id);
                          // Remove capabilities that require a higher tier
                          const freeCaps: CapabilityId[] = (Object.entries(CAPABILITY_TIER_REQUIREMENTS) as [CapabilityId, string][])
                            .filter(([, tier]) => tier === 'free')
                            .map(([cap]) => cap);
                          const currentCaps = capabilities || [];
                          const capsToRemove = currentCaps.filter((c: string) => !freeCaps.includes(c as CapabilityId));
                          if (capsToRemove.length > 0) {
                            await supabase
                              .from('business_capabilities')
                              .delete()
                              .eq('business_id', business.id)
                              .in('capability', capsToRemove);
                          }
                          setDowngrading(false);
                          setDowngraded(true);
                        }}
                        disabled={downgrading}
                        className="mt-3 rounded-lg border border-gray-300 px-5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      >
                        {downgrading ? 'Downgrading...' : 'Downgrade to Free'}
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* WhatsApp Number */}
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-semibold text-gray-900">WhatsApp Number</h2>

            {!waChannel ? (
              <p className="mt-3 text-sm text-gray-400">Loading...</p>
            ) : waChannel.channel ? (
              <>
                <div className="mt-3 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Phone</span>
                    <span className="font-medium text-gray-900 font-mono">{waChannel.channel.phone_number}</span>
                  </div>
                  {waChannel.channel.display_name && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">Display name</span>
                      <span className="font-medium text-gray-900">{waChannel.channel.display_name}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-gray-500">Status</span>
                    <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Connected</span>
                  </div>
                </div>

                <p className="mt-4 text-xs text-gray-500">
                  To change your WhatsApp number, disconnect first, then reconnect with your new number from the onboarding page.
                </p>

                <div className="mt-3 flex gap-2">
                  <Link
                    href="/dashboard/whatsapp/connect"
                    className="rounded-lg border border-gray-300 px-4 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Reconnect with new number
                  </Link>
                  <button
                    onClick={async () => {
                      if (!confirm('Disconnect your dedicated WhatsApp number? You will revert to the shared platform number.')) return;
                      setWaDisconnecting(true);
                      try {
                        await fetch(`/api/settings/whatsapp-channel?business_id=${business.id}`, { method: 'DELETE' });
                        setWaChannel({ wa_method: 'shared', channel: null });
                      } catch {} finally {
                        setWaDisconnecting(false);
                      }
                    }}
                    disabled={waDisconnecting}
                    className="rounded-lg border border-red-200 px-4 py-2 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    {waDisconnecting ? 'Disconnecting...' : 'Disconnect'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="mt-3 text-sm text-gray-600">
                  Using the shared platform number. Customers reach your business by texting your bot code.
                </p>
                <Link
                  href="/dashboard/whatsapp/connect"
                  className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline"
                >
                  Connect your own WhatsApp number
                  <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </Link>
              </>
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

      {/* ── Post-Upgrade Capabilities Modal ── */}
      {showCapModal && upgradedTier && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-bold text-gray-900">
                  New capabilities unlocked!
                </h2>
                <p className="mt-1 text-sm text-gray-500">
                  Your {TIER_LABELS[upgradedTier]} plan includes these new features.
                  Toggle on the ones you want to activate.
                </p>
              </div>
              <button
                onClick={() => setShowCapModal(false)}
                className="ml-4 rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="mt-5 space-y-2">
              {(() => {
                const previousTier = (business.subscription_tier || 'free') as SubscriptionTier;
                const tierRank: Record<string, number> = { free: 0, growth: 1, business: 2 };

                return CAPABILITIES.filter(cap => {
                  const reqTier = CAPABILITY_TIER_REQUIREMENTS[cap.id];
                  const wasAvailable = tierRank[previousTier] >= tierRank[reqTier];
                  const nowAvailable = tierRank[upgradedTier] >= tierRank[reqTier];
                  return nowAvailable && !wasAvailable;
                }).map(cap => {
                  const isOn = newCapSelections.includes(cap.id);
                  return (
                    <button
                      key={cap.id}
                      type="button"
                      onClick={() => {
                        setNewCapSelections(prev =>
                          prev.includes(cap.id)
                            ? prev.filter(c => c !== cap.id)
                            : [...prev, cap.id]
                        );
                      }}
                      className={`flex w-full items-center gap-4 rounded-xl border-2 p-4 text-left transition ${
                        isOn ? 'border-brand bg-brand-50/50' : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <span className="text-2xl">{cap.icon}</span>
                      <div className="min-w-0 flex-1">
                        <h3 className="text-sm font-bold text-gray-900">{cap.label}</h3>
                        <p className="mt-0.5 text-xs text-gray-500">{cap.description}</p>
                      </div>
                      <div className={`flex h-6 w-11 flex-shrink-0 items-center rounded-full transition ${
                        isOn ? 'bg-brand' : 'bg-gray-200'
                      }`}>
                        <div className={`h-5 w-5 rounded-full bg-white shadow transition ${
                          isOn ? 'translate-x-5' : 'translate-x-0.5'
                        }`} />
                      </div>
                    </button>
                  );
                });
              })()}
            </div>

            <div className="mt-6 flex items-center gap-3">
              <button
                onClick={async () => {
                  setCapSaving(true);
                  const supabase = createClient();
                  // Merge: keep existing enabled + add newly selected
                  const allEnabled = [...new Set([...capabilities, ...newCapSelections])];
                  // Disable all first
                  await supabase
                    .from('business_capabilities')
                    .update({ is_enabled: false })
                    .eq('business_id', business.id);
                  // Enable selected
                  for (const cap of allEnabled) {
                    await supabase
                      .from('business_capabilities')
                      .upsert(
                        { business_id: business.id, capability: cap, is_enabled: true },
                        { onConflict: 'business_id,capability' },
                      );
                  }
                  setCapSaving(false);
                  setShowCapModal(false);
                }}
                disabled={capSaving}
                className="flex-1 rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
              >
                {capSaving ? 'Saving...' : 'Save & Continue'}
              </button>
              <button
                onClick={() => setShowCapModal(false)}
                className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
              >
                Skip
              </button>
            </div>

            <p className="mt-3 text-xs text-gray-400">
              You can always change these later in the Capabilities page.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

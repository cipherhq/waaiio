'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/constants';
import { getCountry } from '@/lib/countries';
import { createClient } from '@/lib/supabase/client';
import type { SettingsTabProps } from './types';

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

export function PaymentsTab({ business, capabilities, country, curr, saving, setSaving, saved, setSaved, openSections, toggleSection }: SettingsTabProps) {
  const meta = (business.metadata || {}) as Record<string, unknown>;

  const [recurringEnabled, setRecurringEnabled] = useState(business.recurring_enabled ?? false);
  const [selectedGateway, setSelectedGateway] = useState<string>(business.payment_gateway || 'auto');

  // Payment channels state
  const ALL_CHANNELS = ['card', 'bank_transfer', 'ussd', 'qr', 'mobile_money'] as const;
  type PaymentChannel = (typeof ALL_CHANNELS)[number];
  const rawChannels = (business as Record<string, unknown>).payment_channels as PaymentChannel[] | null;
  const [paymentChannels, setPaymentChannels] = useState<Set<PaymentChannel>>(
    () => new Set(rawChannels && rawChannels.length > 0 ? rawChannels : ALL_CHANNELS)
  );
  const [channelsSaving, setChannelsSaving] = useState(false);

  // Shipping settings from business.metadata
  const [shippingMode, setShippingMode] = useState<'none' | 'flat' | 'per_product'>((meta.shipping_mode as 'none' | 'flat' | 'per_product') || 'none');
  const [defaultShippingFee, setDefaultShippingFee] = useState<number>((meta.default_shipping_fee as number) || 0);
  const [minOrderAmount, setMinOrderAmount] = useState<number>((meta.min_order_amount as number) || 0);

  // T&C checkout setting
  const [requireTerms, setRequireTerms] = useState<boolean>(meta.require_terms_before_payment !== false);
  const [termsText, setTermsText] = useState<string>((meta.terms_text as string) || '');
  const [maxPaymentAmount, setMaxPaymentAmount] = useState<number>((meta.max_payment_amount as number) || 10_000_000);

  // Delivery Zones state
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
      // Reload credentials after redirect
      setTimeout(() => loadByoCredentials(), 500);
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

  const CHANNEL_CONFIG: { id: PaymentChannel; label: string; description: string; countries: string[] | null }[] = [
    { id: 'card', label: 'Card (Visa, Mastercard, Verve)', description: 'Accept debit and credit card payments', countries: null },
    { id: 'bank_transfer', label: 'Bank Transfer', description: 'Direct bank transfer payments', countries: ['NG', 'GH'] },
    { id: 'ussd', label: 'USSD', description: 'Pay via USSD short codes', countries: ['NG', 'GH'] },
    { id: 'qr', label: 'QR Code', description: 'Scan-to-pay QR code payments', countries: ['NG'] },
    { id: 'mobile_money', label: 'Mobile Money', description: 'Mobile money wallet payments', countries: ['GH'] },
  ];

  const visibleChannels = CHANNEL_CONFIG.filter(ch => ch.countries === null || ch.countries.includes(country));

  async function handleToggleChannel(channelId: PaymentChannel) {
    const updated = new Set(paymentChannels);
    if (updated.has(channelId)) {
      // Prevent disabling the last channel
      const wouldRemain = [...updated].filter(c => c !== channelId && visibleChannels.some(vc => vc.id === c));
      if (wouldRemain.length === 0) return;
      updated.delete(channelId);
    } else {
      updated.add(channelId);
    }
    setPaymentChannels(updated);

    // If all visible channels are enabled, save null (backward compatible)
    const allEnabled = visibleChannels.every(vc => updated.has(vc.id));
    const channelsToSave = allEnabled ? null : [...updated];

    setChannelsSaving(true);
    const supabase = createClient();
    await supabase
      .from('businesses')
      .update({ payment_channels: channelsToSave })
      .eq('id', business.id);
    setChannelsSaving(false);
  }

  return (
        <div className="mt-6 max-w-3xl space-y-4">
          {capabilities.includes('payment') || capabilities.includes('ordering') || capabilities.includes('ticketing') || capabilities.includes('crowdfunding') && (
            <div>
              <button onClick={() => toggleSection('payment_methods')} className="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3.5 hover:bg-gray-50 transition shadow-sm cursor-pointer">
                <h3 className="text-sm font-bold text-gray-900">Accepted Payment Methods</h3>
                <svg aria-hidden="true" className={`h-5 w-5 text-brand transition-transform ${openSections.includes('payment_methods') ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
              </button>
              {openSections.includes('payment_methods') && (
                <div className="mt-4">
                  <div className="mt-6 max-w-xl">
                    <div className="rounded-xl border border-gray-100 bg-white p-6">
                      <h2 className="text-sm font-bold text-gray-900">Accepted Payment Methods</h2>
                      <p className="mt-1 text-xs text-gray-500">
                        Choose which payment methods your customers can use. All methods are enabled by default.
                      </p>

                      <div className="mt-5 space-y-3">
                        {visibleChannels.map((channel) => {
                          const isEnabled = paymentChannels.has(channel.id);
                          const isLastEnabled = isEnabled && [...paymentChannels].filter(c => visibleChannels.some(vc => vc.id === c)).length === 1;
                          return (
                            <label
                              key={channel.id}
                              className={`flex items-start gap-3 rounded-lg border-2 p-4 transition cursor-pointer ${
                                isEnabled ? 'border-brand bg-brand-50/50' : 'border-gray-200 hover:border-gray-300'
                              } ${isLastEnabled ? 'opacity-75' : ''}`}
                            >
                              <input
                                type="checkbox"
                                checked={isEnabled}
                                disabled={isLastEnabled || channelsSaving}
                                onChange={() => handleToggleChannel(channel.id)}
                                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                              />
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-gray-900">{channel.label}</p>
                                <p className="text-xs text-gray-500">{channel.description}</p>
                              </div>
                              {isLastEnabled && (
                                <span className="ml-auto shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                                  Required
                                </span>
                              )}
                            </label>
                          );
                        })}
                      </div>

                      {channelsSaving && (
                        <p className="mt-3 text-xs text-gray-400">Saving...</p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
          {capabilities.includes('payment') || capabilities.includes('ordering') || capabilities.includes('ticketing') || capabilities.includes('crowdfunding') && (
            <div>
              <button onClick={() => toggleSection('gateway')} className="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3.5 hover:bg-gray-50 transition shadow-sm cursor-pointer">
                <h3 className="text-sm font-bold text-gray-900">Payment Gateway</h3>
                <svg aria-hidden="true" className={`h-5 w-5 text-brand transition-transform ${openSections.includes('gateway') ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
              </button>
              {openSections.includes('gateway') && (
                <div className="mt-4">
        {/* Payment Gateway Tab */}
        <div className="mt-6 max-w-xl">
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-bold text-gray-900">Payment Gateway</h2>
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
            <h2 className="text-sm font-bold text-gray-900">Use Your Own Gateway</h2>
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
                      <p className="text-sm font-bold text-gray-900">Connect with Paystack</p>
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
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-brand-50">
                    <svg aria-hidden="true" className="h-5 w-5 text-brand-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                    </svg>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-gray-900">
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
                      <p className="text-sm font-bold text-gray-900">Flutterwave</p>
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
            <h2 className="text-sm font-bold text-gray-900">Capabilities</h2>
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
            <h2 className="text-sm font-bold text-gray-900">Checkout Settings</h2>
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
                </div>
              )}
            </div>
          )}
          {capabilities.includes('payment') || capabilities.includes('crowdfunding') && (
            <div>
              <button onClick={() => toggleSection('recurring')} className="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3.5 hover:bg-gray-50 transition shadow-sm cursor-pointer">
                <h3 className="text-sm font-bold text-gray-900">Recurring Payments</h3>
                <svg aria-hidden="true" className={`h-5 w-5 text-brand transition-transform ${openSections.includes('recurring') ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
              </button>
              {openSections.includes('recurring') && (
                <div className="mt-4">
        {/* Recurring Payments Tab */}
        <div className="mt-6 max-w-xl">
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-bold text-gray-900">Recurring Payments</h2>
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
              <h2 className="text-sm font-bold text-gray-900">Manage Subscribers</h2>
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
                </div>
              )}
            </div>
          )}
          {capabilities.includes('ordering') && (
            <div>
              <button onClick={() => toggleSection('shipping')} className="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3.5 hover:bg-gray-50 transition shadow-sm cursor-pointer">
                <h3 className="text-sm font-bold text-gray-900">Shipping</h3>
                <svg aria-hidden="true" className={`h-5 w-5 text-brand transition-transform ${openSections.includes('shipping') ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
              </button>
              {openSections.includes('shipping') && (
                <div className="mt-4">
        {/* Shipping Settings Tab */}
        <div className="mt-6 max-w-xl">
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-bold text-gray-900">Shipping Settings</h2>
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
                </div>
              )}
            </div>
          )}
          {capabilities.includes('ordering') && (
            <div>
              <button onClick={() => toggleSection('delivery_zones')} className="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3.5 hover:bg-gray-50 transition shadow-sm cursor-pointer">
                <h3 className="text-sm font-bold text-gray-900">Delivery Zones</h3>
                <svg aria-hidden="true" className={`h-5 w-5 text-brand transition-transform ${openSections.includes('delivery_zones') ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
              </button>
              {openSections.includes('delivery_zones') && (
                <div className="mt-4">
        {/* Delivery Zones Tab */}
        <div className="mt-6 max-w-2xl">
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-bold text-gray-900">Delivery Zones</h2>
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
                </div>
              )}
            </div>
          )}
        </div>
  );
}

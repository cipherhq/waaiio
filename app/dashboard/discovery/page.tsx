'use client';

import { useState, useEffect, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { PageHelp } from '@/components/dashboard/PageHelp';
import AddressAutocomplete from '@/components/ui/AddressAutocomplete';

interface DiscoveryConfig {
  discovery_enabled: boolean;
  discovery_description: string;
  discovery_keywords: string[];
  price_band: string | null;
  supports_delivery: boolean;
  delivery_radius_km: number | null;
  max_group_size: number | null;
  latitude: number | null;
  longitude: number | null;
  address: string;
  city: string;
  description: string | null;
  operating_hours: Record<string, unknown> | null;
  logo_url: string | null;
}

const DEFAULTS: DiscoveryConfig = {
  discovery_enabled: false,
  discovery_description: '',
  discovery_keywords: [],
  price_band: null,
  supports_delivery: false,
  delivery_radius_km: null,
  max_group_size: null,
  latitude: null,
  longitude: null,
  address: '',
  city: '',
  description: null,
  operating_hours: null,
  logo_url: null,
};

function calculateCompleteness(config: DiscoveryConfig): { score: number; missing: string[] } {
  const missing: string[] = [];
  if (!config.description) missing.push('Description');
  if (!config.address) missing.push('Address');
  if (!config.operating_hours) missing.push('Business Hours');
  if (!config.discovery_description) missing.push('Discovery Description');
  if (!config.discovery_keywords?.length) missing.push('Keywords');
  if (!config.latitude || !config.longitude) missing.push('Address Verification');
  if (!config.logo_url) missing.push('Logo');

  const total = 7;
  const score = Math.round(((total - missing.length) / total) * 100);
  return { score, missing };
}

export default function DiscoveryPage() {
  const business = useBusiness();
  const supabase = createClient();

  const [config, setConfig] = useState<DiscoveryConfig>(DEFAULTS);
  const [keywordsInput, setKeywordsInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [addressVerified, setAddressVerified] = useState(false);
  const [verifiedAddress, setVerifiedAddress] = useState('');

  const loadConfig = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('businesses')
      .select(
        'discovery_enabled, discovery_description, discovery_keywords, price_band, ' +
        'supports_delivery, delivery_radius_km, max_group_size, latitude, longitude, ' +
        'address, city, description, operating_hours, logo_url'
      )
      .eq('id', business.id)
      .limit(1);

    if (data && data.length > 0) {
      // Cast to bypass generated types — discovery columns added in migration 239
      const row = data[0] as unknown as Record<string, unknown>;
      const keywords = (row.discovery_keywords as string[]) || [];
      const cfg: DiscoveryConfig = {
        discovery_enabled: (row.discovery_enabled as boolean) ?? false,
        discovery_description: (row.discovery_description as string) ?? '',
        discovery_keywords: keywords,
        price_band: (row.price_band as string | null) ?? null,
        supports_delivery: (row.supports_delivery as boolean) ?? false,
        delivery_radius_km: row.delivery_radius_km != null ? Number(row.delivery_radius_km) : null,
        max_group_size: row.max_group_size != null ? Number(row.max_group_size) : null,
        latitude: row.latitude != null ? Number(row.latitude) : null,
        longitude: row.longitude != null ? Number(row.longitude) : null,
        address: (row.address as string) ?? '',
        city: (row.city as string) ?? '',
        description: (row.description as string | null) ?? null,
        operating_hours: (row.operating_hours as Record<string, unknown> | null) ?? null,
        logo_url: (row.logo_url as string | null) ?? null,
      };
      setConfig(cfg);
      setKeywordsInput(keywords.join(', '));
      // If lat/lng already exist, mark as verified
      if (cfg.latitude && cfg.longitude) {
        setAddressVerified(true);
        setVerifiedAddress(cfg.address || 'Previously verified');
      }
    }
    setLoading(false);
  }, [business.id, supabase]);

  useEffect(() => {
    loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business.id]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);

    const keywords = keywordsInput
      .split(',')
      .map(k => k.trim())
      .filter(Boolean);

    const payload = {
      discovery_enabled: config.discovery_enabled,
      discovery_description: config.discovery_description || null,
      discovery_keywords: keywords.length > 0 ? keywords : null,
      price_band: config.price_band || null,
      supports_delivery: config.supports_delivery,
      delivery_radius_km: config.delivery_radius_km,
      max_group_size: config.max_group_size,
      latitude: config.latitude,
      longitude: config.longitude,
      address: config.address || null,
      city: config.city || null,
    };

    await supabase.from('businesses').update(payload).eq('id', business.id);

    setSaving(false);
    setSaved(true);
    setConfig(prev => ({ ...prev, discovery_keywords: keywords }));
    setTimeout(() => setSaved(false), 3000);
  }

  function update<K extends keyof DiscoveryConfig>(key: K, value: DiscoveryConfig[K]) {
    setConfig(prev => ({ ...prev, [key]: value }));
  }

  const { score, missing } = calculateCompleteness(config);

  const inputClass =
    'w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';
  const labelClass = 'mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300';

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
        <div className="flex items-center justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Discovery Profile</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Control how your business appears in Waaiio search results and marketplace
        </p>
        <PageHelp
          pageKey="discovery"
          title="Marketplace Discovery"
          description="Enable discovery to let new customers find you through Waaiio's marketplace. Add keywords that describe your business, set a price band so customers can filter by budget, and verify your address for proximity-based search. The preview card below shows how your listing will appear in search results."
        />
      </div>

      {/* Completeness Score */}
      <div className="mb-6 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Profile Completeness</h2>
          <span className={`text-2xl font-bold ${
            score === 100 ? 'text-green-600' : score >= 70 ? 'text-yellow-600' : 'text-red-600'
          }`}>
            {score}%
          </span>
        </div>
        <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-3 mb-3">
          <div
            className={`h-3 rounded-full transition-all duration-500 ${
              score === 100 ? 'bg-green-500' : score >= 70 ? 'bg-yellow-500' : 'bg-red-500'
            }`}
            style={{ width: `${score}%` }}
          />
        </div>
        {missing.length > 0 && (
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Missing items:</p>
            <div className="flex flex-wrap gap-1.5">
              {missing.map(item => (
                <span
                  key={item}
                  className="inline-flex rounded-full bg-amber-100 dark:bg-amber-900/30 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300"
                >
                  {item}
                </span>
              ))}
            </div>
          </div>
        )}
        {score === 100 && (
          <p className="text-sm text-green-600 dark:text-green-400 font-medium">
            Your discovery profile is complete. You are fully visible in search results.
          </p>
        )}
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        {/* Discovery toggle */}
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
          <label className="flex items-start gap-3 cursor-pointer">
            <div className="relative mt-0.5 flex-shrink-0">
              <input
                type="checkbox"
                checked={config.discovery_enabled}
                onChange={e => update('discovery_enabled', e.target.checked)}
                className="sr-only peer"
              />
              <div className="h-5 w-9 rounded-full bg-gray-300 dark:bg-gray-600 peer-checked:bg-brand-600 transition-colors" />
              <div className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-white">Enable Discovery</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Make your business visible in search results and the marketplace
              </p>
            </div>
          </label>
        </div>

        {/* Profile details */}
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">Profile Details</h2>
          <div className="space-y-4">
            <div>
              <label className={labelClass}>Discovery Description</label>
              <textarea
                value={config.discovery_description}
                onChange={e => update('discovery_description', e.target.value.slice(0, 200))}
                placeholder="A short description of what you offer (max 200 characters)"
                rows={3}
                maxLength={200}
                className={inputClass}
              />
              <p className="mt-1 text-xs text-gray-400">
                {config.discovery_description.length}/200 characters
              </p>
            </div>

            <div>
              <label className={labelClass}>Keywords</label>
              <input
                type="text"
                value={keywordsInput}
                onChange={e => setKeywordsInput(e.target.value)}
                placeholder="e.g. haircuts, braids, locs, styling"
                className={inputClass}
              />
              <p className="mt-1 text-xs text-gray-400">
                Comma-separated keywords to help customers find you
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelClass}>Price Band</label>
                <select
                  value={config.price_band || ''}
                  onChange={e => update('price_band', e.target.value || null)}
                  className={inputClass}
                >
                  <option value="">Not set</option>
                  <option value="budget">Budget</option>
                  <option value="mid">Mid-range</option>
                  <option value="premium">Premium</option>
                  <option value="luxury">Luxury</option>
                </select>
              </div>
              <div>
                <label className={labelClass}>Max Group Size</label>
                <input
                  type="number"
                  min={1}
                  value={config.max_group_size ?? ''}
                  onChange={e => update('max_group_size', e.target.value ? parseInt(e.target.value) : null)}
                  placeholder="e.g. 50"
                  className={inputClass}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Delivery */}
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">Delivery</h2>
          <div className="space-y-4">
            <label className="flex items-start gap-3 cursor-pointer">
              <div className="relative mt-0.5 flex-shrink-0">
                <input
                  type="checkbox"
                  checked={config.supports_delivery}
                  onChange={e => update('supports_delivery', e.target.checked)}
                  className="sr-only peer"
                />
                <div className="h-5 w-9 rounded-full bg-gray-300 dark:bg-gray-600 peer-checked:bg-brand-600 transition-colors" />
                <div className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-white">Supports Delivery</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">Show a delivery badge on your listing</p>
              </div>
            </label>
            {config.supports_delivery && (
              <div>
                <label className={labelClass}>Delivery Radius (km)</label>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={config.delivery_radius_km ?? ''}
                  onChange={e => update('delivery_radius_km', e.target.value ? parseFloat(e.target.value) : null)}
                  placeholder="e.g. 15"
                  className={inputClass}
                />
              </div>
            )}
          </div>
        </div>

        {/* Location — Address Autocomplete */}
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">Location</h2>
          <div className="space-y-4">
            <div>
              <label className={labelClass}>Business Address</label>
              <AddressAutocomplete
                defaultValue={config.address}
                countryCode={business.country_code || undefined}
                className="!rounded-lg !border-gray-300 dark:!border-gray-600 !bg-white dark:!bg-gray-800 !text-sm !text-gray-900 dark:!text-white"
                onSelect={(result) => {
                  setConfig(prev => ({
                    ...prev,
                    address: result.formattedAddress || result.address,
                    city: result.city,
                    latitude: result.latitude ?? null,
                    longitude: result.longitude ?? null,
                  }));
                  if (result.latitude && result.longitude) {
                    setAddressVerified(true);
                    setVerifiedAddress(result.formattedAddress || result.address);
                  }
                }}
                onManualChange={(value) => {
                  setConfig(prev => ({ ...prev, address: value }));
                  // Invalidate verification if address is manually changed
                  setAddressVerified(false);
                  setVerifiedAddress('');
                }}
              />
              <p className="mt-1 text-xs text-gray-400">
                Start typing and select your address from the suggestions to verify your location
              </p>
            </div>

            {/* Verification status */}
            {addressVerified ? (
              <div className="flex items-start gap-2 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 px-4 py-3">
                <span className="text-green-600 dark:text-green-400 text-lg leading-none mt-0.5">&#10003;</span>
                <div>
                  <p className="text-sm font-medium text-green-700 dark:text-green-300">Address verified</p>
                  <p className="text-xs text-green-600 dark:text-green-400">{verifiedAddress}</p>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-4 py-3">
                <span className="text-amber-500 text-lg leading-none mt-0.5">!</span>
                <div>
                  <p className="text-sm font-medium text-amber-700 dark:text-amber-300">Address not verified</p>
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    Select an address from the autocomplete suggestions to verify your location for proximity search
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Preview card */}
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-6">
          <h2 className="mb-3 text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
            Search Result Preview
          </h2>
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-brand-100 dark:bg-brand-900 text-brand font-bold">
                {business.name.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-900 dark:text-white">{business.name}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 capitalize">
                  {business.category.replace(/_/g, ' ')}
                </p>
                {config.discovery_description && (
                  <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                    {config.discovery_description}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {config.price_band && (
                    <span className="inline-flex rounded-full bg-brand-100 dark:bg-brand-900/30 px-2 py-0.5 text-xs font-medium text-brand-700 dark:text-brand-300 capitalize">
                      {config.price_band === 'mid' ? 'Mid-range' : config.price_band}
                    </span>
                  )}
                  {config.supports_delivery && (
                    <span className="inline-flex rounded-full bg-green-100 dark:bg-green-900/30 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-300">
                      Delivery
                    </span>
                  )}
                  {config.max_group_size && (
                    <span className="inline-flex rounded-full bg-blue-100 dark:bg-blue-900/30 px-2 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-300">
                      Up to {config.max_group_size} guests
                    </span>
                  )}
                  {config.discovery_keywords.length > 0 && config.discovery_keywords.slice(0, 3).map(kw => (
                    <span key={kw} className="inline-flex rounded-full bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs text-gray-600 dark:text-gray-300">
                      {kw}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Save */}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-brand-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving...' : 'Save Profile'}
          </button>
          {saved && (
            <span className="text-sm text-green-600 dark:text-green-400">Profile saved</span>
          )}
        </div>
      </form>
    </div>
  );
}

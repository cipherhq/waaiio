'use client';

import { useEffect, useRef, useState } from 'react';
import { TaxRateInput } from '../TaxRateInput';
import { DEFAULT_TAX_SETTINGS, parseTaxSettings } from '@/lib/tax/settings';

type Settings = ReturnType<typeof parseTaxSettings>;

export function MerchantTaxSettings({ businessId }: { businessId: string }) {
  const generation = useRef(0);
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_TAX_SETTINGS });
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    generation.current++;
    setLoading(true); setLoaded(false); setSaving(false); setError(''); setSaved(false);
    fetch(`/api/businesses/${businessId}/tax-settings`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Unable to load tax settings. Please try again.');
        const body = await response.json();
        if (!controller.signal.aborted) { setSettings(parseTaxSettings(body.settings)); setLoaded(true); }
      })
      .catch(err => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); generation.current++; };
  }, [businessId]);

  async function save() {
    const requestGeneration = generation.current;
    setSaving(true); setError(''); setSaved(false);
    try {
      const response = await fetch(`/api/businesses/${businessId}/tax-settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parseTaxSettings(settings)),
      });
      const body = await response.json();
      if (requestGeneration !== generation.current) return;
      if (!response.ok) throw new Error(body.error || 'Unable to save tax settings');
      setSettings(parseTaxSettings(body.settings)); setSaved(true);
    } catch (err) { if (requestGeneration === generation.current) setError(err instanceof Error ? err.message : 'Unable to save tax settings'); }
    finally { if (requestGeneration === generation.current) setSaving(false); }
  }
  function change(patch: Partial<Settings>) { setSettings(current => ({ ...current, ...patch })); setSaved(false); }
  const inputClass = 'mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-gray-900';
  return <section className="mt-6 max-w-3xl rounded-xl border border-gray-200 bg-white p-5" aria-labelledby="merchant-tax-heading">
    <h2 id="merchant-tax-heading" className="text-lg font-semibold text-gray-900">Sales tax</h2>
    <p className="mt-1 text-sm text-gray-600">Enter the tax that applies to your sales. You are responsible for selecting the correct rates and paying the tax authority. Changes apply to new purchases.</p>
    {loading ? <p role="status" className="mt-4 text-sm">Loading tax settings…</p> : <>
      <fieldset disabled={saving || !loaded} className="mt-4 space-y-4">
        <label className="flex items-center gap-2"><input type="checkbox" checked={settings.enabled} onChange={e => change({ enabled: e.target.checked })} />Charge sales tax</label>
        <p className="text-sm text-gray-600">Tax is supported for itemized invoices, orders and supported service bookings. While tax is enabled, standalone payment links and unsupported paid table or event purchases are unavailable. Use an itemized invoice or order for those charges.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm">Tax name<input className={inputClass} maxLength={60} value={settings.label} onChange={e => change({ label: e.target.value })} /></label>
          <label className="text-sm">Default rate (%)<TaxRateInput className={inputClass} rateBps={settings.rate_bps} onRateChange={rate => change({ rate_bps: rate ?? Number.NaN })} /></label>
        </div>
        <label className="block text-sm">Product and service prices<select className={inputClass} value={settings.price_mode} onChange={e => change({ price_mode: e.target.value as Settings['price_mode'] })}>
          <option value="exclusive">Add tax to the listed price</option><option value="inclusive">Listed price already includes tax</option>
        </select></label>
        <label className="block text-sm">Delivery tax<select className={inputClass} value={settings.delivery_treatment} onChange={e => change({ delivery_treatment: e.target.value as Settings['delivery_treatment'] })}>
          <option value="exempt">Exempt</option><option value="override">Use a separate rate</option>
        </select></label>
        {settings.delivery_treatment === 'override' && <div className="space-y-4">
          <label className="block text-sm">Delivery tax name<input className={inputClass} maxLength={60} value={settings.delivery_label} onChange={e => change({ delivery_label: e.target.value })} /></label>
          <label className="block text-sm">Delivery rate (%)<TaxRateInput className={inputClass} rateBps={settings.delivery_rate_bps} onRateChange={rate => change({ delivery_rate_bps: rate ?? Number.NaN })} /></label>
          <label className="block text-sm">Delivery price<select className={inputClass} value={settings.delivery_price_mode} onChange={e => change({ delivery_price_mode: e.target.value as Settings['delivery_price_mode'] })}><option value="exclusive">Add tax</option><option value="inclusive">Includes tax</option></select></label>
        </div>}
      </fieldset>
      <button type="button" disabled={saving || !loaded} onClick={save} className="mt-5 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save tax settings'}</button>
    </>}
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    {saved && <p role="status" className="mt-3 text-sm text-green-700">Tax settings saved.</p>}
  </section>;
}

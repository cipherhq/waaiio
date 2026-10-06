import { FormEvent, useEffect, useMemo, useState } from 'react';
import { adminApiFetch, adminApiGet } from '@/lib/adminApi';
import { CAPABILITIES, CAPABILITY_TIER_REQUIREMENTS, PLAN_LABELS, tierMeetsRequirement, type CapabilityId, type SubscriptionTier } from '@shared/capabilities';

type Stage = 'form' | 'review';
interface QueueItem { id: string; target_email: string; business_id: string | null; status: string; intended_plan: SubscriptionTier; whatsapp_method: string; invite_sent_at: string | null; created_at: string; last_error: string | null }
interface AuthorityOptions {
  countries: Array<{ code: string; name: string; dialing_code: string }>;
  categories: Array<{ key: string; name: string }>;
}
interface FormState {
  owner_first_name: string; owner_last_name: string; owner_email: string; owner_phone: string;
  business_name: string; country: string; category: string; city: string; state: string; postcode: string;
  address: string; business_phone: string; bot_code: string; intended_plan: SubscriptionTier;
  capabilities: CapabilityId[]; whatsapp_method: 'shared' | 'dedicated' | 'coexistence';
}
const initial: FormState = { owner_first_name: '', owner_last_name: '', owner_email: '', owner_phone: '', business_name: '', country: 'NG', category: 'other', city: '', state: '', postcode: '', address: '', business_phone: '', bot_code: '', intended_plan: 'free', capabilities: [], whatsapp_method: 'shared' };

export default function CustomerOnboarding() {
  const [form, setForm] = useState(initial);
  const [stage, setStage] = useState<Stage>('form');
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [options, setOptions] = useState<AuthorityOptions>({ countries: [], categories: [] });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const allowedCapabilities = useMemo(() => CAPABILITIES.filter(cap => tierMeetsRequirement(form.intended_plan, CAPABILITY_TIER_REQUIREMENTS[cap.id])), [form.intended_plan]);

  async function loadQueue() {
    const response = await adminApiGet('/api/admin/onboarding');
    if (response.ok) {
      const payload = await response.json();
      setQueue(payload.onboardings || []);
      setOptions(payload.options || { countries: [], categories: [] });
    }
  }
  useEffect(() => { loadQueue().catch(() => setMessage('Unable to load onboarding queue.')); }, []);
  function set<K extends keyof FormState>(key: K, value: FormState[K]) { setForm(current => ({ ...current, [key]: value })); }
  function review(event: FormEvent) { event.preventDefault(); setMessage(''); setStage('review'); }
  async function create() {
    setBusy(true); setMessage('');
    try {
      const response = await adminApiFetch('/api/admin/onboarding', { ...form, request_key: requestKey });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Onboarding failed');
      setForm(initial); setRequestKey(crypto.randomUUID()); setStage('form'); setMessage('Activation invitation sent. Customer action is now required.'); await loadQueue();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Onboarding failed'); }
    setBusy(false);
  }
  async function action(id: string, actionName: 'resend' | 'cancel' | 'retry' | 'change_plan', extra: Record<string, unknown> = {}) {
    setBusy(true); setMessage('');
    const response = await adminApiFetch(`/api/admin/onboarding/${id}`, { action: actionName, ...extra });
    const result = await response.json();
    setMessage(response.ok ? (actionName === 'resend' ? 'Activation email resent.' : actionName === 'retry' ? 'Provisioning retried.' : actionName === 'change_plan' ? 'Intended plan updated.' : 'Pending onboarding cancelled.') : result.error || 'Action failed');
    await loadQueue(); setBusy(false);
  }

  const field = (label: string, key: keyof FormState, type = 'text', required = true) => <label className="block text-sm font-medium text-gray-700">{label}<input className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" type={type} value={String(form[key])} onChange={event => setForm(current => ({ ...current, [key]: event.target.value }))} required={required} /></label>;
  return <div className="space-y-8">
    <div><h1 className="text-2xl font-bold text-gray-900">Customer onboarding</h1><p className="mt-1 text-sm text-gray-500">Prepare a customer account without impersonation. The customer retains control of credentials, consent, billing, and Meta authorization.</p></div>
    {message && <div role="status" className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">{message}</div>}
    <section className="rounded-xl border border-gray-200 bg-white p-6">
      {stage === 'form' ? <form onSubmit={review} className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2">{field('Owner first name', 'owner_first_name')}{field('Owner last name', 'owner_last_name')}{field('Owner email', 'owner_email', 'email')}{field('Owner phone', 'owner_phone', 'tel', false)}{field('Business name', 'business_name')}{field('Business phone', 'business_phone', 'tel')}<label className="block text-sm font-medium text-gray-700">Country<select aria-label="Country code" className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" value={form.country} onChange={event => set('country', event.target.value)} required>{options.countries.length ? options.countries.map(country => <option key={country.code} value={country.code}>{country.name} ({country.code})</option>) : <option value={form.country}>{form.country}</option>}</select></label><label className="block text-sm font-medium text-gray-700">Category<select aria-label="Category key" className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" value={form.category} onChange={event => set('category', event.target.value)} required>{options.categories.length ? options.categories.map(category => <option key={category.key} value={category.key}>{category.name}</option>) : <option value={form.category}>{form.category}</option>}</select></label>{field('City', 'city')}{field('State', 'state', 'text', false)}{field('Postcode', 'postcode', 'text', false)}{field('Address', 'address')}{field('Bot code (optional)', 'bot_code', 'text', false)}</div>
        <div className="grid gap-4 md:grid-cols-2"><label className="text-sm font-medium text-gray-700">Starting plan<select className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" value={form.intended_plan} onChange={event => { const plan = event.target.value as SubscriptionTier; set('intended_plan', plan); set('capabilities', form.capabilities.filter(cap => tierMeetsRequirement(plan, CAPABILITY_TIER_REQUIREMENTS[cap]))); }}>{Object.entries(PLAN_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><span className="mt-1 block text-xs text-gray-500">Paid selection records intent only; checkout remains customer-owned.</span></label><label className="text-sm font-medium text-gray-700">WhatsApp method<select className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" value={form.whatsapp_method} onChange={event => set('whatsapp_method', event.target.value as FormState['whatsapp_method'])}><option value="shared">Shared number</option><option value="dedicated">Dedicated (customer authorizes)</option><option value="coexistence">Coexistence (customer authorizes)</option></select></label></div>
        <fieldset><legend className="text-sm font-semibold text-gray-800">Capabilities</legend><div className="mt-2 grid gap-2 md:grid-cols-3">{allowedCapabilities.map(cap => <label key={cap.id} className="flex gap-2 rounded-lg border border-gray-200 p-3 text-sm"><input type="checkbox" checked={form.capabilities.includes(cap.id)} onChange={event => set('capabilities', event.target.checked ? [...form.capabilities, cap.id] : form.capabilities.filter(item => item !== cap.id))} /><span>{cap.label}</span></label>)}</div></fieldset>
        <button className="rounded-lg bg-brand px-5 py-2.5 font-semibold text-white">Review onboarding</button>
      </form> : <div className="space-y-5"><div><h2 className="text-lg font-semibold">Review before creation</h2><p className="text-sm text-amber-700">This sends a one-time activation link. No temporary password, paid entitlement, consent, or Meta connection will be created.</p></div><dl className="grid gap-3 rounded-lg bg-gray-50 p-4 text-sm md:grid-cols-2"><div><dt className="text-gray-500">Owner</dt><dd>{form.owner_first_name} {form.owner_last_name} · {form.owner_email}</dd></div><div><dt className="text-gray-500">Business</dt><dd>{form.business_name} · {form.city}, {form.country}</dd></div><div><dt className="text-gray-500">Plan intent</dt><dd>{PLAN_LABELS[form.intended_plan]}</dd></div><div><dt className="text-gray-500">WhatsApp</dt><dd>{form.whatsapp_method}</dd></div><div className="md:col-span-2"><dt className="text-gray-500">Capabilities</dt><dd>{form.capabilities.join(', ') || 'Category defaults'}</dd></div></dl><div className="flex gap-3"><button disabled={busy} onClick={create} className="rounded-lg bg-brand px-5 py-2.5 font-semibold text-white disabled:opacity-50">{busy ? 'Creating…' : 'Create and send invite'}</button><button disabled={busy} onClick={() => setStage('form')} className="rounded-lg border border-gray-300 px-5 py-2.5">Back</button></div></div>}
    </section>
    <section className="rounded-xl border border-gray-200 bg-white"><div className="border-b border-gray-200 p-5"><h2 className="font-semibold text-gray-900">Onboarding queue</h2></div><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-gray-50 text-gray-500"><tr><th className="p-3">Customer</th><th className="p-3">Status</th><th className="p-3">Plan</th><th className="p-3">Created</th><th className="p-3">Actions</th></tr></thead><tbody>{queue.map(item => <tr key={item.id} className="border-t border-gray-100"><td className="p-3">{item.target_email}</td><td className="p-3">{item.status}{item.last_error ? <span className="block text-xs text-red-600">{item.last_error}</span> : null}</td><td className="p-3">{['invite_sent', 'customer_action_required'].includes(item.status) ? <select aria-label={`Intended plan for ${item.target_email}`} disabled={busy} className="rounded border border-gray-300 px-2 py-1" value={item.intended_plan} onChange={event => action(item.id, 'change_plan', { intended_plan: event.target.value })}>{Object.entries(PLAN_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : PLAN_LABELS[item.intended_plan]}</td><td className="p-3">{new Date(item.created_at).toLocaleString()}</td><td className="p-3"><div className="flex gap-2">{item.business_id && <a className="text-brand underline" href={`/businesses?business=${item.business_id}`}>Business</a>}{['invite_sent', 'customer_action_required'].includes(item.status) && <button disabled={busy} className="text-brand underline" onClick={() => action(item.id, 'resend')}>Resend</button>}{item.status === 'failed' && <button disabled={busy} className="text-brand underline" onClick={() => action(item.id, 'retry')}>Retry</button>}{!['active', 'cancelled'].includes(item.status) && <button disabled={busy} className="text-red-600 underline" onClick={() => action(item.id, 'cancel')}>Cancel</button>}</div></td></tr>)}</tbody></table>{queue.length === 0 && <p className="p-6 text-sm text-gray-500">No assisted onboarding records yet.</p>}</div></section>
  </div>;
}

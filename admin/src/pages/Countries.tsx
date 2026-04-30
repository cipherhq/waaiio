import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { loadCountries, invalidateCache, type CountryRow } from '@/lib/countries';
import { logAudit } from '@/lib/auditLog';
import { SummaryCard } from '@/components/SummaryCard';
import { Pagination } from '@/components/Pagination';
import {
  Globe, Plus, Pencil, Trash2, Save, X, CreditCard, CheckCircle, XCircle,
} from 'lucide-react';

const GATEWAYS = ['paystack', 'stripe', 'flutterwave'] as const;
const VERIFICATION_LEVELS = ['unverified', 'basic', 'standard', 'full'] as const;
const PRICING_TIERS = ['free', 'growth', 'business'] as const;

interface FormState {
  code: string;
  name: string;
  flag: string;
  dialing_code: string;
  currency_code: string;
  currency_symbol: string;
  currency_locale: string;
  payment_gateway: string;
  phone_digits: number;
  phone_pattern: string;
  phone_placeholder: string;
  is_active: boolean;
  sort_order: number;
  cities: Record<string, { name: string; neighborhoods: string[] }>;
  pricing: Record<string, { price: number; feeFlat: number }>;
  verification_tiers: Record<string, { label: string; limit: number; requirements: string }>;
  doc_types: { key: string; label: string; desc: string }[];
}

function emptyForm(): FormState {
  return {
    code: '', name: '', flag: '', dialing_code: '+',
    currency_code: '', currency_symbol: '', currency_locale: 'en-US',
    payment_gateway: 'stripe', phone_digits: 10, phone_pattern: '', phone_placeholder: '',
    is_active: true, sort_order: 0,
    cities: {},
    pricing: { free: { price: 0, feeFlat: 0 }, growth: { price: 0, feeFlat: 0 }, business: { price: 0, feeFlat: 0 } },
    verification_tiers: {
      unverified: { label: 'Unverified', limit: 0, requirements: 'Just signed up' },
      basic: { label: 'Basic', limit: 0, requirements: '' },
      standard: { label: 'Standard', limit: 0, requirements: '' },
      full: { label: 'Full', limit: 999999999, requirements: '' },
    },
    doc_types: [],
  };
}

function rowToForm(r: CountryRow): FormState {
  return {
    code: r.code,
    name: r.name,
    flag: r.flag,
    dialing_code: r.dialing_code,
    currency_code: r.currency_code,
    currency_symbol: r.currency_symbol,
    currency_locale: r.currency_locale,
    payment_gateway: r.payment_gateway,
    phone_digits: r.phone_digits,
    phone_pattern: r.phone_pattern,
    phone_placeholder: r.phone_placeholder,
    is_active: r.is_active,
    sort_order: r.sort_order,
    cities: r.cities || {},
    pricing: r.pricing && Object.keys(r.pricing).length > 0 ? r.pricing : emptyForm().pricing,
    verification_tiers: r.verification_tiers && Object.keys(r.verification_tiers).length > 0
      ? r.verification_tiers as FormState['verification_tiers']
      : emptyForm().verification_tiers,
    doc_types: r.doc_types || [],
  };
}

export default function Countries() {
  const [countries, setCountries] = useState<CountryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const perPage = 20;

  // Modal
  const [showModal, setShowModal] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  // City editor temp state
  const [newCityKey, setNewCityKey] = useState('');
  const [newCityName, setNewCityName] = useState('');
  const [newNeighborhood, setNewNeighborhood] = useState<Record<string, string>>({});

  // Doc type editor temp state
  const [newDocKey, setNewDocKey] = useState('');
  const [newDocLabel, setNewDocLabel] = useState('');
  const [newDocDesc, setNewDocDesc] = useState('');

  async function load() {
    setLoading(true);
    const list = await loadCountries();
    setCountries(list);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  // Stats
  const total = countries.length;
  const active = countries.filter(c => c.is_active).length;
  const stripeCount = countries.filter(c => c.payment_gateway === 'stripe').length;
  const paystackCount = countries.filter(c => c.payment_gateway === 'paystack').length;

  // Pagination
  const totalPages = Math.ceil(total / perPage);
  const paginated = countries.slice((page - 1) * perPage, page * perPage);

  function openAdd() {
    setForm(emptyForm());
    setEditMode(false);
    setShowModal(true);
  }

  function openEdit(row: CountryRow) {
    setForm(rowToForm(row));
    setEditMode(true);
    setShowModal(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const userId = session?.session?.user?.id;

      const payload = {
        code: form.code.toUpperCase().trim(),
        name: form.name.trim(),
        flag: form.flag.trim(),
        dialing_code: form.dialing_code.trim(),
        currency_code: form.currency_code.toUpperCase().trim(),
        currency_symbol: form.currency_symbol.trim(),
        currency_locale: form.currency_locale.trim(),
        payment_gateway: form.payment_gateway,
        phone_digits: form.phone_digits,
        phone_pattern: form.phone_pattern.trim(),
        phone_placeholder: form.phone_placeholder.trim(),
        is_active: form.is_active,
        sort_order: form.sort_order,
        cities: form.cities,
        pricing: form.pricing,
        verification_tiers: form.verification_tiers,
        doc_types: form.doc_types,
        updated_by: userId || null,
      };

      if (editMode) {
        const { error } = await supabase.from('countries').update(payload).eq('code', form.code);
        if (error) throw error;
        await logAudit({ action: 'country.update', entity_type: 'country', entity_id: form.code, details: { name: form.name } });
      } else {
        const { error } = await supabase.from('countries').insert(payload);
        if (error) throw error;
        await logAudit({ action: 'country.create', entity_type: 'country', entity_id: form.code, details: { name: form.name } });
      }

      invalidateCache();
      setShowModal(false);
      await load();
    } catch (err: unknown) {
      alert(`Save failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(code: string) {
    if (!confirm(`Delete country ${code}? This cannot be undone.`)) return;
    setDeleting(code);
    try {
      const { error } = await supabase.from('countries').delete().eq('code', code);
      if (error) throw error;
      await logAudit({ action: 'country.delete', entity_type: 'country', entity_id: code });
      invalidateCache();
      await load();
    } catch (err: unknown) {
      alert(`Delete failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setDeleting(null);
    }
  }

  function addCity() {
    if (!newCityKey.trim() || !newCityName.trim()) return;
    const key = newCityKey.trim().toLowerCase().replace(/\s+/g, '_');
    setForm(f => ({ ...f, cities: { ...f.cities, [key]: { name: newCityName.trim(), neighborhoods: [] } } }));
    setNewCityKey('');
    setNewCityName('');
  }

  function removeCity(key: string) {
    setForm(f => {
      const cities = { ...f.cities };
      delete cities[key];
      return { ...f, cities };
    });
  }

  function addNeighborhood(cityKey: string) {
    const val = (newNeighborhood[cityKey] || '').trim();
    if (!val) return;
    setForm(f => ({
      ...f,
      cities: {
        ...f.cities,
        [cityKey]: { ...f.cities[cityKey], neighborhoods: [...f.cities[cityKey].neighborhoods, val] },
      },
    }));
    setNewNeighborhood(n => ({ ...n, [cityKey]: '' }));
  }

  function removeNeighborhood(cityKey: string, idx: number) {
    setForm(f => ({
      ...f,
      cities: {
        ...f.cities,
        [cityKey]: { ...f.cities[cityKey], neighborhoods: f.cities[cityKey].neighborhoods.filter((_, i) => i !== idx) },
      },
    }));
  }

  function addDocType() {
    if (!newDocKey.trim() || !newDocLabel.trim()) return;
    setForm(f => ({ ...f, doc_types: [...f.doc_types, { key: newDocKey.trim(), label: newDocLabel.trim(), desc: newDocDesc.trim() }] }));
    setNewDocKey('');
    setNewDocLabel('');
    setNewDocDesc('');
  }

  function removeDocType(idx: number) {
    setForm(f => ({ ...f, doc_types: f.doc_types.filter((_, i) => i !== idx) }));
  }

  const inputClass = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand';
  const labelClass = 'block text-xs font-medium text-gray-600 mb-1';

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Countries</h1>
          <p className="text-sm text-gray-500 mt-1">Manage supported countries, currencies, and payment gateways</p>
        </div>
        <button onClick={openAdd} className="flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 transition">
          <Plus className="w-4 h-4" /> Add Country
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-4 mb-6 lg:grid-cols-4">
        <SummaryCard label="Total Countries" value={total} icon={Globe} color="blue" />
        <SummaryCard label="Active" value={active} icon={CheckCircle} color="green" />
        <SummaryCard label="Stripe" value={stripeCount} icon={CreditCard} color="purple" />
        <SummaryCard label="Paystack" value={paystackCount} icon={CreditCard} color="yellow" />
      </div>

      {/* Table */}
      {loading ? (
        <p className="text-center text-gray-400 py-12">Loading countries...</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50/50">
                <th className="px-4 py-3 text-left font-semibold text-gray-600">Country</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-600">Currency</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-600">Gateway</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-600">Cities</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-600">Status</th>
                <th className="px-4 py-3 text-right font-semibold text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              {paginated.map(row => (
                <tr key={row.code} className="border-b border-gray-50 hover:bg-gray-50/50">
                  <td className="px-4 py-3">
                    <span className="mr-2">{row.flag}</span>
                    <span className="font-medium text-gray-900">{row.code}</span>
                    <span className="ml-2 text-gray-500">{row.name}</span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {row.currency_symbol} {row.currency_code}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      row.payment_gateway === 'stripe' ? 'bg-purple-100 text-purple-700'
                        : row.payment_gateway === 'paystack' ? 'bg-yellow-100 text-yellow-700'
                          : 'bg-gray-100 text-gray-600'
                    }`}>
                      {row.payment_gateway}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{Object.keys(row.cities || {}).length}</td>
                  <td className="px-4 py-3">
                    {row.is_active ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700">
                        <CheckCircle className="w-3.5 h-3.5" /> Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-400">
                        <XCircle className="w-3.5 h-3.5" /> Inactive
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => openEdit(row)} className="mr-2 text-gray-400 hover:text-brand transition">
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(row.code)}
                      disabled={deleting === row.code}
                      className="text-gray-400 hover:text-red-500 transition disabled:opacity-50"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
              {paginated.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-12 text-center text-gray-400">No countries found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-semibold text-gray-900">
                {editMode ? `Edit ${form.code}` : 'Add Country'}
              </h3>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-6">
              {/* Section 1: Basic Info */}
              <section>
                <h4 className="text-sm font-semibold text-gray-700 mb-3">Basic Info</h4>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <div>
                    <label className={labelClass}>Code (ISO)</label>
                    <input
                      className={inputClass}
                      value={form.code}
                      onChange={e => setForm(f => ({ ...f, code: e.target.value }))}
                      maxLength={4}
                      disabled={editMode}
                      placeholder="NG"
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Name</label>
                    <input className={inputClass} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Nigeria" />
                  </div>
                  <div>
                    <label className={labelClass}>Flag</label>
                    <input className={inputClass} value={form.flag} onChange={e => setForm(f => ({ ...f, flag: e.target.value }))} placeholder="emoji" />
                  </div>
                  <div>
                    <label className={labelClass}>Sort Order</label>
                    <input type="number" className={inputClass} value={form.sort_order} onChange={e => setForm(f => ({ ...f, sort_order: Number(e.target.value) }))} />
                  </div>
                </div>
                <div className="mt-3">
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input type="checkbox" checked={form.is_active} onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} className="rounded border-gray-300" />
                    Active (visible in signup)
                  </label>
                </div>
              </section>

              {/* Section 2: Currency */}
              <section>
                <h4 className="text-sm font-semibold text-gray-700 mb-3">Currency</h4>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className={labelClass}>Code</label>
                    <input className={inputClass} value={form.currency_code} onChange={e => setForm(f => ({ ...f, currency_code: e.target.value }))} placeholder="NGN" />
                  </div>
                  <div>
                    <label className={labelClass}>Symbol</label>
                    <input className={inputClass} value={form.currency_symbol} onChange={e => setForm(f => ({ ...f, currency_symbol: e.target.value }))} placeholder="₦" />
                  </div>
                  <div>
                    <label className={labelClass}>Locale</label>
                    <input className={inputClass} value={form.currency_locale} onChange={e => setForm(f => ({ ...f, currency_locale: e.target.value }))} placeholder="en-NG" />
                  </div>
                </div>
              </section>

              {/* Section 3: Payment Gateway */}
              <section>
                <h4 className="text-sm font-semibold text-gray-700 mb-3">Payment Gateway</h4>
                <select
                  className={inputClass}
                  value={form.payment_gateway}
                  onChange={e => setForm(f => ({ ...f, payment_gateway: e.target.value }))}
                >
                  {GATEWAYS.map(gw => <option key={gw} value={gw}>{gw}</option>)}
                </select>
              </section>

              {/* Section 4: Phone Format */}
              <section>
                <h4 className="text-sm font-semibold text-gray-700 mb-3">Phone Format</h4>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <div>
                    <label className={labelClass}>Dialing Code</label>
                    <input className={inputClass} value={form.dialing_code} onChange={e => setForm(f => ({ ...f, dialing_code: e.target.value }))} placeholder="+234" />
                  </div>
                  <div>
                    <label className={labelClass}>Digits</label>
                    <input type="number" className={inputClass} value={form.phone_digits} onChange={e => setForm(f => ({ ...f, phone_digits: Number(e.target.value) }))} />
                  </div>
                  <div>
                    <label className={labelClass}>Pattern (regex)</label>
                    <input className={inputClass} value={form.phone_pattern} onChange={e => setForm(f => ({ ...f, phone_pattern: e.target.value }))} placeholder="^[789]\d{9}$" />
                  </div>
                  <div>
                    <label className={labelClass}>Placeholder</label>
                    <input className={inputClass} value={form.phone_placeholder} onChange={e => setForm(f => ({ ...f, phone_placeholder: e.target.value }))} placeholder="8012345678" />
                  </div>
                </div>
              </section>

              {/* Section 5: Verification Tiers */}
              <section>
                <h4 className="text-sm font-semibold text-gray-700 mb-3">Verification Tiers</h4>
                <div className="space-y-3">
                  {VERIFICATION_LEVELS.map(level => {
                    const tier = form.verification_tiers[level] || { label: level, limit: 0, requirements: '' };
                    return (
                      <div key={level} className="grid grid-cols-3 gap-3 items-end">
                        <div>
                          <label className={labelClass}>{level} — Label</label>
                          <input className={inputClass} value={tier.label}
                            onChange={e => setForm(f => ({
                              ...f,
                              verification_tiers: { ...f.verification_tiers, [level]: { ...tier, label: e.target.value } },
                            }))} />
                        </div>
                        <div>
                          <label className={labelClass}>Payout Limit</label>
                          <input type="number" className={inputClass} value={tier.limit}
                            onChange={e => setForm(f => ({
                              ...f,
                              verification_tiers: { ...f.verification_tiers, [level]: { ...tier, limit: Number(e.target.value) } },
                            }))} />
                        </div>
                        <div>
                          <label className={labelClass}>Requirements</label>
                          <input className={inputClass} value={tier.requirements}
                            onChange={e => setForm(f => ({
                              ...f,
                              verification_tiers: { ...f.verification_tiers, [level]: { ...tier, requirements: e.target.value } },
                            }))} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* Section 6: KYC Document Types */}
              <section>
                <h4 className="text-sm font-semibold text-gray-700 mb-3">KYC Document Types</h4>
                {form.doc_types.map((dt, i) => (
                  <div key={i} className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-mono text-gray-500 w-36 truncate">{dt.key}</span>
                    <span className="text-sm text-gray-700 flex-1 truncate">{dt.label}</span>
                    <span className="text-xs text-gray-400 flex-1 truncate">{dt.desc}</span>
                    <button onClick={() => removeDocType(i)} className="text-red-400 hover:text-red-600"><X className="w-4 h-4" /></button>
                  </div>
                ))}
                <div className="grid grid-cols-3 gap-2 mt-2">
                  <input className={inputClass} value={newDocKey} onChange={e => setNewDocKey(e.target.value)} placeholder="Key (slug)" />
                  <input className={inputClass} value={newDocLabel} onChange={e => setNewDocLabel(e.target.value)} placeholder="Label" />
                  <div className="flex gap-2">
                    <input className={inputClass} value={newDocDesc} onChange={e => setNewDocDesc(e.target.value)} placeholder="Description" />
                    <button onClick={addDocType} className="shrink-0 rounded-lg bg-gray-100 px-3 text-sm font-medium text-gray-600 hover:bg-gray-200">
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </section>

              {/* Section 7: Pricing Tiers */}
              <section>
                <h4 className="text-sm font-semibold text-gray-700 mb-3">Pricing Tiers</h4>
                <div className="space-y-3">
                  {PRICING_TIERS.map(tier => {
                    const p = form.pricing[tier] || { price: 0, feeFlat: 0, feePercentage: 2.5, trialDays: 14 };
                    return (
                      <div key={tier} className="grid grid-cols-5 gap-3 items-end">
                        <div>
                          <label className={labelClass}>{tier}</label>
                          <span className="text-xs text-gray-400">Tier</span>
                        </div>
                        <div>
                          <label className={labelClass}>Monthly Price</label>
                          <input type="number" step="0.01" className={inputClass} value={p.price}
                            onChange={e => setForm(f => ({
                              ...f,
                              pricing: { ...f.pricing, [tier]: { ...p, price: Number(e.target.value) } },
                            }))} />
                        </div>
                        <div>
                          <label className={labelClass}>Fee %</label>
                          <input type="number" step="0.1" className={inputClass} value={(p as Record<string, unknown>).feePercentage as number || 2.5}
                            onChange={e => setForm(f => ({
                              ...f,
                              pricing: { ...f.pricing, [tier]: { ...p, feePercentage: Number(e.target.value) } },
                            }))} />
                        </div>
                        <div>
                          <label className={labelClass}>Flat Fee</label>
                          <input type="number" step="0.01" className={inputClass} value={p.feeFlat}
                            onChange={e => setForm(f => ({
                              ...f,
                              pricing: { ...f.pricing, [tier]: { ...p, feeFlat: Number(e.target.value) } },
                            }))} />
                        </div>
                        <div>
                          <label className={labelClass}>Trial Days</label>
                          <input type="number" className={inputClass} value={(p as Record<string, unknown>).trialDays as number || 14}
                            onChange={e => setForm(f => ({
                              ...f,
                              pricing: { ...f.pricing, [tier]: { ...p, trialDays: Number(e.target.value) } },
                            }))} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* Cities removed — Google Places autocomplete handles address/city globally */}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 mt-8 pt-4 border-t border-gray-200">
              <button
                onClick={() => setShowModal(false)}
                className="rounded-xl border border-gray-300 px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !form.code || !form.name}
                className="flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 transition disabled:opacity-50"
              >
                <Save className="w-4 h-4" />
                {saving ? 'Saving...' : editMode ? 'Update Country' : 'Create Country'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

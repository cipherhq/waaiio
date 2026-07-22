'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness, useRequireCapability } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import EmptyState from '@/components/dashboard/EmptyState';

interface ServicePackage {
  id: string;
  name: string;
  description: string | null;
  price: number;
  num_sessions: number;
  service_ids: string[];
  valid_days: number;
  is_active: boolean;
  created_at: string;
}

interface Enrollment {
  id: string;
  customer_phone: string;
  customer_name: string | null;
  sessions_total: number;
  sessions_used: number;
  purchased_at: string;
  expires_at: string | null;
  is_active: boolean;
  package_id: string;
}

interface ServiceOption {
  id: string;
  name: string;
}

type View = 'list' | 'add' | 'edit' | 'enrollments' | 'enroll';

export default function PackagesPage() {
  const allowed = useRequireCapability('packages');
  const business = useBusiness();
  const cc = (business.country_code || 'NG') as CountryCode;

  const [packages, setPackages] = useState<ServicePackage[]>([]);
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<View>('list');
  const [selectedPkg, setSelectedPkg] = useState<ServicePackage | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formPrice, setFormPrice] = useState('');
  const [formSessions, setFormSessions] = useState('');
  const [formValidDays, setFormValidDays] = useState('365');
  const [formServiceIds, setFormServiceIds] = useState<string[]>([]);

  // Enroll form state
  const [enrollPhone, setEnrollPhone] = useState('');
  const [enrollName, setEnrollName] = useState('');

  const fetchData = useCallback(async () => {
    const supabase = createClient();

    const [pkgRes, svcRes] = await Promise.all([
      supabase
        .from('service_packages')
        .select('*')
        .eq('business_id', business.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('services')
        .select('id, name')
        .eq('business_id', business.id)
        .is('deleted_at', null)
        .eq('is_active', true)
        .order('name'),
    ]);

    setPackages(pkgRes.data || []);
    setServices(svcRes.data || []);
    setLoading(false);
  }, [business.id]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const fetchEnrollments = useCallback(async (packageId: string) => {
    const supabase = createClient();
    const { data } = await supabase
      .from('package_enrollments')
      .select('*')
      .eq('business_id', business.id)
      .eq('package_id', packageId)
      .order('created_at', { ascending: false });
    setEnrollments(data || []);
  }, [business.id]);

  const resetForm = () => {
    setFormName('');
    setFormDesc('');
    setFormPrice('');
    setFormSessions('');
    setFormValidDays('365');
    setFormServiceIds([]);
  };

  const handleSave = async () => {
    if (!formName.trim() || !formPrice || !formSessions) return;
    setSaving(true);

    try {
      const payload = {
        business_id: business.id,
        name: formName.trim(),
        description: formDesc.trim() || null,
        price: Number(formPrice),
        num_sessions: Number(formSessions),
        service_ids: formServiceIds,
        valid_days: Number(formValidDays) || 365,
      };

      const method = view === 'edit' && selectedPkg ? 'PUT' : 'POST';
      const body = method === 'PUT' ? { ...payload, id: selectedPkg!.id } : payload;

      const res = await fetch('/api/packages', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        resetForm();
        setView('list');
        setSelectedPkg(null);
        fetchData();
      }
    } catch {
      // error handled silently
    }
    setSaving(false);
  };

  const handleToggleActive = async (pkg: ServicePackage) => {
    const res = await fetch('/api/packages', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: pkg.id, business_id: business.id, is_active: !pkg.is_active }),
    });
    if (res.ok) fetchData();
  };

  const handleEnroll = async () => {
    if (!selectedPkg || !enrollPhone.trim()) return;
    setSaving(true);

    try {
      const res = await fetch('/api/packages/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: business.id,
          package_id: selectedPkg.id,
          customer_phone: enrollPhone.trim(),
          customer_name: enrollName.trim() || null,
        }),
      });

      if (res.ok) {
        setEnrollPhone('');
        setEnrollName('');
        setView('enrollments');
        fetchEnrollments(selectedPkg.id);
      }
    } catch {
      // error handled silently
    }
    setSaving(false);
  };

  const openEdit = (pkg: ServicePackage) => {
    setSelectedPkg(pkg);
    setFormName(pkg.name);
    setFormDesc(pkg.description || '');
    setFormPrice(String(pkg.price));
    setFormSessions(String(pkg.num_sessions));
    setFormValidDays(String(pkg.valid_days));
    setFormServiceIds(pkg.service_ids || []);
    setView('edit');
  };

  const openEnrollments = (pkg: ServicePackage) => {
    setSelectedPkg(pkg);
    fetchEnrollments(pkg.id);
    setView('enrollments');
  };

  const toggleServiceId = (id: string) => {
    setFormServiceIds(prev =>
      prev.includes(id) ? prev.filter(s => s !== id) : [...prev, id]
    );
  };

  if (!allowed) return null;

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  // ── Add / Edit Form ──
  if (view === 'add' || view === 'edit') {
    return (
      <div>
        <div className="flex items-center gap-3">
          <button onClick={() => { setView('list'); resetForm(); setSelectedPkg(null); }} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
            <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-2xl font-bold text-gray-900">{view === 'edit' ? 'Edit Package' : 'Create Package'}</h1>
        </div>

        <div className="mt-6 max-w-lg space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Package Name</label>
            <input
              type="text"
              value={formName}
              onChange={e => setFormName(e.target.value)}
              placeholder="e.g. 10 Session Bundle"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Description</label>
            <textarea
              value={formDesc}
              onChange={e => setFormDesc(e.target.value)}
              rows={2}
              placeholder="Optional description"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Price ({formatCurrency(0, cc).charAt(0)})</label>
              <input
                type="number"
                min={0}
                value={formPrice}
                onChange={e => setFormPrice(e.target.value)}
                placeholder="0"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Sessions Included</label>
              <input
                type="number"
                min={1}
                value={formSessions}
                onChange={e => setFormSessions(e.target.value)}
                placeholder="10"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Valid for (days)</label>
            <input
              type="number"
              min={1}
              value={formValidDays}
              onChange={e => setFormValidDays(e.target.value)}
              placeholder="365"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
            />
          </div>

          {services.length > 0 && (
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Redeemable Against Services</label>
              <p className="mb-2 text-xs text-gray-500">Select which services this package can be used for. Leave empty for all services.</p>
              <div className="max-h-40 space-y-1 overflow-auto rounded-lg border border-gray-200 p-2">
                {services.map(svc => (
                  <label key={svc.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-gray-50">
                    <input
                      type="checkbox"
                      checked={formServiceIds.includes(svc.id)}
                      onChange={() => toggleServiceId(svc.id)}
                      className="rounded border-gray-300 text-brand focus:ring-brand"
                    />
                    <span className="text-sm text-gray-700">{svc.name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              onClick={handleSave}
              disabled={saving || !formName.trim() || !formPrice || !formSessions}
              className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {saving ? 'Saving...' : view === 'edit' ? 'Update Package' : 'Create Package'}
            </button>
            <button
              onClick={() => { setView('list'); resetForm(); setSelectedPkg(null); }}
              className="rounded-lg border border-gray-200 px-6 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Enroll Form ──
  if (view === 'enroll' && selectedPkg) {
    return (
      <div>
        <div className="flex items-center gap-3">
          <button onClick={() => { setView('enrollments'); setEnrollPhone(''); setEnrollName(''); }} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
            <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-2xl font-bold text-gray-900">Enroll Customer</h1>
        </div>
        <p className="mt-1 text-sm text-gray-500">Enrolling into: {selectedPkg.name}</p>

        <div className="mt-6 max-w-lg space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Customer Phone</label>
            <input
              type="tel"
              value={enrollPhone}
              onChange={e => setEnrollPhone(e.target.value)}
              placeholder="+234..."
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Customer Name (optional)</label>
            <input
              type="text"
              value={enrollName}
              onChange={e => setEnrollName(e.target.value)}
              placeholder="Jane Doe"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
            />
          </div>
          <div className="flex gap-3 pt-2">
            <button
              onClick={handleEnroll}
              disabled={saving || !enrollPhone.trim()}
              className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {saving ? 'Enrolling...' : 'Enroll Customer'}
            </button>
            <button
              onClick={() => { setView('enrollments'); setEnrollPhone(''); setEnrollName(''); }}
              className="rounded-lg border border-gray-200 px-6 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Enrollments View ──
  if (view === 'enrollments' && selectedPkg) {
    return (
      <div>
        <div className="flex items-center gap-3">
          <button onClick={() => { setView('list'); setSelectedPkg(null); }} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
            <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{selectedPkg.name}</h1>
            <p className="text-sm text-gray-500">{selectedPkg.num_sessions} sessions &middot; {formatCurrency(selectedPkg.price, cc)}</p>
          </div>
        </div>

        <div className="mt-4 flex gap-2">
          <button
            onClick={() => setView('enroll')}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
          >
            + Enroll Customer
          </button>
        </div>

        {enrollments.length === 0 ? (
          <div className="mt-12 text-center">
            <p className="text-sm text-gray-500">No customers enrolled in this package yet.</p>
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            {enrollments.map(e => (
              <div key={e.id} className="rounded-xl border border-gray-100 bg-white p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{e.customer_name || e.customer_phone}</p>
                    {e.customer_name && <p className="text-xs text-gray-500">{e.customer_phone}</p>}
                  </div>
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    e.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                  }`}>
                    {e.is_active ? 'Active' : 'Expired'}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-4 text-xs text-gray-500">
                  <span>Sessions: <span className="font-medium text-gray-900">{e.sessions_used}/{e.sessions_total}</span></span>
                  <span>Remaining: <span className="font-medium text-brand">{Math.max(0, e.sessions_total - e.sessions_used)}</span></span>
                  {e.expires_at && (
                    <span>Expires: {new Date(e.expires_at).toLocaleDateString()}</span>
                  )}
                </div>
                {/* Progress bar */}
                <div className="mt-2 h-1.5 w-full rounded-full bg-gray-100">
                  <div
                    className="h-full rounded-full bg-brand transition-all"
                    style={{ width: `${Math.min(100, (e.sessions_used / e.sessions_total) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── List View ──
  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Session Packages</h1>
          <p className="mt-1 text-sm text-gray-500">Sell multi-session bundles. Customers buy once, redeem over time.</p>
        </div>
        <button
          onClick={() => { resetForm(); setView('add'); }}
          className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600"
        >
          + New Package
        </button>
      </div>

      {packages.length === 0 ? (
        <EmptyState
          icon="🎫"
          title="No packages yet"
          description="Create a session package to sell multi-session bundles to your customers."
          actionLabel="Create Your First Package"
          onAction={() => { resetForm(); setView('add'); }}
          tip="Packages work great for services like personal training, therapy, tutoring, or any recurring service."
        />
      ) : (
        <div className="mt-6 space-y-3">
          {packages.map(pkg => (
            <div key={pkg.id} className="rounded-xl border border-gray-100 bg-white p-5 transition hover:shadow-sm">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-gray-900">{pkg.name}</h3>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      pkg.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                    }`}>
                      {pkg.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                  {pkg.description && <p className="mt-0.5 text-xs text-gray-500">{pkg.description}</p>}
                  <div className="mt-2 flex items-center gap-4 text-xs text-gray-500">
                    <span>Price: <span className="font-medium text-gray-900">{formatCurrency(pkg.price, cc)}</span></span>
                    <span>Sessions: <span className="font-medium text-gray-900">{pkg.num_sessions}</span></span>
                    <span>Valid: <span className="font-medium text-gray-900">{pkg.valid_days} days</span></span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => openEnrollments(pkg)}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
                  >
                    Enrollments
                  </button>
                  <button
                    onClick={() => openEdit(pkg)}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleToggleActive(pkg)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                      pkg.is_active
                        ? 'border border-red-200 text-red-600 hover:bg-red-50'
                        : 'border border-green-200 text-green-600 hover:bg-green-50'
                    }`}
                  >
                    {pkg.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

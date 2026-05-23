import { useEffect, useState, useRef } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { useAdminSession } from '@/components/AdminLayout';
import { StatusBadge } from '@/components/StatusBadge';
import { fmtDate, fmtDateTime } from '@/lib/formatters';
import { Search, LogOut, Pencil, Check, X, Building2, ExternalLink } from 'lucide-react';

interface Business {
  id: string;
  name: string;
  category: string;
  country_code: string | null;
  status: string;
  created_at?: string;
  phone?: string | null;
  email?: string | null;
}

interface PayoutAccount {
  id: string;
  gateway: string;
  bank_name: string | null;
  account_name: string | null;
  account_number: string | null;
  is_active: boolean;
}

interface WhatsAppConfig {
  id: string;
  phone_number_id: string | null;
  waba_id: string | null;
  status: string | null;
}

interface Booking {
  id: string;
  service_name: string | null;
  customer_name: string | null;
  status: string;
  total_amount: number | null;
  created_at: string;
}

type EditingField = 'name' | 'phone' | 'email' | 'category' | null;

export default function ImpersonationMode() {
  const session = useAdminSession();
  const isFullAdmin = session?.role === 'admin';

  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Selected business state
  const [selected, setSelected] = useState<Business | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Business detail data
  const [payoutAccount, setPayoutAccount] = useState<PayoutAccount | null>(null);
  const [whatsappConfig, setWhatsappConfig] = useState<WhatsAppConfig | null>(null);
  const [recentBookings, setRecentBookings] = useState<Booking[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Admin info
  const [adminId, setAdminId] = useState<string | null>(null);
  const [adminEmail, setAdminEmail] = useState<string | null>(null);

  // Inline editing
  const [editingField, setEditingField] = useState<EditingField>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [launchingDashboard, setLaunchingDashboard] = useState(false);

  // Load businesses and admin info on mount
  useEffect(() => {
    async function load() {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const user = sessionData?.session?.user;
        setAdminId(user?.id ?? null);
        setAdminEmail(user?.email ?? null);

        const { data } = await adminDb
          .from('businesses')
          .select('id, name, category, country_code, status')
          .order('name', { ascending: true });

        setBusinesses(data || []);
      } catch (error) {
        console.warn('Failed to load businesses:', error);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Filter businesses by search
  const filteredBusinesses = businesses.filter(b =>
    b.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Select a business and start impersonation session
  async function handleSelectBusiness(business: Business) {
    setShowDropdown(false);
    setSearchQuery('');
    setLoadingDetail(true);

    try {
      // Load full business data
      const { data: fullBiz } = await adminDb
        .from('businesses')
        .select('id, name, category, country_code, status, created_at, phone, email')
        .eq('id', business.id)
        .single();

      setSelected(fullBiz || business);

      // Generate session UUID
      const sid = crypto.randomUUID();
      setSessionId(sid);

      // Log session start
      await adminDb.from('impersonation_logs').insert({
        session_id: sid,
        admin_id: adminId,
        admin_email: adminEmail,
        target_business_id: business.id,
        target_business_name: business.name,
        action: 'session_start',
        changes: null,
        created_at: new Date().toISOString(),
      });

      // Load payout account
      const { data: payout } = await adminDb
        .from('payout_accounts')
        .select('id, gateway, bank_name, account_name, account_number, is_active')
        .eq('business_id', business.id)
        .eq('is_active', true)
        .maybeSingle();
      setPayoutAccount(payout);

      // Load WhatsApp config
      const { data: waConfig } = await adminDb
        .from('whatsapp_config')
        .select('id, phone_number_id, waba_id, status')
        .eq('business_id', business.id)
        .maybeSingle();
      setWhatsappConfig(waConfig);

      // Load recent bookings
      const { data: bookings } = await adminDb
        .from('bookings')
        .select('id, service_name, customer_name, status, total_amount, created_at')
        .eq('business_id', business.id)
        .order('created_at', { ascending: false })
        .limit(10);
      setRecentBookings(bookings || []);
    } catch (error) {
      console.warn('Failed to load business details:', error);
    } finally {
      setLoadingDetail(false);
    }
  }

  // Launch "View Dashboard" — generates an impersonation token and opens business dashboard in new tab
  async function handleViewDashboard() {
    if (!selected || launchingDashboard) return;
    setLaunchingDashboard(true);

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) {
        alert('Session expired — please re-login');
        return;
      }

      const apiUrl = import.meta.env.VITE_API_URL || '';
      const res = await fetch(`${apiUrl}/api/admin/impersonate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ business_id: selected.id }),
      });

      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to generate impersonation token');
        return;
      }

      if (data.url && (data.url.startsWith('https://waaiio.com') || data.url.startsWith(window.location.origin))) {
        window.open(data.url, '_blank');
      } else {
        alert('Invalid redirect URL');
      }
    } catch (error) {
      console.error('View dashboard error:', error);
      alert('Failed to launch dashboard');
    } finally {
      setLaunchingDashboard(false);
    }
  }

  // End impersonation session
  async function handleEndSession() {
    if (!selected || !sessionId) return;

    try {
      await adminDb.from('impersonation_logs').insert({
        session_id: sessionId,
        admin_id: adminId,
        admin_email: adminEmail,
        target_business_id: selected.id,
        target_business_name: selected.name,
        action: 'session_end',
        changes: null,
        created_at: new Date().toISOString(),
      });
    } catch (error) {
      console.warn('Failed to log session end:', error);
    }

    setSelected(null);
    setSessionId(null);
    setPayoutAccount(null);
    setWhatsappConfig(null);
    setRecentBookings([]);
    setEditingField(null);
  }

  // Start inline edit
  function startEdit(field: EditingField, currentValue: string | null) {
    setEditingField(field);
    setEditValue(currentValue || '');
  }

  // Cancel inline edit
  function cancelEdit() {
    setEditingField(null);
    setEditValue('');
  }

  // Save inline edit — only allow safe fields
  const EDITABLE_FIELDS = ['name', 'description', 'address', 'phone', 'email', 'slug', 'category', 'flow_type'];

  async function saveEdit() {
    if (!selected || !editingField || !sessionId) return;
    if (!EDITABLE_FIELDS.includes(editingField)) {
      alert(`Field "${editingField}" cannot be edited from impersonation mode.`);
      return;
    }

    setSaving(true);
    try {
      const oldValue = selected[editingField as keyof Business] as string | null;
      const newValue = editValue.trim();

      const updatePayload: Record<string, string> = {
        [editingField]: newValue,
      };

      const { error } = await adminDb
        .from('businesses')
        .update(updatePayload)
        .eq('id', selected.id);

      if (error) throw error;

      // Log the change
      await adminDb.from('impersonation_logs').insert({
        session_id: sessionId,
        admin_id: adminId,
        admin_email: adminEmail,
        target_business_id: selected.id,
        target_business_name: selected.name,
        action: 'update_profile',
        changes: {
          field: editingField,
          old_value: oldValue || null,
          new_value: newValue,
        },
        created_at: new Date().toISOString(),
      });

      // Update local state
      setSelected({ ...selected, [editingField]: newValue });
      setEditingField(null);
      setEditValue('');
    } catch (error) {
      console.error('Save edit error:', error);
      alert('Failed to save change');
    } finally {
      setSaving(false);
    }
  }

  if (!isFullAdmin) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center text-center">
        <p className="text-lg font-semibold text-gray-900">Access Restricted</p>
        <p className="mt-1 text-sm text-gray-500">Only full admins can use impersonation mode.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Impersonation Mode</h1>
      <p className="mt-1 text-sm text-gray-500">Access and manage business accounts as an admin</p>

      {/* Business Selector */}
      {!selected && (
        <div className="mt-6" ref={dropdownRef}>
          <label className="block text-sm font-medium text-gray-700">Select a business to impersonate</label>
          <div className="relative mt-1">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => { setSearchQuery(e.target.value); setShowDropdown(true); }}
                onFocus={() => setShowDropdown(true)}
                placeholder="Search businesses by name..."
                className="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-3 text-sm text-gray-700 focus:border-brand focus:outline-none sm:w-96"
              />
            </div>

            {showDropdown && (
              <div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-lg sm:w-96">
                {filteredBusinesses.length === 0 ? (
                  <div className="px-4 py-3 text-sm text-gray-500">No businesses found</div>
                ) : (
                  filteredBusinesses.map(b => (
                    <button
                      key={b.id}
                      onClick={() => handleSelectBusiness(b)}
                      className="flex w-full items-center justify-between px-4 py-3 text-left text-sm transition hover:bg-gray-50"
                    >
                      <div>
                        <p className="font-medium text-gray-900">{b.name}</p>
                        <p className="text-xs text-gray-500">{b.category} {b.country_code ? `-- ${b.country_code}` : ''}</p>
                      </div>
                      <StatusBadge status={b.status} />
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Loading detail data */}
      {loadingDetail && (
        <div className="mt-8 flex min-h-[30vh] items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
        </div>
      )}

      {/* Business Dashboard View */}
      {selected && !loadingDetail && (
        <div className="mt-6">
          {/* Session Bar */}
          <div className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-5 py-3">
            <div className="flex items-center gap-3">
              <Building2 className="h-5 w-5 text-amber-600" />
              <div>
                <p className="text-sm font-semibold text-amber-900">
                  Impersonating: {selected.name}
                </p>
                <p className="text-xs text-amber-600">
                  Session {sessionId?.slice(0, 8)}... -- All changes are logged
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleViewDashboard}
                disabled={launchingDashboard}
                className="flex items-center gap-1.5 rounded-xl border border-amber-300 bg-white px-4 py-2.5 text-sm font-bold text-amber-700 transition hover:bg-amber-50 disabled:opacity-50"
              >
                <ExternalLink className="h-4 w-4" />
                {launchingDashboard ? 'Opening...' : 'View Dashboard'}
              </button>
              <button
                onClick={handleEndSession}
                className="flex items-center gap-1.5 rounded-xl bg-amber-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-amber-700"
              >
                <LogOut className="h-4 w-4" />
                End Session
              </button>
            </div>
          </div>

          {/* Business Profile Card */}
          <div className="mt-6 rounded-xl border border-gray-200 bg-white">
            <div className="border-b border-gray-100 bg-gray-50 px-5 py-3 rounded-t-xl">
              <h2 className="text-sm font-semibold text-gray-700">Business Profile</h2>
            </div>
            <div className="divide-y divide-gray-50 px-5">
              {/* Name */}
              <EditableRow
                label="Name"
                value={selected.name}
                isEditing={editingField === 'name'}
                editValue={editValue}
                saving={saving}
                onStartEdit={() => startEdit('name', selected.name)}
                onCancel={cancelEdit}
                onSave={saveEdit}
                onEditValueChange={setEditValue}
              />

              {/* Category */}
              <EditableRow
                label="Category"
                value={selected.category}
                isEditing={editingField === 'category'}
                editValue={editValue}
                saving={saving}
                onStartEdit={() => startEdit('category', selected.category)}
                onCancel={cancelEdit}
                onSave={saveEdit}
                onEditValueChange={setEditValue}
              />

              {/* Phone */}
              <EditableRow
                label="Phone"
                value={selected.phone || null}
                isEditing={editingField === 'phone'}
                editValue={editValue}
                saving={saving}
                onStartEdit={() => startEdit('phone', selected.phone || null)}
                onCancel={cancelEdit}
                onSave={saveEdit}
                onEditValueChange={setEditValue}
              />

              {/* Email */}
              <EditableRow
                label="Email"
                value={selected.email || null}
                isEditing={editingField === 'email'}
                editValue={editValue}
                saving={saving}
                onStartEdit={() => startEdit('email', selected.email || null)}
                onCancel={cancelEdit}
                onSave={saveEdit}
                onEditValueChange={setEditValue}
              />

              {/* Read-only fields */}
              <div className="flex items-center justify-between py-3">
                <span className="text-sm text-gray-500">Country</span>
                <span className="text-sm font-medium text-gray-900">{selected.country_code || '--'}</span>
              </div>
              <div className="flex items-center justify-between py-3">
                <span className="text-sm text-gray-500">Status</span>
                <StatusBadge status={selected.status} />
              </div>
              {selected.created_at && (
                <div className="flex items-center justify-between py-3">
                  <span className="text-sm text-gray-500">Created</span>
                  <span className="text-sm font-medium text-gray-900">{fmtDateTime(selected.created_at)}</span>
                </div>
              )}
              <div className="flex items-center justify-between py-3">
                <span className="text-sm text-gray-500">Business ID</span>
                <span className="font-mono text-xs text-gray-500">{selected.id}</span>
              </div>
            </div>
          </div>

          {/* Payout Account Info */}
          <div className="mt-6 rounded-xl border border-gray-200 bg-white">
            <div className="border-b border-gray-100 bg-gray-50 px-5 py-3 rounded-t-xl">
              <h2 className="text-sm font-semibold text-gray-700">Payout Account</h2>
            </div>
            <div className="px-5 py-4">
              {payoutAccount ? (
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Gateway</span>
                    <span className="font-medium text-gray-900">{payoutAccount.gateway}</span>
                  </div>
                  {payoutAccount.bank_name && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">Bank</span>
                      <span className="font-medium text-gray-900">{payoutAccount.bank_name}</span>
                    </div>
                  )}
                  {payoutAccount.account_name && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">Account Name</span>
                      <span className="font-medium text-gray-900">{payoutAccount.account_name}</span>
                    </div>
                  )}
                  {payoutAccount.account_number && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">Account Number</span>
                      <span className="font-mono font-medium text-gray-900">****{payoutAccount.account_number.slice(-4)}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-gray-500">Active</span>
                    <StatusBadge status={payoutAccount.is_active ? 'active' : 'inactive'} />
                  </div>
                </div>
              ) : (
                <p className="text-sm text-gray-500">No active payout account configured</p>
              )}
            </div>
          </div>

          {/* WhatsApp Config */}
          <div className="mt-6 rounded-xl border border-gray-200 bg-white">
            <div className="border-b border-gray-100 bg-gray-50 px-5 py-3 rounded-t-xl">
              <h2 className="text-sm font-semibold text-gray-700">WhatsApp Configuration</h2>
            </div>
            <div className="px-5 py-4">
              {whatsappConfig ? (
                <div className="space-y-2 text-sm">
                  {whatsappConfig.phone_number_id && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">Phone Number ID</span>
                      <span className="font-mono text-xs font-medium text-gray-900">{whatsappConfig.phone_number_id}</span>
                    </div>
                  )}
                  {whatsappConfig.waba_id && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">WABA ID</span>
                      <span className="font-mono text-xs font-medium text-gray-900">{whatsappConfig.waba_id}</span>
                    </div>
                  )}
                  {whatsappConfig.status && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">Status</span>
                      <StatusBadge status={whatsappConfig.status} />
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-gray-500">No WhatsApp configuration found</p>
              )}
            </div>
          </div>

          {/* Recent Bookings */}
          <div className="mt-6 rounded-xl border border-gray-200 bg-white">
            <div className="border-b border-gray-100 bg-gray-50 px-5 py-3 rounded-t-xl">
              <h2 className="text-sm font-semibold text-gray-700">Recent Bookings (Last 10)</h2>
            </div>
            {recentBookings.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-gray-500">No bookings found</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-gray-100 bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">Service</th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">Customer</th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                      <th className="px-4 py-3 text-right font-medium text-gray-500">Amount</th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {recentBookings.map(b => (
                      <tr key={b.id} className="transition hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-gray-900">{b.service_name || '--'}</td>
                        <td className="px-4 py-3 text-gray-600">{b.customer_name || '--'}</td>
                        <td className="px-4 py-3">
                          <StatusBadge status={b.status} />
                        </td>
                        <td className="px-4 py-3 text-right text-gray-900">
                          {b.total_amount != null ? formatMoney(b.total_amount) : '--'}
                        </td>
                        <td className="px-4 py-3 text-gray-500">{fmtDate(b.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* Editable Row Component */
function EditableRow({
  label,
  value,
  isEditing,
  editValue,
  saving,
  onStartEdit,
  onCancel,
  onSave,
  onEditValueChange,
}: {
  label: string;
  value: string | null;
  isEditing: boolean;
  editValue: string;
  saving: boolean;
  onStartEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  onEditValueChange: (v: string) => void;
}) {
  if (isEditing) {
    return (
      <div className="flex items-center gap-3 py-3">
        <span className="w-24 shrink-0 text-sm text-gray-500">{label}</span>
        <input
          type="text"
          value={editValue}
          onChange={e => onEditValueChange(e.target.value)}
          className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 focus:border-brand focus:outline-none"
          autoFocus
          onKeyDown={e => {
            if (e.key === 'Enter') onSave();
            if (e.key === 'Escape') onCancel();
          }}
        />
        <button
          onClick={onSave}
          disabled={saving}
          className="rounded-lg p-1.5 text-green-600 transition hover:bg-green-50 disabled:opacity-50"
          title="Save"
        >
          <Check className="h-4 w-4" />
        </button>
        <button
          onClick={onCancel}
          className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100"
          title="Cancel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between py-3">
      <span className="text-sm text-gray-500">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-900">{value || '--'}</span>
        <button
          onClick={onStartEdit}
          className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
          title={`Edit ${label}`}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function formatMoney(amount: number): string {
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 0 }).format(amount);
}

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import EmptyState from '@/components/dashboard/EmptyState';

interface WaiverTemplate {
  id: string;
  title: string;
  body: string;
  fields: string[];
  is_active: boolean;
  require_before_booking: boolean;
  token: string;
  created_at: string;
  updated_at: string;
}

interface SignedWaiver {
  id: string;
  template_id: string;
  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  signature_url: string | null;
  signed_at: string;
  metadata: Record<string, string>;
  audit_trail: Record<string, string>;
  waiver_templates: { title: string; token: string };
}

type ActiveTab = 'templates' | 'signed';

const FIELD_OPTIONS = [
  { key: 'emergency_contact', label: 'Emergency Contact' },
  { key: 'medical_conditions', label: 'Medical Conditions' },
  { key: 'allergies', label: 'Allergies' },
];

export default function WaiversPage() {
  const business = useBusiness();
  const [tab, setTab] = useState<ActiveTab>('templates');
  const [loading, setLoading] = useState(true);

  // Templates state
  const [templates, setTemplates] = useState<WaiverTemplate[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<WaiverTemplate | null>(null);
  const [formTitle, setFormTitle] = useState('');
  const [formBody, setFormBody] = useState('');
  const [formFields, setFormFields] = useState<string[]>(['name', 'signature', 'date']);
  const [formRequireBeforeBooking, setFormRequireBeforeBooking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toastMsg, setToastMsg] = useState('');

  // Signed waivers state
  const [signedWaivers, setSignedWaivers] = useState<SignedWaiver[]>([]);
  const [signedLoading, setSignedLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedSigned, setSelectedSigned] = useState<SignedWaiver | null>(null);

  // Copied link state
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const appUrl = typeof window !== 'undefined' ? window.location.origin : 'https://www.waaiio.com';

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(''), 3000);
  }, []);

  // Fetch templates
  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/waivers/templates?business_id=${business.id}`);
      if (res.ok) {
        const data = await res.json();
        setTemplates(data);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [business.id]);

  // Fetch signed waivers
  const fetchSigned = useCallback(async () => {
    setSignedLoading(true);
    try {
      const params = new URLSearchParams({ business_id: business.id });
      if (search) params.set('search', search);
      const res = await fetch(`/api/waivers/signed?${params}`);
      if (res.ok) {
        const data = await res.json();
        setSignedWaivers(data);
      }
    } catch {
      // silent
    } finally {
      setSignedLoading(false);
    }
  }, [business.id, search]);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  useEffect(() => {
    if (tab === 'signed') fetchSigned();
  }, [tab, fetchSigned]);

  function resetForm() {
    setFormTitle('');
    setFormBody('');
    setFormFields(['name', 'signature', 'date']);
    setFormRequireBeforeBooking(false);
    setEditingTemplate(null);
    setShowForm(false);
  }

  function openEditForm(tpl: WaiverTemplate) {
    setEditingTemplate(tpl);
    setFormTitle(tpl.title);
    setFormBody(tpl.body);
    setFormFields(tpl.fields);
    setFormRequireBeforeBooking(tpl.require_before_booking);
    setShowForm(true);
  }

  async function handleSave() {
    if (!formTitle.trim() || !formBody.trim()) return;
    setSaving(true);

    try {
      if (editingTemplate) {
        // Update
        const res = await fetch(`/api/waivers/templates/${editingTemplate.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: formTitle,
            body: formBody,
            fields: formFields,
            require_before_booking: formRequireBeforeBooking,
          }),
        });
        if (res.ok) {
          showToast('Template updated');
          resetForm();
          fetchTemplates();
        }
      } else {
        // Create
        const res = await fetch('/api/waivers/templates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            business_id: business.id,
            title: formTitle,
            body: formBody,
            fields: formFields,
            require_before_booking: formRequireBeforeBooking,
          }),
        });
        if (res.ok) {
          showToast('Template created');
          resetForm();
          fetchTemplates();
        }
      }
    } catch {
      showToast('Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(tpl: WaiverTemplate) {
    try {
      const res = await fetch(`/api/waivers/templates/${tpl.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !tpl.is_active }),
      });
      if (res.ok) {
        showToast(tpl.is_active ? 'Template deactivated' : 'Template activated');
        fetchTemplates();
      }
    } catch {
      showToast('Failed to update');
    }
  }

  function toggleField(field: string) {
    setFormFields(prev =>
      prev.includes(field) ? prev.filter(f => f !== field) : [...prev, field]
    );
  }

  function copyLink(token: string) {
    const url = `${appUrl}/w/${token}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedToken(token);
      setTimeout(() => setCopiedToken(null), 2000);
    });
  }

  // Get signature URL from Supabase storage
  function getSignatureDisplayUrl(signatureUrl: string | null) {
    if (!signatureUrl) return null;
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    return `${supabaseUrl}/storage/v1/object/public/contracts/${signatureUrl}`;
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Waivers</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Create liability waivers and track signed releases
          </p>
        </div>
        {tab === 'templates' && !showForm && (
          <button
            onClick={() => { resetForm(); setShowForm(true); }}
            className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-700"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Waiver
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="mb-6 flex gap-1 rounded-lg bg-gray-100 dark:bg-gray-800 p-1">
        <button
          onClick={() => setTab('templates')}
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition ${
            tab === 'templates'
              ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          Templates
        </button>
        <button
          onClick={() => setTab('signed')}
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition ${
            tab === 'signed'
              ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          Signed Waivers
        </button>
      </div>

      {/* Templates Tab */}
      {tab === 'templates' && (
        <>
          {/* Form modal */}
          {showForm && (
            <div className="mb-6 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                {editingTemplate ? 'Edit Waiver Template' : 'New Waiver Template'}
              </h2>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Title
                  </label>
                  <input
                    type="text"
                    value={formTitle}
                    onChange={e => setFormTitle(e.target.value)}
                    placeholder="e.g. Liability Release Form"
                    maxLength={300}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2.5 text-sm text-gray-900 dark:text-white focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Waiver Text
                  </label>
                  <textarea
                    value={formBody}
                    onChange={e => setFormBody(e.target.value)}
                    placeholder="Enter the full waiver/release text that participants must read and agree to..."
                    rows={8}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2.5 text-sm text-gray-900 dark:text-white focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Additional Fields
                  </label>
                  <div className="flex flex-wrap gap-3">
                    {FIELD_OPTIONS.map(opt => (
                      <label key={opt.key} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={formFields.includes(opt.key)}
                          onChange={() => toggleField(opt.key)}
                          className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                        />
                        <span className="text-sm text-gray-600 dark:text-gray-400">{opt.label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formRequireBeforeBooking}
                    onChange={e => setFormRequireBeforeBooking(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                  />
                  <span className="text-sm text-gray-600 dark:text-gray-400">
                    Require before booking (coming soon)
                  </span>
                </label>
              </div>

              <div className="mt-6 flex gap-3">
                <button
                  onClick={resetForm}
                  className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 transition hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving || !formTitle.trim() || !formBody.trim()}
                  className="flex-1 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
                >
                  {saving ? 'Saving...' : editingTemplate ? 'Update' : 'Create'}
                </button>
              </div>
            </div>
          )}

          {/* Templates list */}
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-brand" />
            </div>
          ) : templates.length === 0 && !showForm ? (
            <EmptyState
              icon="📋"
              title="No waiver templates yet"
              description="Create a waiver template to start collecting signed liability releases from your customers."
              actionLabel="Create Waiver"
              onAction={() => { resetForm(); setShowForm(true); }}
            />
          ) : (
            <div className="space-y-3">
              {templates.map(tpl => (
                <div
                  key={tpl.id}
                  className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="truncate text-sm font-semibold text-gray-900 dark:text-white">
                          {tpl.title}
                        </h3>
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                            tpl.is_active
                              ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                              : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'
                          }`}
                        >
                          {tpl.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                        Created {new Date(tpl.created_at).toLocaleDateString()}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      {/* Copy Link */}
                      <button
                        onClick={() => copyLink(tpl.token)}
                        className="rounded-lg border border-gray-200 dark:border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 transition hover:bg-gray-50 dark:hover:bg-gray-700"
                      >
                        {copiedToken === tpl.token ? 'Copied!' : 'Copy Link'}
                      </button>

                      {/* Edit */}
                      <button
                        onClick={() => openEditForm(tpl)}
                        className="rounded-lg border border-gray-200 dark:border-gray-600 p-1.5 text-gray-400 transition hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-600"
                        title="Edit"
                      >
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>

                      {/* Toggle active */}
                      <button
                        onClick={() => handleToggleActive(tpl)}
                        className={`rounded-lg border p-1.5 transition ${
                          tpl.is_active
                            ? 'border-red-200 dark:border-red-800 text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
                            : 'border-green-200 dark:border-green-800 text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20'
                        }`}
                        title={tpl.is_active ? 'Deactivate' : 'Activate'}
                      >
                        {tpl.is_active ? (
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                          </svg>
                        ) : (
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Shareable URL */}
                  <div className="mt-3 flex items-center gap-2 rounded-lg bg-gray-50 dark:bg-gray-700/50 px-3 py-2">
                    <svg className="h-4 w-4 flex-shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                    <span className="truncate text-xs text-gray-500 dark:text-gray-400 font-mono">
                      {appUrl}/waiver/{tpl.token}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Signed Waivers Tab */}
      {tab === 'signed' && (
        <>
          {/* Search */}
          <div className="mb-4">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name, phone, or email..."
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2.5 text-sm text-gray-900 dark:text-white focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            />
          </div>

          {signedLoading ? (
            <div className="flex items-center justify-center py-16">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-brand" />
            </div>
          ) : signedWaivers.length === 0 ? (
            <EmptyState
              icon="✍️"
              title="No signed waivers yet"
              description="Share your waiver link with customers. Signed waivers will appear here."
            />
          ) : (
            <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                  <thead className="bg-gray-50 dark:bg-gray-800">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Customer</th>
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Phone</th>
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Waiver</th>
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Signed</th>
                      <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700 bg-white dark:bg-gray-800">
                    {signedWaivers.map(sw => (
                      <tr key={sw.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition">
                        <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white whitespace-nowrap">
                          {sw.customer_name}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                          {sw.customer_phone || '-'}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                          {sw.waiver_templates?.title || '-'}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                          {new Date(sw.signed_at).toLocaleDateString('en-US', {
                            month: 'short', day: 'numeric', year: 'numeric',
                            hour: '2-digit', minute: '2-digit',
                          })}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={() => setSelectedSigned(sw)}
                            className="text-sm font-medium text-brand hover:text-brand-700"
                          >
                            View
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* Signed waiver detail modal */}
      {selectedSigned && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white dark:bg-gray-800 p-6 shadow-xl">
            <div className="flex items-start justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Signed Waiver Details</h2>
              <button
                onClick={() => setSelectedSigned(null)}
                className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Waiver</p>
                <p className="text-sm text-gray-900 dark:text-white">{selectedSigned.waiver_templates?.title}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Customer Name</p>
                <p className="text-sm text-gray-900 dark:text-white">{selectedSigned.customer_name}</p>
              </div>
              {selectedSigned.customer_phone && (
                <div>
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Phone</p>
                  <p className="text-sm text-gray-900 dark:text-white">{selectedSigned.customer_phone}</p>
                </div>
              )}
              {selectedSigned.customer_email && (
                <div>
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Email</p>
                  <p className="text-sm text-gray-900 dark:text-white">{selectedSigned.customer_email}</p>
                </div>
              )}
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Signed At</p>
                <p className="text-sm text-gray-900 dark:text-white">
                  {new Date(selectedSigned.signed_at).toLocaleString()}
                </p>
              </div>

              {/* Metadata fields */}
              {selectedSigned.metadata?.emergency_contact_name && (
                <div>
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Emergency Contact</p>
                  <p className="text-sm text-gray-900 dark:text-white">
                    {selectedSigned.metadata.emergency_contact_name}
                    {selectedSigned.metadata.emergency_contact_phone && ` - ${selectedSigned.metadata.emergency_contact_phone}`}
                  </p>
                </div>
              )}
              {selectedSigned.metadata?.medical_conditions && (
                <div>
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Medical Conditions</p>
                  <p className="text-sm text-gray-900 dark:text-white">{selectedSigned.metadata.medical_conditions}</p>
                </div>
              )}
              {selectedSigned.metadata?.allergies && (
                <div>
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Allergies</p>
                  <p className="text-sm text-gray-900 dark:text-white">{selectedSigned.metadata.allergies}</p>
                </div>
              )}

              {/* Signature image */}
              {selectedSigned.signature_url && (
                <div>
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Signature</p>
                  <div className="rounded-lg border border-gray-200 dark:border-gray-600 bg-white p-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={getSignatureDisplayUrl(selectedSigned.signature_url) || ''}
                      alt="Signature"
                      className="max-h-32 mx-auto"
                    />
                  </div>
                </div>
              )}

              {/* Audit trail */}
              {selectedSigned.audit_trail && (
                <div>
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Audit Trail</p>
                  <div className="rounded-lg bg-gray-50 dark:bg-gray-700/50 p-3 text-xs text-gray-600 dark:text-gray-400 space-y-1">
                    {selectedSigned.audit_trail.ip && <p>IP: {selectedSigned.audit_trail.ip}</p>}
                    {selectedSigned.audit_trail.device_type && <p>Device: {selectedSigned.audit_trail.device_type}</p>}
                    {selectedSigned.audit_trail.signed_at && <p>Timestamp: {selectedSigned.audit_trail.signed_at}</p>}
                  </div>
                </div>
              )}
            </div>

            <button
              onClick={() => setSelectedSigned(null)}
              className="mt-6 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 transition hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Toast */}
      {toastMsg && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-gray-900 px-4 py-2.5 text-sm text-white shadow-lg">
          {toastMsg}
        </div>
      )}
    </div>
  );
}

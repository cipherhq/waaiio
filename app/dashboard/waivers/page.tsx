'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import EmptyState from '@/components/dashboard/EmptyState';
import { PageHelp } from '@/components/dashboard/PageHelp';
import { WAIVER_TEMPLATES, fillWaiverPlaceholders } from '@/lib/waiver-templates';

interface WaiverTemplate {
  id: string;
  title: string;
  body: string;
  fields: string[];
  is_active: boolean;
  require_before_booking: boolean;
  pdf_url: string | null;
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
  access_token: string | null;
  waiver_templates: { title: string; token: string };
}

type ActiveTab = 'templates' | 'signed';
type TemplateMode = 'blank' | 'template' | 'pdf';

const FIELD_OPTIONS = [
  { key: 'emergency_contact', label: 'Emergency Contact' },
  { key: 'medical_conditions', label: 'Medical Conditions' },
  { key: 'allergies', label: 'Allergies' },
];

const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  signature: 'Signature',
  date: 'Date',
  email: 'Email',
  phone: 'Phone',
  emergency_contact: 'Emergency Contact',
  medical_conditions: 'Medical Conditions',
  allergies: 'Allergies',
};

export default function WaiversPage() {
  const business = useBusiness();
  const supabase = createClient();
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
  const [formPdfUrl, setFormPdfUrl] = useState('');
  const [templateMode, setTemplateMode] = useState<TemplateMode>('blank');
  const [selectedIndustryTemplate, setSelectedIndustryTemplate] = useState('');
  const [uploadingPdf, setUploadingPdf] = useState(false);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [toastMsg, setToastMsg] = useState('');

  // Signed waivers state
  const [signedWaivers, setSignedWaivers] = useState<SignedWaiver[]>([]);
  const [signedLoading, setSignedLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filterTemplateId, setFilterTemplateId] = useState('');
  const [selectedSigned, setSelectedSigned] = useState<SignedWaiver | null>(null);

  // Signed count per template
  const [signedCounts, setSignedCounts] = useState<Record<string, number>>({});

  // Copied link + QR modal state
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [qrModal, setQrModal] = useState<WaiverTemplate | null>(null);

  const appUrl = typeof window !== 'undefined' ? window.location.origin : 'https://www.waaiio.com';

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(''), 3000);
  }, []);

  // Fetch templates via direct supabase client (reads)
  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await supabase
        .from('waiver_templates')
        .select('*')
        .eq('business_id', business.id)
        .order('is_active', { ascending: false })
        .order('created_at', { ascending: false });

      setTemplates(data || []);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business.id]);

  // Fetch signed waivers count per template
  const fetchSignedCounts = useCallback(async () => {
    try {
      const { data } = await supabase
        .from('signed_waivers')
        .select('template_id')
        .eq('business_id', business.id);

      if (data) {
        const counts: Record<string, number> = {};
        for (const row of data) {
          counts[row.template_id] = (counts[row.template_id] || 0) + 1;
        }
        setSignedCounts(counts);
      }
    } catch {
      // silent
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business.id]);

  // Fetch signed waivers via API (supports search + filter)
  const fetchSigned = useCallback(async () => {
    setSignedLoading(true);
    try {
      const params = new URLSearchParams({ business_id: business.id });
      if (search) params.set('search', search);
      if (filterTemplateId) params.set('template_id', filterTemplateId);
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
  }, [business.id, search, filterTemplateId]);

  useEffect(() => {
    fetchTemplates();
    fetchSignedCounts();
  }, [fetchTemplates, fetchSignedCounts]);

  useEffect(() => {
    if (tab === 'signed') fetchSigned();
  }, [tab, fetchSigned]);

  function resetForm() {
    setFormTitle('');
    setFormBody('');
    setFormFields(['name', 'signature', 'date']);
    setFormRequireBeforeBooking(false);
    setFormPdfUrl('');
    setTemplateMode('blank');
    setSelectedIndustryTemplate('');
    setEditingTemplate(null);
    setShowForm(false);
  }

  function openEditForm(tpl: WaiverTemplate) {
    setEditingTemplate(tpl);
    setFormTitle(tpl.title);
    setFormBody(tpl.body);
    setFormFields(tpl.fields);
    setFormRequireBeforeBooking(tpl.require_before_booking);
    setFormPdfUrl(tpl.pdf_url || '');
    setTemplateMode(tpl.pdf_url ? 'pdf' : 'blank');
    setSelectedIndustryTemplate('');
    setShowForm(true);
  }

  function handleTemplateModeChange(mode: TemplateMode) {
    setTemplateMode(mode);
    if (mode === 'blank') {
      setFormPdfUrl('');
      setSelectedIndustryTemplate('');
    } else if (mode === 'template') {
      setFormPdfUrl('');
    } else if (mode === 'pdf') {
      setSelectedIndustryTemplate('');
    }
  }

  function handleIndustryTemplateSelect(templateId: string) {
    setSelectedIndustryTemplate(templateId);
    const tpl = WAIVER_TEMPLATES.find(t => t.id === templateId);
    if (tpl) {
      setFormTitle(tpl.name);
      const today = new Date().toLocaleDateString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric',
      });
      setFormBody(fillWaiverPlaceholders(tpl.content, {
        business_name: business.name,
        date: today,
      }));
    }
  }

  async function handlePdfUpload(file: File) {
    if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
      showToast('Only PDF files are allowed');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showToast('File must be under 5MB');
      return;
    }

    setUploadingPdf(true);
    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `waivers/${business.id}/templates/${Date.now()}_${safeName}`;

      const { error: uploadError } = await supabase.storage
        .from('contracts')
        .upload(path, file, { contentType: 'application/pdf', upsert: false });

      if (uploadError) {
        showToast('Failed to upload PDF');
        return;
      }

      const { data: urlData } = supabase.storage
        .from('contracts')
        .getPublicUrl(path);

      setFormPdfUrl(urlData.publicUrl);
      showToast('PDF uploaded');
    } catch {
      showToast('Failed to upload PDF');
    } finally {
      setUploadingPdf(false);
    }
  }

  async function handleSave() {
    const hasPdf = templateMode === 'pdf' && formPdfUrl;
    if (!formTitle.trim() || (!formBody.trim() && !hasPdf)) return;
    setSaving(true);

    try {
      const payload = {
        title: formTitle,
        body: formBody || '',
        fields: formFields,
        require_before_booking: formRequireBeforeBooking,
        pdf_url: hasPdf ? formPdfUrl : null,
      };

      if (editingTemplate) {
        const res = await fetch(`/api/waivers/templates/${editingTemplate.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          showToast('Template updated');
          resetForm();
          fetchTemplates();
        }
      } else {
        const res = await fetch('/api/waivers/templates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ business_id: business.id, ...payload }),
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

  function getSignatureDisplayUrl(signatureUrl: string | null) {
    if (!signatureUrl) return null;
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    return `${supabaseUrl}/storage/v1/object/public/contracts/${signatureUrl}`;
  }

  // Sort templates: active first, then inactive
  const sortedTemplates = [...templates].sort((a, b) => {
    if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      {/* PageHelp */}
      <PageHelp
        pageKey="waivers"
        title="Waivers"
        description="Create digital liability waivers and release forms. Share a link with customers to sign before their appointment or event. Track all signed waivers in one place."
      />

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
          {Object.values(signedCounts).reduce((a, b) => a + b, 0) > 0 && (
            <span className="ml-1.5 inline-flex items-center rounded-full bg-brand/10 px-1.5 py-0.5 text-xs font-medium text-brand">
              {Object.values(signedCounts).reduce((a, b) => a + b, 0)}
            </span>
          )}
        </button>
      </div>

      {/* ===== Templates Tab ===== */}
      {tab === 'templates' && (
        <>
          {/* Create/Edit Form */}
          {showForm && (
            <div className="mb-6 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                {editingTemplate ? 'Edit Waiver Template' : 'New Waiver Template'}
              </h2>

              <div className="space-y-4">
                {/* Template mode selector -- only for new templates */}
                {!editingTemplate && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Start from
                    </label>
                    <div className="flex gap-2">
                      {([
                        { key: 'blank' as TemplateMode, label: 'Blank' },
                        { key: 'template' as TemplateMode, label: 'Industry Template' },
                        { key: 'pdf' as TemplateMode, label: 'Upload PDF' },
                      ]).map(opt => (
                        <button
                          key={opt.key}
                          type="button"
                          onClick={() => handleTemplateModeChange(opt.key)}
                          className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                            templateMode === opt.key
                              ? 'bg-brand text-white'
                              : 'border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Industry template selector */}
                {templateMode === 'template' && !editingTemplate && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      Choose a template
                    </label>
                    <select
                      value={selectedIndustryTemplate}
                      onChange={e => handleIndustryTemplateSelect(e.target.value)}
                      className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2.5 text-sm text-gray-900 dark:text-white focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                    >
                      <option value="">Select a template...</option>
                      <optgroup label="Fitness">
                        <option value="fitness">Fitness &amp; Gym Liability Waiver</option>
                      </optgroup>
                      <optgroup label="Beauty &amp; Wellness">
                        <option value="salon-spa">Salon &amp; Spa Treatment Waiver</option>
                        <option value="tattoo">Tattoo &amp; Body Art Consent</option>
                      </optgroup>
                      <optgroup label="Recreation">
                        <option value="adventure">Adventure &amp; Sports Activity Waiver</option>
                      </optgroup>
                      <optgroup label="Healthcare">
                        <option value="medical">Medical/Health Treatment Consent</option>
                      </optgroup>
                      <optgroup label="Events">
                        <option value="event">Event Participation Waiver</option>
                      </optgroup>
                      <optgroup label="Real Estate">
                        <option value="property">Property Viewing / Short-Let Waiver</option>
                      </optgroup>
                      <optgroup label="General">
                        <option value="general">General Liability Waiver</option>
                      </optgroup>
                    </select>
                  </div>
                )}

                {/* Title */}
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

                {/* PDF upload OR text body */}
                {templateMode === 'pdf' ? (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      Waiver PDF
                    </label>
                    {formPdfUrl ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700/50 px-3 py-2.5">
                          <svg className="h-5 w-5 flex-shrink-0 text-red-500" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
                          </svg>
                          <span className="truncate text-sm text-gray-700 dark:text-gray-300">PDF uploaded</span>
                          <button
                            type="button"
                            onClick={() => { setFormPdfUrl(''); if (pdfInputRef.current) pdfInputRef.current.value = ''; }}
                            className="ml-auto text-sm font-medium text-red-500 hover:text-red-600"
                          >
                            Remove
                          </button>
                        </div>
                        <iframe src={formPdfUrl} className="w-full h-48 rounded-lg border border-gray-200 dark:border-gray-600" title="PDF preview" />
                      </div>
                    ) : (
                      <div className="relative">
                        <div
                          onClick={() => pdfInputRef.current?.click()}
                          className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700/50 px-4 py-8 transition hover:border-brand"
                        >
                          <svg className="mb-2 h-8 w-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                          </svg>
                          <p className="text-sm font-medium text-gray-600 dark:text-gray-400">
                            {uploadingPdf ? 'Uploading...' : 'Click to upload PDF'}
                          </p>
                          <p className="mt-1 text-xs text-gray-400">PDF only, max 5MB</p>
                        </div>
                        <input
                          ref={pdfInputRef}
                          type="file"
                          accept=".pdf,application/pdf"
                          className="hidden"
                          onChange={e => {
                            const file = e.target.files?.[0];
                            if (file) handlePdfUpload(file);
                          }}
                        />
                      </div>
                    )}
                    <div className="mt-2">
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                        Description (optional)
                      </label>
                      <textarea
                        value={formBody}
                        onChange={e => setFormBody(e.target.value)}
                        placeholder="Optional description or summary of the PDF waiver..."
                        rows={3}
                        className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2.5 text-sm text-gray-900 dark:text-white focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                      />
                    </div>
                  </div>
                ) : (
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
                )}

                {/* Additional fields checkboxes */}
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

                {/* Require before booking toggle */}
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formRequireBeforeBooking}
                    onChange={e => setFormRequireBeforeBooking(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                  />
                  <span className="text-sm text-gray-600 dark:text-gray-400">
                    Require before booking
                  </span>
                </label>
              </div>

              {/* Form actions */}
              <div className="mt-6 flex gap-3">
                <button
                  onClick={resetForm}
                  className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 transition hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving || !formTitle.trim() || (!formBody.trim() && !(templateMode === 'pdf' && formPdfUrl))}
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
              {sortedTemplates.map(tpl => (
                <div
                  key={tpl.id}
                  className={`rounded-xl border bg-white dark:bg-gray-800 p-4 shadow-sm transition ${
                    tpl.is_active
                      ? 'border-gray-200 dark:border-gray-700'
                      : 'border-gray-200 dark:border-gray-700 opacity-60'
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      {/* Title + badges */}
                      <div className="flex flex-wrap items-center gap-2">
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
                        {tpl.pdf_url && (
                          <span className="inline-flex items-center rounded-full bg-red-100 dark:bg-red-900/30 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-400">
                            PDF
                          </span>
                        )}
                        {tpl.require_before_booking && (
                          <span className="inline-flex items-center rounded-full bg-blue-100 dark:bg-blue-900/30 px-2 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-400">
                            Required before booking
                          </span>
                        )}
                      </div>

                      {/* Body preview */}
                      {tpl.body && (
                        <p className="mt-1 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">
                          {tpl.body}
                        </p>
                      )}

                      {/* Fields list */}
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {tpl.fields.map(f => (
                          <span
                            key={f}
                            className="inline-flex items-center rounded bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:text-gray-400"
                          >
                            {FIELD_LABELS[f] || f}
                          </span>
                        ))}
                      </div>

                      {/* Meta: created date + signed count */}
                      <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
                        Created {new Date(tpl.created_at).toLocaleDateString()}
                        {signedCounts[tpl.id] ? (
                          <span className="ml-2 font-medium text-brand">
                            {signedCounts[tpl.id]} signed
                          </span>
                        ) : null}
                      </p>
                    </div>

                    {/* Action buttons */}
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => setQrModal(tpl)}
                        className="rounded-lg border border-gray-200 dark:border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 transition hover:bg-gray-50 dark:hover:bg-gray-700"
                        title="QR Code"
                      >
                        QR
                      </button>
                      <button
                        onClick={() => copyLink(tpl.token)}
                        className="rounded-lg border border-gray-200 dark:border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 transition hover:bg-gray-50 dark:hover:bg-gray-700"
                      >
                        {copiedToken === tpl.token ? 'Copied!' : 'Share'}
                      </button>
                      <button
                        onClick={() => openEditForm(tpl)}
                        className="rounded-lg border border-gray-200 dark:border-gray-600 p-1.5 text-gray-400 transition hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-600"
                        title="Edit"
                      >
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
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
                      {appUrl}/w/{tpl.token}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ===== Signed Waivers Tab ===== */}
      {tab === 'signed' && (
        <>
          {/* Search + filter row */}
          <div className="mb-4 flex flex-col gap-3 sm:flex-row">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name, phone, or email..."
              className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2.5 text-sm text-gray-900 dark:text-white focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            />
            {templates.length > 0 && (
              <select
                value={filterTemplateId}
                onChange={e => setFilterTemplateId(e.target.value)}
                className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2.5 text-sm text-gray-900 dark:text-white focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand sm:w-56"
              >
                <option value="">All templates</option>
                {templates.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.title} ({signedCounts[t.id] || 0})
                  </option>
                ))}
              </select>
            )}
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
                      <th className="hidden px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 sm:table-cell">Phone</th>
                      <th className="hidden px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 md:table-cell">Email</th>
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
                        <td className="hidden px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap sm:table-cell">
                          {sw.customer_phone || '-'}
                        </td>
                        <td className="hidden px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap md:table-cell">
                          {sw.customer_email || '-'}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                          {sw.waiver_templates?.title || '-'}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                          {new Date(sw.signed_at).toLocaleDateString('en-US', {
                            month: 'short', day: 'numeric', year: 'numeric',
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

      {/* ===== Signed Waiver Detail Modal ===== */}
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

            {/* View full document link */}
            <a
              href={`/w/view/${selectedSigned.id}?token=${selectedSigned.access_token || ''}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand/90"
            >
              View Full Document
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
            <button
              onClick={() => setSelectedSigned(null)}
              className="mt-2 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 transition hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Toast notification */}
      {toastMsg && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-gray-900 px-4 py-2.5 text-sm text-white shadow-lg">
          {toastMsg}
        </div>
      )}

      {/* QR Code Modal */}
      {qrModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setQrModal(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-center text-lg font-bold text-gray-900 dark:text-white">
              {qrModal.title}
            </h3>
            <p className="mt-1 text-center text-sm text-brand font-medium">
              Scan to Sign Waiver
            </p>

            <div className="mt-5 flex justify-center">
              <div className="rounded-xl border border-gray-100 p-4 dark:border-gray-700">
                <QRCodeCanvas
                  value={`${appUrl}/w/${qrModal.token}`}
                  size={220}
                  level="H"
                />
              </div>
            </div>

            <p className="mt-3 text-center text-[10px] font-medium tracking-wider text-gray-300 dark:text-gray-600">
              Powered by Waaiio
            </p>

            <p className="mt-2 break-all text-center font-mono text-xs text-gray-400">
              {appUrl}/w/{qrModal.token}
            </p>

            <div className="mt-5 flex gap-2">
              <button
                onClick={() => copyLink(qrModal.token)}
                className="flex-1 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300"
              >
                {copiedToken === qrModal.token ? 'Copied!' : 'Copy Link'}
              </button>
              <button
                onClick={() => {
                  const canvas = document.querySelector('#waiver-qr-download canvas') as HTMLCanvasElement;
                  if (!canvas) return;
                  const url = canvas.toDataURL('image/png');
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `${qrModal.title.replace(/\s+/g, '-').toLowerCase()}-waiver-qr.png`;
                  a.click();
                }}
                className="flex-1 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
              >
                Download QR
              </button>
            </div>

            {/* Hidden high-res QR for download */}
            <div id="waiver-qr-download" className="hidden">
              <QRCodeCanvas
                value={`${appUrl}/w/${qrModal.token}`}
                size={600}
                level="H"
              />
            </div>

            <button
              onClick={() => setQrModal(null)}
              className="mt-3 w-full text-center text-sm text-gray-400 hover:text-gray-600"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

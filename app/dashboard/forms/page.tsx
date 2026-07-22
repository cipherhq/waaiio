'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness, useRequireCapability } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { getPhonePlaceholder, type CountryCode } from '@/lib/constants';
import { PageHelp } from '@/components/dashboard/PageHelp';

interface FormField {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'email' | 'phone' | 'select' | 'radio' | 'checkbox' | 'multi_select' | 'date' | 'file';
  required: boolean;
  placeholder?: string;
  options?: string[]; // for select type
}

interface Form {
  id: string;
  title: string;
  description: string | null;
  fields: FormField[];
  token: string | null;
  is_active: boolean;
  response_count: number;
  created_at: string;
}

interface FormResponse {
  id: string;
  customer_phone: string | null;
  customer_name: string | null;
  customer_email: string | null;
  answers: Record<string, unknown>;
  business_notes: string | null;
  status: string;
  channel: string | null;
  submitted_at: string;
}

type ViewMode = 'list' | 'add' | 'edit' | 'responses';

const FIELD_TYPES: Array<{ value: FormField['type']; label: string }> = [
  { value: 'text', label: 'Short Text' },
  { value: 'textarea', label: 'Long Text' },
  { value: 'number', label: 'Number' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'select', label: 'Dropdown' },
  { value: 'radio', label: 'Radio Buttons' },
  { value: 'multi_select', label: 'Multi Select' },
  { value: 'checkbox', label: 'Checkbox (Yes/No)' },
  { value: 'date', label: 'Date' },
];

function generateToken(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 24);
}

function generateFieldId(): string {
  return `f_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export default function FormsPage() {
  const allowed = useRequireCapability('survey');
  const business = useBusiness();
  const appUrl = typeof window !== 'undefined' ? window.location.origin : (process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com');
  const [forms, setForms] = useState<Form[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>('list');
  const [saving, setSaving] = useState(false);
  const [selectedForm, setSelectedForm] = useState<Form | null>(null);
  const [responses, setResponses] = useState<FormResponse[]>([]);
  const [copied, setCopied] = useState(false);
  const [editingNotes, setEditingNotes] = useState<Record<string, string>>({});
  const [savingNotes, setSavingNotes] = useState<string | null>(null);

  // Send form state
  const [sendPhone, setSendPhone] = useState('');
  const [sendingForm, setSendingForm] = useState(false);

  // Form builder state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [fields, setFields] = useState<FormField[]>([]);
  const [editId, setEditId] = useState('');
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null);

  // New field state
  const [newLabel, setNewLabel] = useState('');
  const [newType, setNewType] = useState<FormField['type']>('text');
  const [newRequired, setNewRequired] = useState(false);
  const [newOptions, setNewOptions] = useState('');

  const loadForms = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from('forms')
      .select('id, title, description, fields, token, is_active, response_count, created_at')
      .eq('business_id', business.id)
      .order('created_at', { ascending: false });
    setForms((data || []) as Form[]);
    setLoading(false);
  }, [business.id]);

  useEffect(() => { loadForms(); }, [loadForms]);

  function openAdd() {
    setEditId('');
    setTitle('');
    setDescription('');
    setFields([]);
    setView('add');
  }

  function openEdit(form: Form) {
    setEditId(form.id);
    setTitle(form.title);
    setDescription(form.description || '');
    setFields(form.fields || []);
    setView('edit');
  }

  async function openResponses(form: Form) {
    setSelectedForm(form);
    setView('responses');
    const supabase = createClient();
    const { data } = await supabase
      .from('form_responses')
      .select('id, customer_phone, customer_name, customer_email, answers, business_notes, status, channel, submitted_at')
      .eq('form_id', form.id)
      .order('submitted_at', { ascending: false });
    setResponses((data || []) as FormResponse[]);
  }

  function addField() {
    if (!newLabel.trim()) return;
    const field: FormField = {
      id: generateFieldId(),
      label: newLabel.trim(),
      type: newType,
      required: newRequired,
    };
    if (['select', 'radio', 'multi_select'].includes(newType) && newOptions.trim()) {
      field.options = newOptions.split(',').map(o => o.trim()).filter(Boolean);
    }
    setFields([...fields, field]);
    setNewLabel('');
    setNewType('text');
    setNewRequired(false);
    setNewOptions('');
  }

  function updateField(fieldId: string, updates: Partial<FormField>) {
    setFields(fields.map(f => f.id === fieldId ? { ...f, ...updates } : f));
  }

  function removeField(fieldId: string) {
    setFields(fields.filter(f => f.id !== fieldId));
    if (editingFieldId === fieldId) setEditingFieldId(null);
  }

  function moveField(index: number, direction: 'up' | 'down') {
    const newFields = [...fields];
    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= newFields.length) return;
    [newFields[index], newFields[swapIndex]] = [newFields[swapIndex], newFields[index]];
    setFields(newFields);
  }

  async function handleSave() {
    if (!title.trim() || fields.length === 0) return;
    setSaving(true);
    const supabase = createClient();
    const payload = {
      business_id: business.id,
      title: title.trim(),
      description: description.trim() || null,
      fields,
      is_active: true,
    };

    if (view === 'add') {
      await supabase.from('forms').insert({ ...payload, token: generateToken() });
    } else {
      await supabase.from('forms').update(payload).eq('id', editId);
    }
    setSaving(false);
    setView('list');
    loadForms();
  }

  async function handleDelete(formId: string) {
    if (!confirm('Delete this form and all its responses?')) return;
    const supabase = createClient();
    await supabase.from('forms').delete().eq('id', formId);
    if (view !== 'list') setView('list');
    loadForms();
  }

  async function handleToggle(form: Form) {
    const supabase = createClient();
    await supabase.from('forms').update({ is_active: !form.is_active }).eq('id', form.id);
    loadForms();
  }

  function copyLink(token: string) {
    navigator.clipboard.writeText(`${appUrl}/form/${token}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleSendForm(form: Form) {
    if (!sendPhone.trim() || !form.token) return;
    setSendingForm(true);
    try {
      const res = await fetch('/api/forms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          formId: form.id,
          businessId: business.id,
          phone: sendPhone.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to send form');
      } else {
        setSendPhone('');
        loadForms(); // refresh response counts
      }
    } catch {
      alert('Network error. Please try again.');
    }
    setSendingForm(false);
  }

  async function saveNotes(responseId: string) {
    setSavingNotes(responseId);
    const supabase = createClient();
    const notes = editingNotes[responseId] ?? '';
    await supabase.from('form_responses').update({ business_notes: notes || null }).eq('id', responseId);
    setResponses(prev => prev.map(r => r.id === responseId ? { ...r, business_notes: notes || null } : r));
    setSavingNotes(null);
  }

  if (!allowed) return null;

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  // ═══════════ RESPONSES VIEW ═══════════
  if (view === 'responses' && selectedForm) {
    return (
      <div>
        <div className="flex items-center gap-3">
          <button aria-label="Go back" onClick={() => setView('list')} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100">
            <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div>
            <h1 className="text-xl font-bold text-gray-900">{selectedForm.title}</h1>
            <p className="text-sm text-gray-500">
              {responses.filter(r => r.status === 'submitted').length} responded · {responses.filter(r => r.status === 'sent').length} pending
            </p>
          </div>
        </div>

        {responses.length === 0 ? (
          <div className="mt-8 text-center text-sm text-gray-400">No responses yet. Send the form to customers to start collecting data.</div>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-100 bg-gray-50">
                <tr>
                  <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Respondent</th>
                  {selectedForm.fields.slice(0, 5).map(f => (
                    <th key={f.id} className="px-4 py-3 text-left font-medium text-gray-500">{f.label}</th>
                  ))}
                  <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                  <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Date</th>
                  <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {responses.map(r => {
                  const formatValue = (val: unknown) => {
                    if (val === undefined || val === null || val === '') return '—';
                    if (typeof val === 'boolean') return val ? 'Yes' : 'No';
                    if (Array.isArray(val)) return val.join(', ');
                    return String(val);
                  };

                  return (
                    <tr key={r.id} className={`hover:bg-gray-50 ${r.status === 'sent' ? 'bg-yellow-50/30' : ''}`}>
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-900">{r.customer_name || 'Anonymous'}</p>
                        {r.customer_phone && <p className="text-xs text-gray-400">{r.customer_phone}</p>}
                        {r.customer_email && <p className="text-xs text-gray-400">{r.customer_email}</p>}
                      </td>
                      {selectedForm.fields.slice(0, 5).map(f => (
                        <td key={f.id} className="px-4 py-3 text-gray-700 max-w-[200px] truncate">
                          {r.status === 'sent' && Object.keys(r.answers).length === 0 ? (
                            <span className="text-yellow-500 text-xs">Pending</span>
                          ) : formatValue(r.answers[f.id])}
                        </td>
                      ))}
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          r.status === 'submitted' ? 'bg-green-100 text-green-700' :
                          r.status === 'sent' ? 'bg-yellow-100 text-yellow-700' :
                          'bg-gray-100 text-gray-600'
                        }`}>{r.status === 'sent' ? 'Awaiting' : 'Done'}</span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">
                        {new Date(r.submitted_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <input
                            type="text"
                            value={editingNotes[r.id] ?? r.business_notes ?? ''}
                            onChange={e => setEditingNotes(prev => ({ ...prev, [r.id]: e.target.value }))}
                            placeholder="Add note..."
                            className="w-32 rounded border border-gray-200 px-2 py-1 text-xs outline-none focus:border-brand"
                          />
                          {(editingNotes[r.id] ?? r.business_notes ?? '') !== (r.business_notes ?? '') && (
                            <button onClick={() => saveNotes(r.id)} disabled={savingNotes === r.id}
                              className="rounded bg-brand px-2 py-1 text-xs text-white disabled:opacity-50">
                              {savingNotes === r.id ? '...' : '✓'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  // ═══════════ ADD / EDIT FORM ═══════════
  if (view === 'add' || view === 'edit') {
    return (
      <div>
        <div className="flex items-center gap-3">
          <button aria-label="Go back" onClick={() => setView('list')} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100">
            <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-xl font-bold text-gray-900">{view === 'add' ? 'Create Form' : 'Edit Form'}</h1>
        </div>

        <div className="mt-5 space-y-4 max-w-2xl">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Form Title <span className="text-red-400">*</span></label>
            <input type="text" value={title} onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Guest Registration, Patient Intake"
              className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" autoFocus />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Description</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2}
              placeholder="Brief description shown at the top of the form"
              className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" />
          </div>

          {/* Fields list */}
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700">Fields ({fields.length})</label>
            {fields.length > 0 && (
              <div className="mb-3 space-y-2">
                {fields.map((f, i) => (
                  <div key={f.id} className="rounded-lg border border-gray-200 bg-white overflow-hidden">
                    {/* Field header — click to expand/collapse edit */}
                    <div className="flex items-center gap-2 px-3 py-2">
                      <div className="flex flex-col gap-0.5">
                        <button onClick={() => moveField(i, 'up')} disabled={i === 0} className="text-gray-300 hover:text-gray-500 disabled:invisible">
                          <svg aria-hidden="true" className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>
                        </button>
                        <button onClick={() => moveField(i, 'down')} disabled={i === fields.length - 1} className="text-gray-300 hover:text-gray-500 disabled:invisible">
                          <svg aria-hidden="true" className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                        </button>
                      </div>
                      <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setEditingFieldId(editingFieldId === f.id ? null : f.id)}>
                        <span className="text-sm font-medium text-gray-900">{f.label}</span>
                        <span className="ml-2 text-xs text-gray-400">{f.type}</span>
                        {f.required && <span className="ml-1 text-xs text-red-400">*</span>}
                      </div>
                      <button onClick={() => setEditingFieldId(editingFieldId === f.id ? null : f.id)}
                        className="text-xs text-gray-400 hover:text-brand">
                        {editingFieldId === f.id ? 'Done' : 'Edit'}
                      </button>
                      <button onClick={() => removeField(f.id)} className="text-xs text-red-400 hover:text-red-600">Remove</button>
                    </div>

                    {/* Inline edit panel */}
                    {editingFieldId === f.id && (
                      <div className="border-t border-gray-100 bg-gray-50 px-3 py-3 space-y-2">
                        <div className="grid grid-cols-[1fr_auto] gap-2">
                          <input type="text" value={f.label}
                            onChange={e => updateField(f.id, { label: e.target.value })}
                            placeholder="Field label"
                            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-brand" />
                          <select value={f.type}
                            onChange={e => updateField(f.id, { type: e.target.value as FormField['type'] })}
                            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-brand">
                            {FIELD_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                          </select>
                        </div>
                        {['select', 'radio', 'multi_select'].includes(f.type) && (
                          <input type="text" value={(f.options || []).join(', ')}
                            onChange={e => updateField(f.id, { options: e.target.value.split(',').map(o => o.trim()).filter(Boolean) })}
                            placeholder="Options (comma separated)"
                            className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-brand" />
                        )}
                        <input type="text" value={f.placeholder || ''}
                          onChange={e => updateField(f.id, { placeholder: e.target.value || undefined })}
                          placeholder="Placeholder text (optional)"
                          className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-brand" />
                        <label className="flex items-center gap-2 text-xs text-gray-600">
                          <input type="checkbox" checked={f.required}
                            onChange={e => updateField(f.id, { required: e.target.checked })}
                            className="rounded" />
                          Required field
                        </label>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Add field */}
            <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 space-y-3">
              <p className="text-xs font-medium text-gray-500">Add Field</p>
              <div className="grid grid-cols-[1fr_auto_auto] gap-2">
                <input type="text" value={newLabel} onChange={e => setNewLabel(e.target.value)}
                  placeholder="Field label (e.g. Full Name)"
                  className="rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                  onKeyDown={e => { if (e.key === 'Enter') addField(); }} />
                <select value={newType} onChange={e => setNewType(e.target.value as FormField['type'])}
                  className="rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand">
                  {FIELD_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <button onClick={addField} disabled={!newLabel.trim()}
                  className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">Add</button>
              </div>
              {['select', 'radio', 'multi_select'].includes(newType) && (
                <input type="text" value={newOptions} onChange={e => setNewOptions(e.target.value)}
                  placeholder="Options (comma separated): e.g. Male, Female, Other"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand" />
              )}
              <label className="flex items-center gap-2 text-xs text-gray-500">
                <input type="checkbox" checked={newRequired} onChange={e => setNewRequired(e.target.checked)} className="rounded" />
                Required field
              </label>
            </div>
          </div>
        </div>

        <div className="mt-6 flex gap-3 border-t border-gray-100 pt-4">
          <button onClick={handleSave} disabled={saving || !title.trim() || fields.length === 0}
            className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50">
            {saving ? 'Saving...' : view === 'add' ? 'Create Form' : 'Save Changes'}
          </button>
          <button onClick={() => setView('list')}
            className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50">Cancel</button>
          {view === 'edit' && editId && (
            <button onClick={() => handleDelete(editId)}
              className="ml-auto rounded-lg px-4 py-2.5 text-sm font-medium text-red-500 hover:bg-red-50">Delete</button>
          )}
        </div>
      </div>
    );
  }

  // ═══════════ LIST VIEW ═══════════
  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Forms</h1>
          <p className="mt-1 text-sm text-gray-500">Create forms and collect data from customers via shareable links</p>
          <PageHelp
            pageKey="forms"
            title="Custom Forms"
            description="Build custom forms and send them to customers via WhatsApp or shareable links. Collect information, applications, or feedback with multiple field types."
          />
        </div>
        <button onClick={openAdd} className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600">
          + New Form
        </button>
      </div>

      {forms.length === 0 ? (
        <div className="mt-12 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-50">
            <svg aria-hidden="true" className="h-8 w-8 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <h3 className="mt-4 text-sm font-semibold text-gray-900">No forms yet</h3>
          <p className="mt-1 text-sm text-gray-500">Create a form to start collecting data from customers</p>
          <button onClick={openAdd} className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600">
            + New Form
          </button>
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {forms.map(form => (
            <div key={form.id} className="rounded-xl border border-gray-100 bg-white p-5 transition hover:shadow-sm">
              <div className="flex items-start justify-between">
                <div className="min-w-0 flex-1 cursor-pointer" onClick={() => openEdit(form)}>
                  <h3 className="text-sm font-semibold text-gray-900">{form.title}</h3>
                  {form.description && <p className="mt-0.5 text-xs text-gray-500">{form.description}</p>}
                  <div className="mt-2 flex items-center gap-3 text-xs text-gray-400">
                    <span>{form.fields.length} field{form.fields.length !== 1 ? 's' : ''}</span>
                    <span>{form.response_count} response{form.response_count !== 1 ? 's' : ''}</span>
                    <span className={form.is_active ? 'text-green-600' : 'text-gray-400'}>{form.is_active ? 'Active' : 'Inactive'}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 ml-4">
                  <button onClick={() => handleToggle(form)}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition ${form.is_active ? 'bg-brand' : 'bg-gray-200'}`}>
                    <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: form.is_active ? '22px' : '2px' }} />
                  </button>
                </div>
              </div>

              {/* Actions */}
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-gray-50 pt-3">
                {form.token && (
                  <button onClick={() => copyLink(form.token!)}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">
                    {copied ? '✓ Copied!' : 'Copy Link'}
                  </button>
                )}
                <button onClick={() => openResponses(form)}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">
                  View Responses ({form.response_count})
                </button>
                <div className="flex items-center gap-1 ml-auto">
                  <input type="text" value={sendPhone} onChange={e => setSendPhone(e.target.value)}
                    placeholder={getPhonePlaceholder((business.country_code || 'NG') as CountryCode)}
                    className="w-36 rounded-lg border border-gray-200 px-2 py-1.5 text-xs outline-none focus:border-brand" />
                  <button onClick={() => handleSendForm(form)} disabled={sendingForm || !sendPhone.trim()}
                    className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50">
                    {sendingForm ? '...' : 'Send'}
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

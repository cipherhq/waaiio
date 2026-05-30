'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ReturnToWhatsApp } from '@/components/ReturnToWhatsApp';
import { PhoneInput } from '@/components/auth/PhoneInput';
import { createClient } from '@/lib/supabase/client';

interface FormField {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'email' | 'phone' | 'select' | 'radio' | 'checkbox' | 'multi_select' | 'date' | 'file';
  required: boolean;
  placeholder?: string;
  options?: string[];
}

interface FormData {
  title: string;
  description: string | null;
  fields: FormField[];
  business_name: string;
  business_phone: string | null;
  business_logo: string | null;
}

type PageState = 'loading' | 'ready' | 'submitting' | 'submitted' | 'error';

export default function PublicFormPage() {
  const { token } = useParams<{ token: string }>();
  const [form, setForm] = useState<FormData | null>(null);
  const [state, setState] = useState<PageState>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [uploading, setUploading] = useState<Record<string, boolean>>({});

  useEffect(() => {
    async function loadForm() {
      try {
        const res = await fetch(`/api/forms/public/${token}`);
        if (!res.ok) {
          const data = await res.json();
          setErrorMsg(data.error || 'Form not found');
          setState('error');
          return;
        }
        const data = await res.json();
        setForm(data);
        setState('ready');
      } catch {
        setErrorMsg('Unable to load form');
        setState('error');
      }
    }
    if (token) loadForm();
  }, [token]);

  function updateAnswer(fieldId: string, value: unknown) {
    setAnswers(prev => ({ ...prev, [fieldId]: value }));
  }

  async function handleFileUpload(fieldId: string, file: File) {
    setUploading(prev => ({ ...prev, [fieldId]: true }));
    try {
      const supabase = createClient();
      const ext = file.name.split('.').pop() || 'bin';
      const path = `form-uploads/${token}/${fieldId}-${Date.now()}.${ext}`;
      const { error: uploadError } = await supabase.storage
        .from('business-documents')
        .upload(path, file, { upsert: true });
      if (uploadError) {
        setErrorMsg(`Upload failed: ${uploadError.message}`);
        return;
      }
      const { data: urlData } = supabase.storage
        .from('business-documents')
        .getPublicUrl(path);
      updateAnswer(fieldId, urlData.publicUrl);
    } catch {
      setErrorMsg('File upload failed. Please try again.');
    } finally {
      setUploading(prev => ({ ...prev, [fieldId]: false }));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;

    // Validate required fields
    for (const field of form.fields) {
      if (field.required) {
        const val = answers[field.id];
        if (val === undefined || val === null || val === '' || (field.type === 'checkbox' && val === false)) {
          setErrorMsg(`"${field.label}" is required`);
          return;
        }
      }
    }

    setState('submitting');
    setErrorMsg('');

    try {
      const res = await fetch(`/api/forms/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          answers,
          // Auto-extract contact info from form answers by field type
          customer_name: (() => {
            const nameField = form.fields.find(f => f.label.toLowerCase().includes('name') && f.type === 'text');
            return nameField ? String(answers[nameField.id] || '') : '';
          })() || null,
          customer_phone: (() => {
            const phoneField = form.fields.find(f => f.type === 'phone');
            return phoneField ? String(answers[phoneField.id] || '') : '';
          })() || null,
          customer_email: (() => {
            const emailField = form.fields.find(f => f.type === 'email');
            return emailField ? String(answers[emailField.id] || '') : '';
          })() || null,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setErrorMsg(data.error || 'Submission failed');
        setState('ready');
        return;
      }

      setState('submitted');
    } catch {
      setErrorMsg('Something went wrong. Please try again.');
      setState('ready');
    }
  }

  if (state === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-gray-200 border-t-violet-600" />
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6">
        <div className="max-w-sm text-center">
          <div className="text-4xl mb-3">📋</div>
          <h1 className="text-xl font-bold text-gray-900">Form Not Available</h1>
          <p className="mt-2 text-sm text-gray-500">{errorMsg}</p>
        </div>
      </div>
    );
  }

  if (state === 'submitted') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6">
        <div className="max-w-sm text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
            <svg className="h-8 w-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="mt-4 text-xl font-bold text-gray-900">Thank You!</h1>
          <p className="mt-2 text-sm text-gray-500">Your response has been submitted successfully.</p>
          <ReturnToWhatsApp phone={form?.business_phone || undefined} />
          <p className="mt-4 text-xs text-gray-400">Powered by Waaiio</p>
        </div>
      </div>
    );
  }

  if (!form) return null;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-lg px-4 py-8">
        {/* Header */}
        <div className="mb-6">
          {form.business_logo && (
            <img src={form.business_logo} alt={form.business_name} className="mb-3 h-10 rounded" />
          )}
          <p className="text-xs font-medium text-gray-400">{form.business_name}</p>
          <h1 className="text-2xl font-bold text-gray-900">{form.title}</h1>
          {form.description && <p className="mt-1 text-sm text-gray-500">{form.description}</p>}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Form fields */}
          <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
            {form.fields.map(field => (
              <div key={field.id}>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  {field.label} {field.required && <span className="text-red-400">*</span>}
                </label>

                {field.type === 'text' && (
                  <input type="text" value={(answers[field.id] as string) || ''}
                    onChange={e => updateAnswer(field.id, e.target.value)}
                    placeholder={field.placeholder}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500" />
                )}
                {field.type === 'textarea' && (
                  <textarea value={(answers[field.id] as string) || ''}
                    onChange={e => updateAnswer(field.id, e.target.value)}
                    rows={3} placeholder={field.placeholder}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500" />
                )}
                {field.type === 'number' && (
                  <input type="number" value={(answers[field.id] as string) || ''}
                    onChange={e => updateAnswer(field.id, e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500" />
                )}
                {field.type === 'email' && (
                  <input type="email" value={(answers[field.id] as string) || ''}
                    onChange={e => updateAnswer(field.id, e.target.value)}
                    placeholder="email@example.com"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500" />
                )}
                {field.type === 'phone' && (
                  <PhoneInput
                    value={(answers[field.id] as string) || ''}
                    onChange={val => updateAnswer(field.id, val)}
                    countryCode="US"
                  />
                )}
                {field.type === 'date' && (
                  <input type="date" value={(answers[field.id] as string) || ''}
                    onChange={e => updateAnswer(field.id, e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500" />
                )}
                {field.type === 'select' && (
                  <select value={(answers[field.id] as string) || ''}
                    onChange={e => updateAnswer(field.id, e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500">
                    <option value="">Select...</option>
                    {(field.options || []).map(opt => <option key={opt} value={opt}>{opt}</option>)}
                  </select>
                )}
                {field.type === 'radio' && (
                  <div className="space-y-2">
                    {(field.options || []).map(opt => (
                      <label key={opt} className="flex items-center gap-2 cursor-pointer">
                        <input type="radio" name={field.id} value={opt}
                          checked={(answers[field.id] as string) === opt}
                          onChange={() => updateAnswer(field.id, opt)}
                          className="border-gray-300 text-violet-600 focus:ring-violet-500" />
                        <span className="text-sm text-gray-700">{opt}</span>
                      </label>
                    ))}
                  </div>
                )}
                {field.type === 'multi_select' && (
                  <div className="space-y-2">
                    {(field.options || []).map(opt => {
                      const selected = ((answers[field.id] as string[]) || []).includes(opt);
                      return (
                        <label key={opt} className="flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" checked={selected}
                            onChange={() => {
                              const current = (answers[field.id] as string[]) || [];
                              updateAnswer(field.id, selected ? current.filter(v => v !== opt) : [...current, opt]);
                            }}
                            className="rounded border-gray-300 text-violet-600 focus:ring-violet-500" />
                          <span className="text-sm text-gray-700">{opt}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
                {field.type === 'checkbox' && (
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={!!answers[field.id]}
                      onChange={e => updateAnswer(field.id, e.target.checked)}
                      className="rounded border-gray-300 text-violet-600 focus:ring-violet-500" />
                    <span className="text-sm text-gray-600">Yes</span>
                  </label>
                )}
                {field.type === 'file' && (
                  <div>
                    <input
                      type="file"
                      accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
                      onChange={e => {
                        const file = e.target.files?.[0];
                        if (file) handleFileUpload(field.id, file);
                      }}
                      disabled={uploading[field.id]}
                      className="w-full text-sm text-gray-500 file:mr-3 file:rounded-lg file:border-0 file:bg-violet-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-violet-700 hover:file:bg-violet-100 disabled:opacity-50"
                    />
                    {uploading[field.id] && (
                      <p className="mt-1 text-xs text-gray-400">Uploading...</p>
                    )}
                    {!!answers[field.id] && !uploading[field.id] && (
                      <p className="mt-1 text-xs text-green-600">File uploaded successfully</p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          {errorMsg && <p className="text-sm text-red-600">{errorMsg}</p>}

          <button type="submit" disabled={state === 'submitting'}
            className="w-full rounded-xl bg-violet-600 px-6 py-3.5 text-sm font-bold text-white shadow-md transition hover:bg-violet-700 disabled:opacity-50">
            {state === 'submitting' ? 'Submitting...' : 'Submit'}
          </button>

          <p className="text-center text-xs text-gray-400">Powered by Waaiio</p>
        </form>
      </div>
    </div>
  );
}

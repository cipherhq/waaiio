'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';

interface FAQ {
  id: string;
  business_id: string;
  question: string;
  answer: string;
  keywords: string[];
  sort_order: number;
  is_active: boolean;
  hit_count: number;
  created_at: string;
}

const SUGGESTED_FAQS = [
  {
    key: 'hours',
    question: 'What are your hours?',
    answerFn: (biz: { operating_hours: Record<string, { open: string; close: string; closed?: boolean }> | null }) => {
      const hours = biz.operating_hours;
      if (!hours || Object.keys(hours).length === 0) return 'Please contact us for our current hours.';
      const lines = Object.entries(hours)
        .map(([day, schedule]) => {
          if (schedule.closed) return `${day.charAt(0).toUpperCase() + day.slice(1)}: Closed`;
          return `${day.charAt(0).toUpperCase() + day.slice(1)}: ${schedule.open} - ${schedule.close}`;
        })
        .join('\n');
      return lines;
    },
    keywords: ['hours', 'open', 'close', 'time', 'schedule'],
  },
  {
    key: 'location',
    question: 'Where are you located?',
    answerFn: (biz: { address: string; city: string }) => {
      return biz.address ? `We are located at ${biz.address}, ${biz.city}.` : 'Please contact us for our location.';
    },
    keywords: ['location', 'address', 'where', 'directions'],
  },
  {
    key: 'booking',
    question: 'How do I book?',
    answerFn: () => 'Send Hi to our WhatsApp number to get started!',
    keywords: ['book', 'appointment', 'reserve', 'schedule'],
  },
  {
    key: 'cancellation',
    question: "What's your cancellation policy?",
    answerFn: () => 'You can cancel up to 4 hours before your booking.',
    keywords: ['cancel', 'cancellation', 'refund', 'reschedule'],
  },
];

type ViewMode = 'list' | 'add' | 'edit';

export default function FAQPage() {
  const business = useBusiness();
  const [faqs, setFaqs] = useState<FAQ[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<ViewMode>('list');

  // Form state
  const [formId, setFormId] = useState<string | null>(null);
  const [formQuestion, setFormQuestion] = useState('');
  const [formAnswer, setFormAnswer] = useState('');
  const [formKeywordsInput, setFormKeywordsInput] = useState('');
  const [formKeywords, setFormKeywords] = useState<string[]>([]);
  const [formIsActive, setFormIsActive] = useState(true);
  const [formHitCount, setFormHitCount] = useState(0);

  const fetchFaqs = useCallback(async () => {
    try {
      const res = await fetch(`/api/faq?businessId=${business.id}`);
      const data = await res.json();
      setFaqs(data.faqs || []);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [business.id]);

  useEffect(() => {
    fetchFaqs();
  }, [fetchFaqs]);

  function resetForm() {
    setFormId(null);
    setFormQuestion('');
    setFormAnswer('');
    setFormKeywordsInput('');
    setFormKeywords([]);
    setFormIsActive(true);
    setFormHitCount(0);
  }

  function openAdd() {
    resetForm();
    setView('add');
  }

  function openEdit(faq: FAQ) {
    setFormId(faq.id);
    setFormQuestion(faq.question);
    setFormAnswer(faq.answer);
    setFormKeywords(faq.keywords || []);
    setFormKeywordsInput('');
    setFormIsActive(faq.is_active);
    setFormHitCount(faq.hit_count || 0);
    setView('edit');
  }

  function handleKeywordsKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const value = formKeywordsInput.trim().replace(/,/g, '');
      if (value && !formKeywords.includes(value)) {
        setFormKeywords((prev) => [...prev, value]);
      }
      setFormKeywordsInput('');
    }
  }

  function removeKeyword(keyword: string) {
    setFormKeywords((prev) => prev.filter((k) => k !== keyword));
  }

  async function handleSave() {
    if (!formQuestion.trim() || !formAnswer.trim()) return;
    setSaving(true);

    // Collect any remaining text in the keywords input
    const finalKeywords = [...formKeywords];
    if (formKeywordsInput.trim()) {
      const remaining = formKeywordsInput.trim().split(',').map((s) => s.trim()).filter(Boolean);
      remaining.forEach((k) => {
        if (!finalKeywords.includes(k)) finalKeywords.push(k);
      });
    }

    try {
      if (view === 'edit' && formId) {
        await fetch('/api/faq', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: formId,
            businessId: business.id,
            question: formQuestion.trim(),
            answer: formAnswer.trim(),
            keywords: finalKeywords,
            isActive: formIsActive,
          }),
        });
      } else {
        await fetch('/api/faq', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            businessId: business.id,
            question: formQuestion.trim(),
            answer: formAnswer.trim(),
            keywords: finalKeywords,
          }),
        });
      }
      resetForm();
      setView('list');
      fetchFaqs();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!formId || !confirm(`Delete "${formQuestion}"?`)) return;
    await fetch(`/api/faq?id=${formId}&businessId=${business.id}`, { method: 'DELETE' });
    resetForm();
    setView('list');
    fetchFaqs();
  }

  async function handleAddSuggested(suggested: (typeof SUGGESTED_FAQS)[number]) {
    setSaving(true);
    try {
      const answer = suggested.answerFn(business as never);
      await fetch('/api/faq', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId: business.id,
          question: suggested.question,
          answer,
          keywords: suggested.keywords,
        }),
      });
      fetchFaqs();
    } finally {
      setSaving(false);
    }
  }

  // Check which suggested FAQs already exist
  const existingQuestions = faqs.map((f) => f.question.toLowerCase());

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  // ═══════════════════════════════════════════
  // ADD / EDIT — Full-page two-column form
  // ═══════════════════════════════════════════
  if (view === 'add' || view === 'edit') {
    return (
      <div>
        {/* Header */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => { resetForm(); setView('list'); }}
            className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-xl font-bold text-gray-900">
            {view === 'add' ? 'Add FAQ' : 'Edit FAQ'}
          </h1>
        </div>

        <div className="mt-5 grid gap-6 lg:grid-cols-[1fr_280px]">
          {/* Left column: Main fields */}
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Question <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={formQuestion}
                onChange={(e) => setFormQuestion(e.target.value)}
                placeholder="e.g., What are your hours?"
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
                autoFocus
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Answer <span className="text-red-400">*</span>
              </label>
              <textarea
                value={formAnswer}
                onChange={(e) => setFormAnswer(e.target.value)}
                rows={4}
                placeholder="The response that will be sent to the customer..."
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Keywords</label>
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 focus-within:border-brand focus-within:ring-1 focus-within:ring-brand">
                {formKeywords.map((kw) => (
                  <span
                    key={kw}
                    className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700"
                  >
                    {kw}
                    <button
                      type="button"
                      onClick={() => removeKeyword(kw)}
                      className="ml-0.5 text-brand-400 hover:text-brand-700"
                    >
                      x
                    </button>
                  </span>
                ))}
                <input
                  type="text"
                  value={formKeywordsInput}
                  onChange={(e) => setFormKeywordsInput(e.target.value)}
                  onKeyDown={handleKeywordsKeyDown}
                  placeholder={formKeywords.length === 0 ? 'Type a keyword and press Enter or comma...' : 'Add more...'}
                  className="min-w-[120px] flex-1 border-none bg-transparent py-0.5 text-sm outline-none"
                />
              </div>
              <p className="mt-1 text-xs text-gray-400">
                Press Enter or comma to add a keyword. These help match customer messages to this FAQ.
              </p>
            </div>
          </div>

          {/* Right column: Settings */}
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Settings</p>

            <ToggleRow
              label="Active"
              description="Auto-respond when customers ask this question"
              checked={formIsActive}
              onChange={(v) => setFormIsActive(v)}
            />

            {view === 'edit' && (
              <div className="rounded-lg border border-gray-100 bg-gray-50 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Hit Count</p>
                <p className="mt-1 text-lg font-bold text-gray-900">{formHitCount}</p>
                <p className="mt-0.5 text-xs text-gray-400">Times this FAQ auto-responded</p>
              </div>
            )}
          </div>
        </div>

        {/* Save / Cancel / Delete footer */}
        <div className="mt-6 flex gap-3 border-t border-gray-100 pt-4">
          <button
            onClick={handleSave}
            disabled={saving || !formQuestion.trim() || !formAnswer.trim()}
            className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {saving ? 'Saving...' : view === 'add' ? 'Add FAQ' : 'Save Changes'}
          </button>
          <button
            onClick={() => { resetForm(); setView('list'); }}
            className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
          {view === 'edit' && formId && (
            <button
              onClick={handleDelete}
              className="ml-auto rounded-lg px-4 py-2.5 text-sm font-medium text-red-500 hover:bg-red-50"
            >
              Delete FAQ
            </button>
          )}
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════
  // FAQ LIST
  // ═══════════════════════════════════════════
  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="pr-4">
          <h1 className="text-2xl font-bold text-gray-900">FAQ Bot</h1>
          <p className="mt-1 text-sm text-gray-500">
            Auto-respond to common customer questions via WhatsApp
          </p>
        </div>
        <button
          onClick={openAdd}
          className="shrink-0 rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-600"
        >
          + Add FAQ
        </button>
      </div>

      {/* FAQ List */}
      <div className="mt-6 space-y-3">
        {faqs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-200 p-12 text-center">
            <p className="text-sm text-gray-500">No FAQs yet. Add your first FAQ to auto-respond to customer questions.</p>
            <button
              onClick={openAdd}
              className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
            >
              + Add FAQ
            </button>
          </div>
        ) : (
          faqs.map((faq) => (
            <div
              key={faq.id}
              onClick={() => openEdit(faq)}
              className={`cursor-pointer rounded-xl border bg-white p-5 transition hover:shadow-sm ${
                faq.is_active ? 'border-gray-200' : 'border-gray-100 opacity-60'
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1 pr-4">
                  {/* Question */}
                  <div className="flex items-center gap-3">
                    <div className="flex shrink-0 flex-col gap-0.5">
                      <div className="h-0.5 w-4 rounded bg-gray-300" />
                      <div className="h-0.5 w-4 rounded bg-gray-300" />
                      <div className="h-0.5 w-4 rounded bg-gray-300" />
                    </div>
                    <h3 className="text-sm font-bold text-gray-900">{faq.question}</h3>
                  </div>

                  {/* Answer (truncated) */}
                  <p className="mt-2 line-clamp-2 pl-7 text-sm text-gray-600">
                    {faq.answer}
                  </p>

                  {/* Keywords */}
                  {faq.keywords && faq.keywords.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5 pl-7">
                      {faq.keywords.map((kw) => (
                        <span
                          key={kw}
                          className="inline-flex rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600"
                        >
                          {kw}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Right side: hit count and status */}
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
                    {faq.hit_count || 0} hits
                  </span>
                  {!faq.is_active && (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
                      Inactive
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Suggested FAQs */}
      <div className="mt-10">
        <h2 className="text-lg font-semibold text-gray-900">Suggested FAQs</h2>
        <p className="mt-1 text-sm text-gray-500">
          One-click add common questions pre-filled with your business info.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {SUGGESTED_FAQS.map((suggested) => {
            const alreadyExists = existingQuestions.includes(suggested.question.toLowerCase());
            const previewAnswer = suggested.answerFn(business as never);

            return (
              <div
                key={suggested.key}
                className={`rounded-xl border bg-white p-5 ${
                  alreadyExists ? 'border-green-200 bg-green-50/30' : 'border-gray-200'
                }`}
              >
                <h4 className="text-sm font-bold text-gray-900">{suggested.question}</h4>
                <p className="mt-2 line-clamp-3 whitespace-pre-line text-xs text-gray-600">
                  {previewAnswer}
                </p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {suggested.keywords.map((kw) => (
                    <span
                      key={kw}
                      className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500"
                    >
                      {kw}
                    </span>
                  ))}
                </div>
                <div className="mt-4">
                  {alreadyExists ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600">
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      Already added
                    </span>
                  ) : (
                    <button
                      onClick={() => handleAddSuggested(suggested)}
                      disabled={saving}
                      className="rounded-lg border border-brand bg-brand-50 px-4 py-2 text-xs font-semibold text-brand hover:bg-brand-100 disabled:opacity-50"
                    >
                      + Add This FAQ
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Reusable toggle row ──
function ToggleRow({ label, description, checked, onChange }: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-gray-100 bg-white p-3">
      <div className="mr-3">
        <p className="text-sm font-medium text-gray-800">{label}</p>
        <p className="text-xs text-gray-400">{description}</p>
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition ${checked ? 'bg-brand' : 'bg-gray-200'}`}
      >
        <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: checked ? '22px' : '2px' }} />
      </button>
    </div>
  );
}

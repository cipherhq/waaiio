'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness, useRequireCapability } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { PageHeader } from '@/components/dashboard/PageHeader';
import { PAGE_TOOLTIPS } from '@/lib/tooltips';

interface SurveyQuestion {
  id: string;
  type: 'choice' | 'rating' | 'text' | 'yes_no';
  text: string;
  options?: string[];
  required?: boolean;
}

interface Survey {
  id: string;
  business_id: string;
  title: string;
  description: string | null;
  questions: SurveyQuestion[];
  status: 'draft' | 'active' | 'closed';
  total_responses: number;
  created_at: string;
  updated_at: string;
}

interface SurveyResponse {
  id: string;
  customer_phone: string;
  customer_name: string | null;
  answers: Record<string, unknown>;
  completed: boolean;
  started_at: string;
  completed_at: string | null;
}

interface Contact {
  phone: string;
  first_name: string | null;
  last_name: string | null;
}

type View = 'list' | 'create' | 'results' | 'send';

export default function SurveysPage() {
  const allowed = useRequireCapability('survey');
  const business = useBusiness();
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>('list');
  const [selectedSurvey, setSelectedSurvey] = useState<Survey | null>(null);
  const [responses, setResponses] = useState<SurveyResponse[]>([]);
  const [responsesLoading, setResponsesLoading] = useState(false);

  // Create form
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [questions, setQuestions] = useState<SurveyQuestion[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Send
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedPhones, setSelectedPhones] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ sent: number; failed: number } | null>(null);

  const tier = business.subscription_tier || 'free';
  const isGated = tier === 'free';

  const fetchSurveys = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/surveys?business_id=${business.id}`);
      if (res.ok) {
        const data = await res.json();
        setSurveys(data.surveys || []);
      }
    } catch {
      // Non-critical
    }
    setLoading(false);
  }, [business.id]);

  useEffect(() => {
    if (!isGated) fetchSurveys();
    else setLoading(false);
  }, [fetchSurveys, isGated]);

  const loadResponses = async (survey: Survey) => {
    setSelectedSurvey(survey);
    setView('results');
    setResponsesLoading(true);
    try {
      const res = await fetch(`/api/surveys/${survey.id}/responses?limit=500`);
      if (res.ok) {
        const data = await res.json();
        setResponses(data.responses || []);
      }
    } catch {
      // Non-critical
    }
    setResponsesLoading(false);
  };

  const loadContacts = async (survey: Survey) => {
    setSelectedSurvey(survey);
    setView('send');
    setSendResult(null);
    const supabase = createClient();
    const { data: sessions } = await supabase
      .from('bot_sessions')
      .select('whatsapp_number, user_id')
      .eq('business_id', business.id);

    const phoneMap = new Map<string, Contact>();
    for (const s of sessions || []) {
      if (s.whatsapp_number && !phoneMap.has(s.whatsapp_number)) {
        phoneMap.set(s.whatsapp_number, { phone: s.whatsapp_number, first_name: null, last_name: null });
      }
    }

    // Enrich with profile names
    const userIds = (sessions || []).filter(s => s.user_id).map(s => s.user_id);
    if (userIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, phone, first_name, last_name')
        .in('id', userIds);
      for (const p of profiles || []) {
        if (p.phone && phoneMap.has(p.phone)) {
          phoneMap.set(p.phone, { phone: p.phone, first_name: p.first_name, last_name: p.last_name });
        }
      }
    }

    setContacts(Array.from(phoneMap.values()));
    setSelectedPhones(Array.from(phoneMap.keys())); // Select all by default
  };

  const handleCreate = async () => {
    setError(null);
    if (!title.trim()) { setError('Title is required'); return; }
    if (questions.length === 0) { setError('Add at least one question'); return; }
    for (const q of questions) {
      if (!q.text.trim()) { setError('All questions must have text'); return; }
      if (q.type === 'choice' && (!q.options || q.options.length < 2)) {
        setError('Choice questions need at least 2 options'); return;
      }
    }

    setSaving(true);
    try {
      const res = await fetch('/api/surveys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: business.id,
          title: title.trim(),
          description: description.trim() || undefined,
          questions,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to create survey');
      } else {
        setTitle('');
        setDescription('');
        setQuestions([]);
        setView('list');
        fetchSurveys();
      }
    } catch {
      setError('Network error');
    }
    setSaving(false);
  };

  const toggleStatus = async (survey: Survey) => {
    const newStatus = survey.status === 'active' ? 'closed' : 'active';
    await fetch(`/api/surveys/${survey.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });
    fetchSurveys();
  };

  const deleteSurvey = async (id: string) => {
    if (!confirm('Delete this survey and all its responses?')) return;
    await fetch(`/api/surveys/${id}`, { method: 'DELETE' });
    fetchSurveys();
  };

  const sendSurvey = async () => {
    if (!selectedSurvey || selectedPhones.length === 0) return;
    setSending(true);
    try {
      const res = await fetch(`/api/surveys/${selectedSurvey.id}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phones: selectedPhones }),
      });
      if (res.ok) {
        const data = await res.json();
        setSendResult(data);
        fetchSurveys();
      }
    } catch {
      // Error
    }
    setSending(false);
  };

  const addQuestion = (type: SurveyQuestion['type']) => {
    const id = `q${questions.length + 1}`;
    const q: SurveyQuestion = { id, type, text: '', required: true };
    if (type === 'choice') q.options = ['', ''];
    setQuestions([...questions, q]);
  };

  const updateQuestion = (index: number, updates: Partial<SurveyQuestion>) => {
    const copy = [...questions];
    copy[index] = { ...copy[index], ...updates };
    setQuestions(copy);
  };

  const removeQuestion = (index: number) => {
    setQuestions(questions.filter((_, i) => i !== index));
  };

  const addOption = (qIndex: number) => {
    const copy = [...questions];
    copy[qIndex].options = [...(copy[qIndex].options || []), ''];
    setQuestions(copy);
  };

  const updateOption = (qIndex: number, oIndex: number, value: string) => {
    const copy = [...questions];
    const opts = [...(copy[qIndex].options || [])];
    opts[oIndex] = value;
    copy[qIndex].options = opts;
    setQuestions(copy);
  };

  const removeOption = (qIndex: number, oIndex: number) => {
    const copy = [...questions];
    copy[qIndex].options = (copy[qIndex].options || []).filter((_, i) => i !== oIndex);
    setQuestions(copy);
  };

  if (!allowed) return null;

  // ── Tier Gate ──
  if (isGated) {
    return (
      <div className="space-y-6">
        <PageHeader title="Surveys" tooltip={PAGE_TOOLTIPS.surveys} />
        <div className="rounded-lg border border-gray-200 bg-white p-12 text-center dark:border-gray-700 dark:bg-gray-800">
          <div className="text-4xl mb-4">📊</div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">Surveys available on Pro plan</h2>
          <p className="text-gray-500 dark:text-gray-400 mb-4">Create custom surveys and send them to your customers via WhatsApp. Track responses and analyze results in real-time.</p>
          <a href="/dashboard/settings" className="inline-flex items-center px-4 py-2 bg-black text-white rounded-lg hover:bg-gray-800 text-sm font-medium">
            Upgrade Plan
          </a>
        </div>
      </div>
    );
  }

  // ── Results View ──
  if (view === 'results' && selectedSurvey) {
    const completedResponses = responses.filter(r => r.completed);
    const completionRate = responses.length > 0 ? Math.round((completedResponses.length / responses.length) * 100) : 0;

    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <button onClick={() => { setView('list'); setSelectedSurvey(null); }} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
            <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <PageHeader title={selectedSurvey.title} description={`${completedResponses.length} completed responses`} />
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
            <p className="text-sm text-gray-500 dark:text-gray-400">Total Responses</p>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{responses.length}</p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
            <p className="text-sm text-gray-500 dark:text-gray-400">Completed</p>
            <p className="text-2xl font-bold text-green-600">{completedResponses.length}</p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
            <p className="text-sm text-gray-500 dark:text-gray-400">Completion Rate</p>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{completionRate}%</p>
          </div>
        </div>

        {responsesLoading ? (
          <div className="text-center py-12 text-gray-500">Loading responses...</div>
        ) : (
          <>
            {/* Per-question breakdown */}
            {selectedSurvey.questions.map((q, qi) => (
              <div key={q.id} className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
                <h3 className="font-medium text-gray-900 dark:text-gray-100 mb-3">Q{qi + 1}: {q.text}</h3>
                {(q.type === 'choice' || q.type === 'yes_no') && (
                  <div className="space-y-2">
                    {(() => {
                      const opts = q.type === 'yes_no' ? ['Yes', 'No'] : (q.options || []);
                      const counts: Record<string, number> = {};
                      opts.forEach(o => { counts[o] = 0; });
                      completedResponses.forEach(r => {
                        const val = String(r.answers[q.id] || '');
                        if (val in counts) counts[val]++;
                      });
                      const total = completedResponses.length || 1;
                      return opts.map(opt => (
                        <div key={opt} className="flex items-center gap-3">
                          <span className="w-24 text-sm text-gray-600 dark:text-gray-400 truncate">{opt}</span>
                          <div className="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-5 overflow-hidden">
                            <div
                              className="bg-black dark:bg-white h-full rounded-full transition-all"
                              style={{ width: `${Math.round((counts[opt] / total) * 100)}%` }}
                            />
                          </div>
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300 w-12 text-right">
                            {counts[opt]} ({Math.round((counts[opt] / total) * 100)}%)
                          </span>
                        </div>
                      ));
                    })()}
                  </div>
                )}
                {q.type === 'rating' && (
                  <div className="space-y-2">
                    {[5, 4, 3, 2, 1].map(rating => {
                      const count = completedResponses.filter(r => Number(r.answers[q.id]) === rating).length;
                      const total = completedResponses.length || 1;
                      return (
                        <div key={rating} className="flex items-center gap-3">
                          <span className="w-24 text-sm text-gray-600 dark:text-gray-400">{rating} star{rating !== 1 ? 's' : ''}</span>
                          <div className="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-5 overflow-hidden">
                            <div
                              className="bg-yellow-400 h-full rounded-full transition-all"
                              style={{ width: `${Math.round((count / total) * 100)}%` }}
                            />
                          </div>
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300 w-12 text-right">
                            {count} ({Math.round((count / total) * 100)}%)
                          </span>
                        </div>
                      );
                    })}
                    {(() => {
                      const ratings = completedResponses.map(r => Number(r.answers[q.id])).filter(n => n > 0);
                      const avg = ratings.length > 0 ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : '-';
                      return <p className="text-sm text-gray-500 mt-2">Average: {avg}/5</p>;
                    })()}
                  </div>
                )}
                {q.type === 'text' && (
                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {completedResponses.filter(r => r.answers[q.id]).map(r => (
                      <div key={r.id} className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-700/50 rounded px-3 py-2">
                        <span className="font-medium">{r.customer_name || r.customer_phone}:</span> {String(r.answers[q.id] || '—')}
                      </div>
                    ))}
                    {completedResponses.filter(r => r.answers[q.id]).length === 0 && (
                      <p className="text-sm text-gray-400">No text responses yet</p>
                    )}
                  </div>
                )}
              </div>
            ))}

            {/* Individual responses table */}
            {completedResponses.length > 0 && (
              <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 overflow-hidden">
                <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-700">
                  <h3 className="font-medium text-gray-900 dark:text-gray-100">Individual Responses</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 dark:bg-gray-700/50">
                        <th scope="col" className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Customer</th>
                        {selectedSurvey.questions.map((q, i) => (
                          <th key={q.id} className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Q{i + 1}</th>
                        ))}
                        <th scope="col" className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                      {completedResponses.map(r => (
                        <tr key={r.id}>
                          <td className="px-4 py-2 text-gray-900 dark:text-gray-100">{r.customer_name || r.customer_phone}</td>
                          {selectedSurvey.questions.map(q => (
                            <td key={q.id} className="px-4 py-2 text-gray-600 dark:text-gray-400 max-w-[200px] truncate">
                              {String(r.answers[q.id] ?? '-')}
                            </td>
                          ))}
                          <td className="px-4 py-2 text-gray-500">{new Date(r.completed_at || r.started_at).toLocaleDateString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  // ── Send View ──
  if (view === 'send' && selectedSurvey) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <button onClick={() => { setView('list'); setSelectedSurvey(null); }} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
            <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <PageHeader title={`Send: ${selectedSurvey.title}`} description={`${contacts.length} contacts available`} />
        </div>

        {sendResult ? (
          <div className="rounded-lg border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/20 p-6 text-center">
            <div className="text-3xl mb-2">✅</div>
            <p className="text-lg font-medium text-green-800 dark:text-green-200">Survey sent to {sendResult.sent} contact{sendResult.sent !== 1 ? 's' : ''}</p>
            {sendResult.failed > 0 && <p className="text-sm text-red-600 mt-1">{sendResult.failed} failed</p>}
            <button onClick={() => { setView('list'); setSelectedSurvey(null); }} className="mt-4 px-4 py-2 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-800">
              Back to Surveys
            </button>
          </div>
        ) : (
          <>
            <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Select contacts ({selectedPhones.length}/{contacts.length})</p>
                <button
                  onClick={() => setSelectedPhones(selectedPhones.length === contacts.length ? [] : contacts.map(c => c.phone))}
                  className="text-xs text-blue-600 hover:text-blue-800"
                >
                  {selectedPhones.length === contacts.length ? 'Deselect all' : 'Select all'}
                </button>
              </div>
              <div className="max-h-60 overflow-y-auto space-y-1">
                {contacts.map(c => (
                  <label key={c.phone} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedPhones.includes(c.phone)}
                      onChange={(e) => {
                        setSelectedPhones(e.target.checked
                          ? [...selectedPhones, c.phone]
                          : selectedPhones.filter(p => p !== c.phone));
                      }}
                      className="rounded"
                    />
                    <span className="text-sm text-gray-900 dark:text-gray-100">
                      {c.first_name ? `${c.first_name} ${c.last_name || ''}`.trim() : c.phone}
                    </span>
                    {c.first_name && <span className="text-xs text-gray-400">{c.phone}</span>}
                  </label>
                ))}
                {contacts.length === 0 && (
                  <p className="text-sm text-gray-400 py-4 text-center">No contacts yet. Contacts appear after customers message your WhatsApp bot.</p>
                )}
              </div>
            </div>

            <button
              onClick={sendSurvey}
              disabled={sending || selectedPhones.length === 0}
              className="w-full py-3 bg-black text-white rounded-lg font-medium hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {sending ? 'Sending...' : `Send to ${selectedPhones.length} contact${selectedPhones.length !== 1 ? 's' : ''}`}
            </button>
          </>
        )}
      </div>
    );
  }

  // ── Create View ──
  if (view === 'create') {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <button onClick={() => setView('list')} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
            <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <PageHeader title="Create Survey" />
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Survey Title</label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g., Customer Satisfaction Survey"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description (optional)</label>
            <input
              type="text"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Brief description shown to customers"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            />
          </div>
        </div>

        {/* Questions */}
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Questions ({questions.length})</h3>

          {questions.map((q, qi) => (
            <div key={qi} className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-gray-400 uppercase">{q.type === 'yes_no' ? 'Yes/No' : q.type}</span>
                    <span className="text-xs text-gray-300">Q{qi + 1}</span>
                  </div>
                  <input
                    type="text"
                    value={q.text}
                    onChange={e => updateQuestion(qi, { text: e.target.value })}
                    placeholder="Enter your question..."
                    className="w-full rounded border border-gray-200 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                  />

                  {q.type === 'choice' && (
                    <div className="space-y-2">
                      {(q.options || []).map((opt, oi) => (
                        <div key={oi} className="flex items-center gap-2">
                          <input
                            type="text"
                            value={opt}
                            onChange={e => updateOption(qi, oi, e.target.value)}
                            placeholder={`Option ${oi + 1}`}
                            className="flex-1 rounded border border-gray-200 px-3 py-1 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                          />
                          {(q.options?.length || 0) > 2 && (
                            <button onClick={() => removeOption(qi, oi)} className="text-red-400 hover:text-red-600 text-xs">Remove</button>
                          )}
                        </div>
                      ))}
                      {(q.options?.length || 0) < 10 && (
                        <button onClick={() => addOption(qi)} className="text-xs text-blue-600 hover:text-blue-800">+ Add option</button>
                      )}
                    </div>
                  )}
                </div>
                <button onClick={() => removeQuestion(qi)} className="text-gray-400 hover:text-red-500 p-1">
                  <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                </button>
              </div>
            </div>
          ))}

          {/* Add question buttons */}
          <div className="flex flex-wrap gap-2">
            <button onClick={() => addQuestion('choice')} className="px-3 py-1.5 text-xs font-medium border border-gray-300 rounded-lg hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300">
              + Multiple Choice
            </button>
            <button onClick={() => addQuestion('rating')} className="px-3 py-1.5 text-xs font-medium border border-gray-300 rounded-lg hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300">
              + Rating (1-5)
            </button>
            <button onClick={() => addQuestion('yes_no')} className="px-3 py-1.5 text-xs font-medium border border-gray-300 rounded-lg hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300">
              + Yes/No
            </button>
            <button onClick={() => addQuestion('text')} className="px-3 py-1.5 text-xs font-medium border border-gray-300 rounded-lg hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300">
              + Open Text
            </button>
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-600">{error}</p>
        )}

        <div className="flex gap-3">
          <button onClick={() => setView('list')} className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300">
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={saving}
            className="px-6 py-2 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-800 disabled:opacity-50"
          >
            {saving ? 'Creating...' : 'Create Survey'}
          </button>
        </div>
      </div>
    );
  }

  // ── List View (default) ──
  const activeSurveys = surveys.filter(s => s.status === 'active').length;
  const totalResponses = surveys.reduce((sum, s) => sum + (s.total_responses || 0), 0);

  return (
    <div className="space-y-6">
      <PageHeader title="Surveys" tooltip={PAGE_TOOLTIPS.surveys}>
        <button
          onClick={() => setView('create')}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-800"
        >
          <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
          New Survey
        </button>
      </PageHeader>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <p className="text-sm text-gray-500 dark:text-gray-400">Total Surveys</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{surveys.length}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <p className="text-sm text-gray-500 dark:text-gray-400">Active</p>
          <p className="text-2xl font-bold text-green-600">{activeSurveys}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <p className="text-sm text-gray-500 dark:text-gray-400">Total Responses</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{totalResponses}</p>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading surveys...</div>
      ) : surveys.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-12 text-center dark:border-gray-700 dark:bg-gray-800">
          <div className="text-4xl mb-4">📊</div>
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-1">No surveys yet</h3>
          <p className="text-sm text-gray-500 mb-4">Create your first survey to start collecting customer feedback via WhatsApp.</p>
          <button
            onClick={() => setView('create')}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-800"
          >
            Create Survey
          </button>
        </div>
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700">
                <th scope="col" className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Survey</th>
                <th scope="col" className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Status</th>
                <th scope="col" className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Questions</th>
                <th scope="col" className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Responses</th>
                <th scope="col" className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Created</th>
                <th scope="col" className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {surveys.map(s => (
                <tr key={s.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                  <td className="px-4 py-3">
                    <button onClick={() => loadResponses(s)} className="font-medium text-gray-900 dark:text-gray-100 hover:text-blue-600 text-left">
                      {s.title}
                    </button>
                    {s.description && <p className="text-xs text-gray-400 truncate max-w-[200px]">{s.description}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      s.status === 'active' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                      s.status === 'closed' ? 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400' :
                      'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                    }`}>
                      {s.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{s.questions?.length || 0}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{s.total_responses || 0}</td>
                  <td className="px-4 py-3 text-gray-500">{new Date(s.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {s.status === 'active' && (
                        <button onClick={() => loadContacts(s)} className="text-xs text-blue-600 hover:text-blue-800 font-medium">Send</button>
                      )}
                      <button onClick={() => toggleStatus(s)} className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
                        {s.status === 'active' ? 'Close' : 'Activate'}
                      </button>
                      <button onClick={() => loadResponses(s)} className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Results</button>
                      <button onClick={() => deleteSurvey(s.id)} className="text-xs text-red-500 hover:text-red-700">Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

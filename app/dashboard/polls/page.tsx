'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { PageHeader } from '@/components/dashboard/PageHeader';
import { PAGE_TOOLTIPS } from '@/lib/tooltips';

interface Poll {
  id: string;
  question: string;
  options: string[];
  status: 'draft' | 'active' | 'closed';
  total_votes: number;
  allow_change_vote: boolean;
  show_results: string;
  closes_at: string | null;
  created_at: string;
}

interface PollResult {
  option: string;
  votes: number;
  percentage: number;
}

interface Contact {
  phone: string;
  first_name: string | null;
}

type View = 'list' | 'create' | 'results' | 'send';

export default function PollsPage() {
  const business = useBusiness();
  const [polls, setPolls] = useState<Poll[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>('list');
  const [selected, setSelected] = useState<Poll | null>(null);
  const [results, setResults] = useState<PollResult[]>([]);
  const [totalVotes, setTotalVotes] = useState(0);

  // Create form
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [allowChange, setAllowChange] = useState(false);
  const [showResults, setShowResults] = useState('after_vote');
  const [closesAt, setClosesAt] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Send
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedPhones, setSelectedPhones] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ sent: number; failed: number } | null>(null);

  const tier = business.subscription_tier || 'free';
  const isGated = tier === 'free';

  const fetchPolls = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/polls?business_id=${business.id}`);
    if (res.ok) { const d = await res.json(); setPolls(d.polls || []); }
    setLoading(false);
  }, [business.id]);

  useEffect(() => { if (!isGated) fetchPolls(); else setLoading(false); }, [fetchPolls, isGated]);

  const loadResults = async (poll: Poll) => {
    setSelected(poll); setView('results');
    const res = await fetch(`/api/polls/${poll.id}/results`);
    if (res.ok) { const d = await res.json(); setResults(d.results || []); setTotalVotes(d.total_votes || 0); }
  };

  const loadContacts = async (poll: Poll) => {
    setSelected(poll); setView('send'); setSendResult(null);
    const supabase = createClient();
    const { data: sessions } = await supabase.from('bot_sessions').select('whatsapp_number').eq('business_id', business.id);
    const phones = [...new Set((sessions || []).map(s => s.whatsapp_number).filter(Boolean))];
    setContacts(phones.map(p => ({ phone: p, first_name: null })));
    setSelectedPhones(phones);
  };

  const handleCreate = async () => {
    setError(null);
    if (!question.trim()) { setError('Enter a question'); return; }
    const cleanOpts = options.filter(o => o.trim());
    if (cleanOpts.length < 2) { setError('Need at least 2 options'); return; }
    setSaving(true);
    const res = await fetch('/api/polls', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_id: business.id, question: question.trim(), options: cleanOpts, allow_change_vote: allowChange, show_results: showResults, closes_at: closesAt || undefined }),
    });
    if (!res.ok) { const d = await res.json(); setError(d.error || 'Failed'); }
    else { setQuestion(''); setOptions(['', '']); setView('list'); fetchPolls(); }
    setSaving(false);
  };

  const toggleStatus = async (poll: Poll) => {
    const newStatus = poll.status === 'active' ? 'closed' : 'active';
    await fetch(`/api/polls/${poll.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: newStatus }) });
    fetchPolls();
  };

  const deletePoll = async (id: string) => {
    if (!confirm('Delete this poll and all votes?')) return;
    await fetch(`/api/polls/${id}`, { method: 'DELETE' });
    fetchPolls();
  };

  const sendPoll = async () => {
    if (!selected || selectedPhones.length === 0) return;
    setSending(true);
    const res = await fetch(`/api/polls/${selected.id}/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phones: selectedPhones }),
    });
    if (res.ok) { setSendResult(await res.json()); fetchPolls(); }
    setSending(false);
  };

  if (isGated) {
    return (
      <div className="space-y-6">
        <PageHeader title="Polls" tooltip={PAGE_TOOLTIPS.polls} />
        <div className="rounded-lg border border-gray-200 bg-white p-12 text-center dark:border-gray-700 dark:bg-gray-800">
          <div className="text-4xl mb-4">🗳️</div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">Polls available on Growth plan</h2>
          <p className="text-gray-500 dark:text-gray-400 mb-4">Create quick polls and let customers vote via WhatsApp.</p>
          <a href="/dashboard/settings" className="inline-flex items-center px-4 py-2 bg-black text-white rounded-lg hover:bg-gray-800 text-sm font-medium">Upgrade Plan</a>
        </div>
      </div>
    );
  }

  // Results view
  if (view === 'results' && selected) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <button onClick={() => { setView('list'); setSelected(null); }} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
            <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <PageHeader title={selected.question} description={`${totalVotes} vote${totalVotes !== 1 ? 's' : ''}`} />
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800 space-y-4">
          {results.map((r, i) => (
            <div key={i}>
              <div className="flex justify-between text-sm mb-1">
                <span className="font-medium text-gray-900 dark:text-gray-100">{r.option}</span>
                <span className="text-gray-500">{r.votes} ({r.percentage}%)</span>
              </div>
              <div className="h-4 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                <div className="h-full bg-brand rounded-full transition-all" style={{ width: `${r.percentage}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Send view
  if (view === 'send' && selected) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <button onClick={() => { setView('list'); setSelected(null); }} className="text-gray-500 hover:text-gray-700"><svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg></button>
          <PageHeader title={`Send: ${selected.question}`} />
        </div>
        {sendResult ? (
          <div className="rounded-lg border border-green-200 bg-green-50 p-6 text-center">
            <p className="text-lg font-medium text-green-800">Poll sent to {sendResult.sent} contact{sendResult.sent !== 1 ? 's' : ''}</p>
            <button onClick={() => { setView('list'); setSelected(null); }} className="mt-4 px-4 py-2 bg-black text-white rounded-lg text-sm">Back to Polls</button>
          </div>
        ) : (
          <>
            <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
              <div className="flex justify-between mb-3">
                <p className="text-sm font-medium text-gray-700">Select contacts ({selectedPhones.length}/{contacts.length})</p>
                <button onClick={() => setSelectedPhones(selectedPhones.length === contacts.length ? [] : contacts.map(c => c.phone))} className="text-xs text-blue-600">{selectedPhones.length === contacts.length ? 'Deselect all' : 'Select all'}</button>
              </div>
              <div className="max-h-60 overflow-y-auto space-y-1">
                {contacts.map(c => (
                  <label key={c.phone} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer">
                    <input type="checkbox" checked={selectedPhones.includes(c.phone)} onChange={e => setSelectedPhones(e.target.checked ? [...selectedPhones, c.phone] : selectedPhones.filter(p => p !== c.phone))} className="rounded" />
                    <span className="text-sm text-gray-900">{c.phone}</span>
                  </label>
                ))}
              </div>
            </div>
            <button onClick={sendPoll} disabled={sending || selectedPhones.length === 0} className="w-full py-3 bg-black text-white rounded-lg font-medium disabled:opacity-50">
              {sending ? 'Sending...' : `Send to ${selectedPhones.length} contact${selectedPhones.length !== 1 ? 's' : ''}`}
            </button>
          </>
        )}
      </div>
    );
  }

  // Create view
  if (view === 'create') {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <button onClick={() => setView('list')} className="text-gray-500 hover:text-gray-700"><svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg></button>
          <PageHeader title="Create Poll" />
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Question</label>
            <input value={question} onChange={e => setQuestion(e.target.value)} placeholder="What should our Friday special be?" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Options</label>
            {options.map((opt, i) => (
              <div key={i} className="flex gap-2 mb-2">
                <input value={opt} onChange={e => { const c = [...options]; c[i] = e.target.value; setOptions(c); }} placeholder={`Option ${i + 1}`} className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
                {options.length > 2 && <button onClick={() => setOptions(options.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-600 text-xs">Remove</button>}
              </div>
            ))}
            {options.length < 10 && <button onClick={() => setOptions([...options, ''])} className="text-xs text-blue-600">+ Add option</button>}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Show results</label>
              <select value={showResults} onChange={e => setShowResults(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-700">
                <option value="after_vote">After voting</option>
                <option value="always">Always visible</option>
                <option value="after_close">After poll closes</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Closes at (optional)</label>
              <input type="datetime-local" value={closesAt} onChange={e => setClosesAt(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-700" />
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={allowChange} onChange={e => setAllowChange(e.target.checked)} className="rounded" />
            <span className="text-sm text-gray-700 dark:text-gray-300">Allow voters to change their vote</span>
          </label>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-3">
          <button onClick={() => setView('list')} className="px-4 py-2 border border-gray-300 rounded-lg text-sm">Cancel</button>
          <button onClick={handleCreate} disabled={saving} className="px-6 py-2 bg-black text-white rounded-lg text-sm font-medium disabled:opacity-50">{saving ? 'Creating...' : 'Create Poll'}</button>
        </div>
      </div>
    );
  }

  // List view
  const activePolls = polls.filter(p => p.status === 'active').length;
  const totalVotesAll = polls.reduce((s, p) => s + (p.total_votes || 0), 0);

  return (
    <div className="space-y-6">
      <PageHeader title="Polls" tooltip={PAGE_TOOLTIPS.polls}>
        <button onClick={() => setView('create')} className="inline-flex items-center gap-1.5 px-4 py-2 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-800">
          <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
          New Poll
        </button>
      </PageHeader>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <p className="text-sm text-gray-500">Total Polls</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{polls.length}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <p className="text-sm text-gray-500">Active</p>
          <p className="text-2xl font-bold text-green-600">{activePolls}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <p className="text-sm text-gray-500">Total Votes</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{totalVotesAll}</p>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading...</div>
      ) : polls.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-12 text-center dark:border-gray-700 dark:bg-gray-800">
          <div className="text-4xl mb-4">🗳️</div>
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-1">No polls yet</h3>
          <p className="text-sm text-gray-500 mb-4">Create your first poll to engage customers.</p>
          <button onClick={() => setView('create')} className="px-4 py-2 bg-black text-white rounded-lg text-sm font-medium">Create Poll</button>
        </div>
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-700/50 border-b">
                <th scope="col" className="text-left px-4 py-3 font-medium text-gray-500">Poll</th>
                <th scope="col" className="text-left px-4 py-3 font-medium text-gray-500">Status</th>
                <th scope="col" className="text-left px-4 py-3 font-medium text-gray-500">Options</th>
                <th scope="col" className="text-left px-4 py-3 font-medium text-gray-500">Votes</th>
                <th scope="col" className="text-right px-4 py-3 font-medium text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {polls.map(p => (
                <tr key={p.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                  <td className="px-4 py-3">
                    <button onClick={() => loadResults(p)} className="font-medium text-gray-900 dark:text-gray-100 hover:text-blue-600 text-left">{p.question}</button>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${p.status === 'active' ? 'bg-green-100 text-green-700' : p.status === 'closed' ? 'bg-gray-100 text-gray-600' : 'bg-yellow-100 text-yellow-700'}`}>{p.status}</span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{p.options?.length || 0}</td>
                  <td className="px-4 py-3 text-gray-600">{p.total_votes || 0}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {p.status === 'active' && <button onClick={() => loadContacts(p)} className="text-xs text-blue-600 font-medium">Send</button>}
                      <button onClick={() => toggleStatus(p)} className="text-xs text-gray-500">{p.status === 'active' ? 'Close' : 'Activate'}</button>
                      <button onClick={() => loadResults(p)} className="text-xs text-gray-500">Results</button>
                      <button onClick={() => deletePoll(p.id)} className="text-xs text-red-500">Delete</button>
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

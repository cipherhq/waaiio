'use client';
import { useEffect, useState } from 'react';
import { parseQuestions, type PartyQuestion, type PartyAnswers } from '@/lib/parties/rsvp-questions';
type Snapshot = { questions: PartyQuestion[]; revision: number; responses: { id: string; guest_name: string; status: string; answers: PartyAnswers; revision: number | null; questions: PartyQuestion[] }[] };
export default function PartyQuestionsEditor({ partyId }: { partyId: string }) {
  const [saved, setSaved] = useState<Snapshot | null>(null);
  const [questions, setQuestions] = useState<PartyQuestion[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    try {
      const res = await fetch(`/api/parties/${partyId}/questions`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Questions unavailable.');
      parseQuestions(data.questions);
      if (!Array.isArray(data.responses)) throw new Error('Questions unavailable.');
      setSaved(data); setQuestions(data.questions); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Questions unavailable.'); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, [partyId]);
  async function save() {
    if (!saved) return;
    setBusy(true); setError('');
    try {
      const res = await fetch(`/api/parties/${partyId}/questions`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questions: parseQuestions(questions), revision: saved.revision }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Unable to save questions.');
      parseQuestions(data.questions);
      if (!Array.isArray(data.responses)) throw new Error('Questions unavailable.');
      setSaved(data); setQuestions(data.questions);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save questions.'); }
    finally { setBusy(false); }
  }
  const change = (index: number, question: PartyQuestion) => setQuestions(old => old.map((q, i) => i === index ? question : q));
  const field = 'rounded border p-2 text-sm dark:bg-gray-800';
  return <section className="rounded-xl border border-gray-200 p-4 dark:border-gray-700">
    <h3 className="font-semibold">RSVP questions</h3>
    <p className="text-sm text-gray-500">Required questions apply when guests accept. Maybe and Decline remain available. Saved answers keep the questions originally answered.</p>
    {error && <p role="alert" className="my-2 text-sm text-red-600">{error} <button type="button" onClick={load}>Reload saved questions</button></p>}
    {saved && <fieldset disabled={busy} className="space-y-3 mt-3">
      {questions.map((q, index) => <div key={q.id} className="space-y-2 rounded border p-3">
        <input className={`${field} w-full`} aria-label={`Question ${index + 1}`} maxLength={120} value={q.label} onChange={e => change(index, { ...q, label: e.target.value })} />
        <select className={field} aria-label={`Question ${index + 1} type`} value={q.type} onChange={e => {
          const type = e.target.value as PartyQuestion['type'];
          // A type change is a new question identity; old answers retain their snapshot.
          change(index, { id: crypto.randomUUID(), label: q.label, required: q.required, type, ...(type === 'single_choice' ? { options: [{ id: crypto.randomUUID(), label: 'Option 1' }, { id: crypto.randomUUID(), label: 'Option 2' }] } : {}) });
        }}><option value="short_text">Short text</option><option value="single_choice">Single choice</option><option value="yes_no">Yes or no</option></select>
        <label className="ml-3 text-sm"><input type="checkbox" checked={q.required} onChange={e => change(index, { ...q, required: e.target.checked })} /> Required</label>
        {q.options?.map((o, oi) => <div key={o.id} className="flex gap-2"><input className={field} aria-label={`Question ${index + 1} option ${oi + 1}`} maxLength={80} value={o.label} onChange={e => change(index, { ...q, options: q.options!.map(x => x.id === o.id ? { ...x, label: e.target.value } : x) })} /><button type="button" disabled={q.options!.length <= 2} onClick={() => change(index, { ...q, options: q.options!.filter(x => x.id !== o.id) })}>Remove option</button></div>)}
        {q.options && q.options.length < 10 && <button type="button" onClick={() => change(index, { ...q, options: [...q.options!, { id: crypto.randomUUID(), label: '' }] })}>Add option</button>}
        <div className="flex gap-3 text-sm"><button type="button" disabled={!index} onClick={() => setQuestions(old => { const next = [...old]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })}>Move up</button><button type="button" onClick={() => setQuestions(old => old.filter(x => x.id !== q.id))}>Remove question</button></div>
      </div>)}
      <div className="flex gap-4"><button type="button" disabled={questions.length >= 10} onClick={() => setQuestions(old => [...old, { id: crypto.randomUUID(), label: '', type: 'short_text', required: false }])}>Add question</button><button type="button" onClick={save}>Save questions</button></div>
    </fieldset>}
    {saved && <details className="mt-4"><summary>Saved answers</summary>{saved.responses.filter(r => r.revision !== null).map(r => <div key={r.id} className="mt-3 text-sm"><strong>{r.guest_name || 'Guest'} — {r.status}</strong>{r.revision !== saved.revision && <p>Answers to an earlier version</p>}<dl>{r.questions.map(q => <div key={q.id}><dt>{q.label}</dt><dd>{typeof r.answers[q.id] === 'boolean' ? (r.answers[q.id] ? 'Yes' : 'No') : q.options?.find(o => o.id === r.answers[q.id])?.label || r.answers[q.id] || 'Not answered'}</dd></div>)}</dl></div>)}</details>}
  </section>;
}

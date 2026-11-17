'use client';

// Flow answers (#1085): what customers answered in Custom Flow questions.
// The owner and the business's own team can read and download; only the
// owner can delete. Answers are deleted automatically after 12 months.
import { useCallback, useEffect, useState } from 'react';
import { PageHelp } from '@/components/dashboard/PageHelp';
import EmptyState from '@/components/dashboard/EmptyState';
import { formatFullDate } from '@/lib/bot/custom-flow/dates';
import { displayNumber, fileKind, type FlowResponse } from '@/lib/custom-flow-responses/answers';

interface Props { businessId: string; timezone: string; country: string | null }
interface Flow { id: string; name: string }

const API = '/api/custom-flows/responses';
const FRIENDLY_ERRORS: Record<string, string> = {
  owner_only: 'Only the business owner can delete answers.',
  file_unavailable: 'That file could not be opened right now. Please try again.',
  not_found: 'That answer is no longer there. It may have been deleted already.',
};
const friendly = (code: unknown) => FRIENDLY_ERRORS[String(code)] ?? 'Something went wrong. Please try again.';

export function FlowAnswers({ businessId, timezone, country }: Props) {
  const [flows, setFlows] = useState<Flow[] | null>(null);
  const [flowId, setFlowId] = useState('');
  const [responses, setResponses] = useState<FlowResponse[] | null>(null);
  const [canDelete, setCanDelete] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async (selected: string) => {
    setError('');
    try {
      const res = await fetch(`${API}?businessId=${businessId}${selected ? `&flowId=${selected}` : ''}`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) { setError(friendly(body.error)); return; }
      setFlows(body.flows); setCanDelete(body.canDelete);
      if (!selected && body.flows.length) { setFlowId(body.flows[0].id); return; }
      setResponses(selected ? body.responses : null); setTruncated(!!body.truncated);
    } catch { setError(friendly(null)); }
  }, [businessId]);

  useEffect(() => { void load(flowId); }, [load, flowId]);

  const answeredAt = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: timezone, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  async function openFile(answerId: string) {
    setError('');
    try {
      const res = await fetch(`${API}?businessId=${businessId}&file=${answerId}`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) { setError(friendly(body.error)); return; }
      window.open(body.url, '_blank', 'noopener,noreferrer');
    } catch { setError(friendly(null)); }
  }

  async function remove(action: 'delete_response' | 'delete_flow_answers', responseId?: string) {
    const question = action === 'delete_response'
      ? 'Delete these answers? This cannot be undone.'
      : 'Delete every answer for this flow? This cannot be undone.';
    if (!window.confirm(question)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      // A very large flow can take more than one call; keep going while answers remain.
      let total = 0;
      for (let call = 0; call < 20; call++) {
        const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ businessId, flowId, action, responseId }) });
        const body = await res.json();
        if (!res.ok) { setError(friendly(body.error)); break; }
        total += body.deleted;
        if (!body.remaining) { setNotice(total === 1 ? '1 answer deleted.' : `${total} answers deleted.`); break; }
        if (call === 19) setError('Some answers are still there. Please select Delete again.');
      }
      await load(flowId);
    } catch { setError(friendly(null)); }
    finally { setBusy(false); }
  }

  const selected = flows?.find(f => f.id === flowId);

  return <div className="space-y-6" aria-busy={busy || flows === null}>
    <header>
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Flow answers</h1>
      <p className="mt-2 max-w-2xl text-sm text-gray-600 dark:text-gray-400">See what people answered when your flows asked them a question.</p>
    </header>
    <PageHelp pageKey="custom-flow-answers" title="Who can see these answers?"
      description="Only you and your team can see them. Answers are deleted automatically 12 months after they were sent. You can download them or delete them sooner." />

    {notice && <p role="status" className="text-sm text-gray-800 dark:text-gray-200">{notice}</p>}
    {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}

    {flows !== null && flows.length === 0 && <EmptyState icon="💬" title="No flows yet"
      description="Build a flow that asks a question. When people answer on WhatsApp, their answers show up here."
      actionLabel="Build a flow" actionHref="/dashboard/custom-flows" />}

    {!!flows?.length && <section aria-label="Choose a flow" className="flex flex-wrap items-end gap-3 rounded-2xl bg-brand p-4 text-white shadow-md dark:bg-brand-800">
      <label className="min-w-0 flex-1 text-sm font-medium">Flow
        <select value={flowId} onChange={event => { setNotice(''); setFlowId(event.target.value); }} disabled={busy}
          className="mt-1 block w-full rounded-lg border-0 bg-white px-3 py-2 text-gray-900 dark:bg-gray-900 dark:text-gray-100">
          {flows.map(flow => <option key={flow.id} value={flow.id}>{flow.name}</option>)}
        </select>
      </label>
      {!!responses?.length && <a href={`${API}?businessId=${businessId}&flowId=${flowId}&format=csv`} download
        className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-gray-900 hover:bg-accent-400">Download CSV</a>}
      {canDelete && !!responses?.length && <button type="button" disabled={busy} onClick={() => remove('delete_flow_answers')}
        className="rounded-lg border border-white/60 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10 disabled:opacity-60">Delete all answers for this flow</button>}
    </section>}

    {selected && responses?.length === 0 && <EmptyState icon="📝" title="No answers yet"
      description={`When people answer questions in “${selected.name}” on WhatsApp, their answers show up here.`} />}

    {truncated && <p className="text-sm text-gray-600 dark:text-gray-400">Showing the newest answers. Download the CSV to get all of them.</p>}

    {!!responses?.length && <ul className="space-y-4" aria-label={`Answers for ${selected?.name ?? 'this flow'}`}>
      {responses.map(response => <li key={response.response_id} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="font-semibold text-gray-900 dark:text-gray-100">{displayNumber(response.customer_number)}</h2>
            <p className="text-xs text-gray-600 dark:text-gray-400">Answered {answeredAt(response.answered_at)}</p>
          </div>
          {canDelete && <button type="button" disabled={busy} onClick={() => remove('delete_response', response.response_id)}
            aria-label={`Delete answers from ${displayNumber(response.customer_number)}`}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-60 dark:text-red-300 dark:hover:bg-red-900/20">Delete</button>}
        </div>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          {response.answers.map(answer => <div key={answer.id} className="min-w-0 rounded-xl bg-gray-50 p-3 dark:bg-gray-900/50">
            <dt className="text-xs font-medium text-gray-600 dark:text-gray-400">{answer.question}</dt>
            <dd className="mt-1 break-words text-sm text-gray-900 dark:text-gray-100">
              {answer.answer_type === 'date' && answer.value_date ? formatFullDate(answer.value_date, { language: 'en', country: country ?? 'GB' })
                : answer.answer_type === 'file' ? <button type="button" onClick={() => openFile(answer.id)}
                  className="font-semibold text-brand underline-offset-2 hover:underline dark:text-brand-300">View {fileKind(answer.file_mime) === 'PDF' ? 'PDF' : 'photo'}</button>
                : answer.value_text}
            </dd>
          </div>)}
        </dl>
      </li>)}
    </ul>}
  </div>;
}

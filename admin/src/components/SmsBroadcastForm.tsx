/**
 * Admin SMS broadcast (#1131): Waaiio's own text message to its users and
 * account owners in Nigeria and Ghana, via BulkSMS. Waaiio pays for these
 * messages; no merchant messaging credit is used.
 *
 * Flow: write the message and choose recipients → Preview (pages, counts,
 * skips, Waaiio's cost) → Send (step-up bound to exactly what was previewed).
 * The request id stays with the preview, so a retried send returns the first
 * result instead of sending again.
 */

import { useRef, useState } from 'react';
import { adminApiFetch } from '@/lib/adminApi';
import { useStepUp } from '@/hooks/useStepUp';
import { StepUpDialog } from '@/components/StepUpDialog';

type Audience = 'all_users' | 'all_businesses' | 'specific';

interface Preview {
  configured: boolean;
  sms: { pages: number; unicode: boolean; characters: number; perPage: number };
  counts: { matched: number; withoutNumber: number; notSmsCountry: number; eligible: number; optedOut: number; suspended: number; unverified: number };
  quietHoursNow: boolean;
  estimate: { byCurrency: Array<{ currency: string; amountMinor: number; recipients: number }>; unpriced: number } | null;
  descriptor: Record<string, unknown>;
}

interface SendResult {
  replayed: boolean; status: string; sent: number; failed: number; unknown: number; notProcessed?: number;
  skipped: { optedOut: number; suspended: number; unverified: number };
}

const PLAN_LABELS: Record<string, string> = { free: 'Starter', growth: 'Pro', business: 'Premium' };
const ENDPOINT = '/api/admin/broadcasts/sms';

function formatMinor(currency: string, minor: number) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

export function SmsBroadcastForm({ canMutate, onSent }: { canMutate: boolean; onSent: () => void }) {
  const [text, setText] = useState('');
  const [audience, setAudience] = useState<Audience>('all_businesses');
  const [country, setCountry] = useState('');
  const [plan, setPlan] = useState('');
  const [numbers, setNumbers] = useState('');

  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const requestIdRef = useRef('');

  const stepUp = useStepUp();
  const stepUpCallbackRef = useRef<((stepUpId: string) => Promise<void>) | null>(null);
  const stepUpFlightRef = useRef(false);

  // Any change to the compose form discards the preview it was based on.
  function edited<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v);
      if (!outcomeUnknown) { setPreview(null); requestIdRef.current = ''; }
    };
  }

  function requestBody() {
    return {
      message: text, audience,
      country: audience === 'specific' ? null : country || null,
      plan: audience === 'all_businesses' ? plan || null : null,
      phones: audience === 'specific' ? numbers.split(/[,\n]/).map(s => s.trim()).filter(Boolean) : [],
    };
  }

  async function handlePreview() {
    if (!text.trim() || previewing) return;
    setPreviewing(true);
    setMessage('');
    setPreview(null);
    try {
      const res = await adminApiFetch(ENDPOINT, { mode: 'preview', ...requestBody() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMessage(data.error || 'Preview failed.'); return; }
      setPreview(data);
      requestIdRef.current = crypto.randomUUID();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Preview failed.');
    } finally {
      setPreviewing(false);
    }
  }

  function report(data: SendResult) {
    const skipped = data.skipped.optedOut + data.skipped.suspended + data.skipped.unverified;
    const parts = [`${data.sent} accepted by the SMS provider`];
    if (data.failed) parts.push(`${data.failed} not sent`);
    if (data.unknown) parts.push(`${data.unknown} with an unknown outcome (do not resend to them)`);
    if (skipped) parts.push(`${skipped} skipped (opted out, suspended or unverifiable)`);
    if (data.notProcessed) parts.push(`${data.notProcessed} not reached yet`);
    if (data.status === 'sending') {
      setMessage(`This broadcast is still sending, or was cut off: ${parts.join(', ')} so far. Check again in a minute. Do not send it again.`);
      return;
    }
    setMessage(`${data.replayed ? 'This broadcast was already sent: ' : ''}${parts.join(', ')}. Accepted is not confirmation of delivery. Waaiio pays; no merchant credit was used.`);
    setOutcomeUnknown(false);
    setPreview(null);
    requestIdRef.current = '';
    onSent();
  }

  async function postSend(stepUpId: string) {
    const res = await adminApiFetch(ENDPOINT, { mode: 'send', requestId: requestIdRef.current, ...preview!.descriptor, stepUpId });
    const data = await res.json().catch(() => ({}));
    if (res.ok) { report(data as SendResult); return; }
    if (res.status < 500) {
      setOutcomeUnknown(false);
      setMessage(data.error || 'The broadcast was not sent.');
      return;
    }
    setMessage('The send result is unknown. Use "Check result" — it never sends twice.');
  }

  async function handleSend() {
    if (!preview || !canMutate || sending || !requestIdRef.current) return;
    setSending(true);
    setMessage('');
    const onAuthorized = async (stepUpId: string) => {
      stepUpCallbackRef.current = null;
      setOutcomeUnknown(true);
      try {
        await postSend(stepUpId);
      } catch {
        setMessage('The send result did not come back. Use "Check result" — it never sends twice.');
      }
    };
    stepUpCallbackRef.current = onAuthorized;
    try {
      await stepUp.execute({
        actionType: 'admin_broadcast',
        targetId: requestIdRef.current,
        params: preview.descriptor,
        description: `Send an SMS (${preview.sms.pages} page${preview.sms.pages === 1 ? '' : 's'}) to ${preview.counts.eligible} recipient(s). Waaiio pays; no merchant credit is used.`,
        onAuthorized,
      });
    } catch (err) {
      stepUpCallbackRef.current = null;
      setMessage(err instanceof Error ? err.message : 'Step-up failed');
      stepUp.reset();
    } finally {
      setSending(false);
    }
  }

  async function handleCheckResult() {
    setSending(true);
    try {
      const res = await adminApiFetch(ENDPOINT, { mode: 'status', requestId: requestIdRef.current });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setMessage(data.error || 'Still no result. Try again in a moment.');
      else if (data.recorded === false) {
        setMessage('No broadcast has been recorded for this request yet. Check again shortly. Start over only if you are sure it did not go out.');
      } else report(data as SendResult);
    } catch {
      setMessage('Still no result. Try again in a moment.');
    } finally {
      setSending(false);
    }
  }

  function handleStartOver() {
    if (!confirm('Start over? If the earlier send did go out, sending again will text the same people twice.')) return;
    setOutcomeUnknown(false);
    setPreview(null);
    requestIdRef.current = '';
    setMessage('');
  }

  const stepUpInFlight = ['preparing', 'awaiting-code', 'verifying', 'executing'].includes(stepUp.state.phase);
  const c = preview?.counts;
  const blocked = !!preview && (!preview.configured || preview.quietHoursNow);

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">
        Sends a text message to numbers in Nigeria and Ghana. Waaiio pays for these messages; no merchant credit is used.
        Opted-out and suspended numbers are skipped. Not sent between 8pm and 8am.
      </p>

      <div>
        <label htmlFor="sms-text" className="block text-sm font-medium text-gray-700">Message</label>
        <textarea id="sms-text" value={text} rows={4} disabled={outcomeUnknown}
          onChange={e => edited(setText)(e.target.value)}
          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none" />
      </div>

      <div className="flex flex-wrap gap-4">
        <div>
          <label htmlFor="sms-audience" className="block text-sm font-medium text-gray-700">Recipients</label>
          <select id="sms-audience" value={audience} onChange={e => edited(setAudience)(e.target.value as Audience)} disabled={outcomeUnknown}
            className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none">
            <option value="all_businesses">Account owners</option>
            <option value="all_users">All users</option>
            <option value="specific">Specific numbers</option>
          </select>
        </div>
        {audience !== 'specific' && (
          <div>
            <label htmlFor="sms-country" className="block text-sm font-medium text-gray-700">Country (optional)</label>
            <select id="sms-country" value={country} onChange={e => edited(setCountry)(e.target.value)} disabled={outcomeUnknown}
              className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none">
              <option value="">Nigeria and Ghana</option>
              <option value="NG">Nigeria</option>
              <option value="GH">Ghana</option>
            </select>
          </div>
        )}
        {audience === 'all_businesses' && (
          <div>
            <label htmlFor="sms-plan" className="block text-sm font-medium text-gray-700">Plan (optional)</label>
            <select id="sms-plan" value={plan} onChange={e => edited(setPlan)(e.target.value)} disabled={outcomeUnknown}
              className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none">
              <option value="">Any plan</option>
              {Object.entries(PLAN_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        )}
      </div>

      {audience === 'specific' && (
        <div>
          <label htmlFor="sms-numbers" className="block text-sm font-medium text-gray-700">Phone numbers (comma-separated, with country code)</label>
          <input id="sms-numbers" type="text" value={numbers} placeholder="+2348012345678, +233201234567" disabled={outcomeUnknown}
            onChange={e => edited(setNumbers)(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none" />
        </div>
      )}

      <button type="button" onClick={handlePreview}
        disabled={!text.trim() || previewing || outcomeUnknown || (audience === 'specific' && !numbers.trim())}
        className="rounded-xl border border-brand px-4 py-2.5 text-sm font-bold text-brand transition hover:bg-brand-50 disabled:opacity-50">
        {previewing ? 'Checking...' : 'Preview recipients and cost'}
      </button>

      {preview && c && (
        <div role="region" className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700" aria-label="SMS broadcast preview">
          <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Preview</p>
          <p>
            <strong>{preview.sms.pages} SMS page{preview.sms.pages === 1 ? '' : 's'}</strong> per person ({preview.sms.characters} characters, {preview.sms.perPage} per page)
            {preview.sms.unicode ? '. Accented letters or emoji make each page shorter (70 characters).' : '.'}
          </p>
          <ul className="mt-3 space-y-1">
            <li><strong>{c.eligible}</strong> will be sent</li>
            {c.optedOut > 0 && <li>{c.optedOut} skipped: opted out of Waaiio messages</li>}
            {c.suspended > 0 && <li>{c.suspended} skipped: suspended</li>}
            {c.unverified > 0 && <li>{c.unverified} skipped: status could not be checked</li>}
            {c.notSmsCountry > 0 && <li>{c.notSmsCountry} not reachable: SMS goes to Nigeria and Ghana only</li>}
            {c.withoutNumber > 0 && <li>{c.withoutNumber} have no valid phone number</li>}
          </ul>
          <p className="mt-3">
            Waaiio's cost (BulkSMS, VAT included):{' '}
            {preview.estimate
              ? (preview.estimate.byCurrency.length
                ? preview.estimate.byCurrency.map(e => formatMinor(e.currency, e.amountMinor)).join(' + ')
                : 'nothing priced')
                + (preview.estimate.unpriced ? ` (${preview.estimate.unpriced} recipient(s) have no SMS cost set)` : '')
              : 'unavailable'}
            . No merchant credit is used.
          </p>
          {!preview.configured && <p role="alert" className="mt-2 text-red-600">SMS is not switched on (no registered sender name is set). It cannot be sent yet.</p>}
          {preview.quietHoursNow && <p role="alert" className="mt-2 text-amber-700">It is between 8pm and 8am for some recipients. Send after 8am.</p>}
        </div>
      )}

      {message && <p role="status" className="text-sm text-gray-700">{message}</p>}

      {outcomeUnknown ? (
        <div className="flex gap-2">
          <button type="button" onClick={handleCheckResult} disabled={sending}
            className="rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50">
            {sending ? 'Checking...' : 'Check result'}
          </button>
          <button type="button" onClick={handleStartOver} disabled={sending}
            className="rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 disabled:opacity-50">
            Start over
          </button>
        </div>
      ) : (
        <button type="button" onClick={handleSend}
          disabled={!canMutate || !preview || !c?.eligible || blocked || sending || stepUpInFlight}
          className="rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50">
          {sending ? 'Sending...' : 'Send SMS Broadcast'}
        </button>
      )}

      <StepUpDialog
        open={!!stepUpCallbackRef.current && (stepUp.state.phase === 'awaiting-code' || stepUp.state.phase === 'verifying')}
        description={stepUp.state.description} method={stepUp.state.method}
        error={stepUp.state.error}
        loading={stepUp.state.phase === 'verifying'}
        onSubmit={async (code) => {
          if (stepUpFlightRef.current || !stepUpCallbackRef.current) return;
          stepUpFlightRef.current = true;
          try { await stepUp.submitCode(code, stepUpCallbackRef.current); }
          finally {
            stepUpFlightRef.current = false;
            if (!stepUpCallbackRef.current) stepUp.reset();
          }
        }}
        onCancel={() => { stepUp.reset(); stepUpCallbackRef.current = null; }}
      />
    </div>
  );
}

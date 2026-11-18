/**
 * Admin WhatsApp broadcast (#1104): Waaiio's own approved-template message to
 * its users and account owners, from the shared Waaiio number. Waaiio pays for
 * these messages; no merchant messaging credit is used.
 *
 * Flow: choose template and recipients → Preview (counts, skips, estimate) →
 * Send (step-up bound to exactly what was previewed). The request id stays
 * with the preview, so a retried send returns the first result instead of
 * sending again.
 */

import { useEffect, useRef, useState } from 'react';
import { adminApiFetch, adminApiGet } from '@/lib/adminApi';
import { useStepUp } from '@/hooks/useStepUp';
import { StepUpDialog } from '@/components/StepUpDialog';

type Audience = 'all_users' | 'all_businesses' | 'specific';

interface Template { name: string; language: string; category: 'marketing' | 'utility'; bodyText: string; paramCount: number }

interface Preview {
  template: Template & { rendered: string };
  counts: { matched: number; withoutNumber: number; eligible: number; noSender: number; optedOut: number; suspended: number; unverified: number };
  estimate: { byCurrency: Array<{ currency: string; amountMinor: number; recipients: number }>; unpriced: number } | null;
  descriptor: Record<string, unknown>;
}

interface SendResult {
  replayed: boolean; status: string; sent: number; failed: number; unknown: number;
  skipped: { optedOut: number; suspended: number; unverified: number };
}

const PLAN_LABELS: Record<string, string> = { free: 'Starter', growth: 'Pro', business: 'Premium' };

function formatMinor(currency: string, minor: number) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

export function WhatsAppBroadcastForm({ canMutate, onSent }: { canMutate: boolean; onSent: () => void }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templatesError, setTemplatesError] = useState('');
  const [templateKey, setTemplateKey] = useState('');
  const [params, setParams] = useState<string[]>([]);
  const [audience, setAudience] = useState<Audience>('all_businesses');
  const [country, setCountry] = useState('');
  const [plan, setPlan] = useState('');
  const [numbers, setNumbers] = useState('');

  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  // Set when a send went out but its result never came back: the same request
  // id can only return the first result, never send again.
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const requestIdRef = useRef('');

  const stepUp = useStepUp();
  const stepUpCallbackRef = useRef<((stepUpId: string) => Promise<void>) | null>(null);
  const stepUpFlightRef = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await adminApiGet('/api/admin/broadcasts/whatsapp');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Unable to load templates');
        setTemplates(data.templates || []);
      } catch (err) {
        setTemplatesError(err instanceof Error ? err.message : 'Unable to load templates');
      }
    })();
  }, []);

  const template = templates.find(t => `${t.name}|${t.language}` === templateKey) || null;

  // Any change to the compose form discards the preview it was based on.
  function edited<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v);
      if (!outcomeUnknown) { setPreview(null); requestIdRef.current = ''; }
    };
  }

  function chooseTemplate(key: string) {
    const t = templates.find(x => `${x.name}|${x.language}` === key);
    edited(setTemplateKey)(key);
    setParams(Array.from({ length: t?.paramCount ?? 0 }, () => ''));
  }

  function requestBody() {
    return {
      templateName: template?.name, language: template?.language, audience,
      country: audience === 'specific' ? null : country || null,
      plan: audience === 'all_businesses' ? plan || null : null,
      phones: audience === 'specific' ? numbers.split(/[,\n]/).map(s => s.trim()).filter(Boolean) : [],
      params,
    };
  }

  async function handlePreview() {
    if (!template || previewing) return;
    setPreviewing(true);
    setMessage('');
    setPreview(null);
    try {
      const res = await adminApiFetch('/api/admin/broadcasts/whatsapp', { mode: 'preview', ...requestBody() });
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
    const parts = [`${data.sent} accepted by WhatsApp`];
    if (data.failed) parts.push(`${data.failed} not sent`);
    if (data.unknown) parts.push(`${data.unknown} with an unknown outcome (do not resend to them)`);
    if (skipped) parts.push(`${skipped} skipped (opted out, suspended or unverifiable)`);
    setMessage(`${data.replayed ? 'This broadcast was already sent: ' : ''}${parts.join(', ')}. Accepted is not confirmation of delivery. No merchant credit was used.`);
  }

  async function postSend(stepUpId: string | null) {
    const res = await adminApiFetch('/api/admin/broadcasts/whatsapp', {
      mode: 'send', requestId: requestIdRef.current, ...preview!.descriptor, ...(stepUpId ? { stepUpId } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMessage(data.error || 'The broadcast was not sent.');
      return data.code as string | undefined;
    }
    report(data as SendResult);
    setOutcomeUnknown(false);
    setPreview(null);
    requestIdRef.current = '';
    onSent();
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
        description: `Send WhatsApp template ${preview.template.name} to ${preview.counts.eligible} recipient(s). Waaiio pays; no merchant credit is used.`,
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
      // Without a step-up this can only return a recorded result; it never sends.
      if (await postSend(null) === 'step_up_required') {
        setMessage('No broadcast has been recorded for this request yet. Check again shortly. Start over only if you are sure it did not go out.');
      }
    } catch {
      setMessage('Still no result. Try again in a moment.');
    } finally {
      setSending(false);
    }
  }

  function handleStartOver() {
    if (!confirm('Start over? If the earlier send did go out, sending again will message the same people twice.')) return;
    setOutcomeUnknown(false);
    setPreview(null);
    requestIdRef.current = '';
    setMessage('');
  }

  const stepUpInFlight = ['preparing', 'awaiting-code', 'verifying', 'executing'].includes(stepUp.state.phase);
  const c = preview?.counts;

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">
        Sends an approved WhatsApp template from the shared Waaiio number. Waaiio pays for these messages; no merchant credit is used.
        Opted-out and suspended numbers are skipped.
      </p>

      <div>
        <label htmlFor="wa-template" className="block text-sm font-medium text-gray-700">Template</label>
        <select id="wa-template" value={templateKey} onChange={e => chooseTemplate(e.target.value)} disabled={outcomeUnknown}
          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none">
          <option value="">Choose an approved template</option>
          {templates.map(t => (
            <option key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>
              {t.name} ({t.language}, {t.category})
            </option>
          ))}
        </select>
        {templatesError && <p role="alert" className="mt-1 text-sm text-red-600">{templatesError}</p>}
        {template && <p className="mt-2 rounded-lg bg-gray-50 p-3 text-sm text-gray-700 whitespace-pre-wrap">{template.bodyText}</p>}
      </div>

      {params.map((value, i) => (
        <div key={i}>
          <label htmlFor={`wa-param-${i}`} className="block text-sm font-medium text-gray-700">{`Value for {{${i + 1}}}`}</label>
          <input id={`wa-param-${i}`} type="text" value={value} disabled={outcomeUnknown}
            onChange={e => edited(setParams)(params.map((p, j) => (j === i ? e.target.value : p)))}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none" />
        </div>
      ))}

      <div className="flex flex-wrap gap-4">
        <div>
          <label htmlFor="wa-audience" className="block text-sm font-medium text-gray-700">Recipients</label>
          <select id="wa-audience" value={audience} onChange={e => edited(setAudience)(e.target.value as Audience)} disabled={outcomeUnknown}
            className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none">
            <option value="all_businesses">Account owners</option>
            <option value="all_users">All users</option>
            <option value="specific">Specific numbers</option>
          </select>
        </div>
        {audience !== 'specific' && (
          <div>
            <label htmlFor="wa-country" className="block text-sm font-medium text-gray-700">Country (optional)</label>
            <input id="wa-country" type="text" value={country} maxLength={2} placeholder="e.g. NG" disabled={outcomeUnknown}
              onChange={e => edited(setCountry)(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
              className="mt-1 w-24 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-brand focus:outline-none" />
          </div>
        )}
        {audience === 'all_businesses' && (
          <div>
            <label htmlFor="wa-plan" className="block text-sm font-medium text-gray-700">Plan (optional)</label>
            <select id="wa-plan" value={plan} onChange={e => edited(setPlan)(e.target.value)} disabled={outcomeUnknown}
              className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none">
              <option value="">Any plan</option>
              {Object.entries(PLAN_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        )}
      </div>

      {audience === 'specific' && (
        <div>
          <label htmlFor="wa-numbers" className="block text-sm font-medium text-gray-700">WhatsApp numbers (comma-separated, with country code)</label>
          <input id="wa-numbers" type="text" value={numbers} placeholder="+2348012345678, +447700900123" disabled={outcomeUnknown}
            onChange={e => edited(setNumbers)(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none" />
        </div>
      )}

      <button type="button" onClick={handlePreview}
        disabled={!template || previewing || outcomeUnknown || params.some(p => !p.trim()) || (audience === 'specific' && !numbers.trim())}
        className="rounded-xl border border-brand px-4 py-2.5 text-sm font-bold text-brand transition hover:bg-brand-50 disabled:opacity-50">
        {previewing ? 'Checking...' : 'Preview recipients and cost'}
      </button>

      {preview && c && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700" aria-label="WhatsApp broadcast preview">
          <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Preview</p>
          <p className="whitespace-pre-wrap">{preview.template.rendered}</p>
          <ul className="mt-3 space-y-1">
            <li><strong>{c.eligible}</strong> will be sent ({preview.template.category})</li>
            {c.optedOut > 0 && <li>{c.optedOut} skipped: opted out of Waaiio messages</li>}
            {c.suspended > 0 && <li>{c.suspended} skipped: suspended</li>}
            {c.unverified > 0 && <li>{c.unverified} skipped: status could not be checked</li>}
            {c.noSender > 0 && <li>{c.noSender} not reachable: no Waaiio number for their country</li>}
            {c.withoutNumber > 0 && <li>{c.withoutNumber} have no valid WhatsApp number</li>}
          </ul>
          <p className="mt-3">
            Estimated cost to Waaiio:{' '}
            {preview.estimate
              ? (preview.estimate.byCurrency.length
                ? preview.estimate.byCurrency.map(e => formatMinor(e.currency, e.amountMinor)).join(' + ')
                : 'nothing priced')
                + (preview.estimate.unpriced ? ` (${preview.estimate.unpriced} recipient(s) have no rate)` : '')
              : 'unavailable'}
            . No merchant credit is used.
          </p>
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
          disabled={!canMutate || !preview || !c?.eligible || sending || stepUpInFlight}
          className="rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50">
          {sending ? 'Sending...' : 'Send WhatsApp Broadcast'}
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

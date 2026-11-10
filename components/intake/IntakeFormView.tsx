'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { isMissing, MAX_ANSWER_LENGTH, type IntakeField } from '@/lib/intake/answers';

interface IntakeData {
  status: 'pending' | 'submitted' | 'expired' | 'unavailable';
  business_name: string;
  business_logo: string | null;
  service_name: string | null;
  booking_date: string | null;
  booking_time: string | null;
  title?: string;
  description?: string | null;
  fields?: IntakeField[];
}

type View = 'loading' | 'ready' | 'submitting' | 'done' | 'message';

const INPUT = 'w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500';

function Message({ title, text }: { title: string; text: string }) {
  return (
    // ph-no-capture: analytics must never record anything on an intake page.
    <div className="ph-no-capture flex min-h-screen items-center justify-center bg-gray-50 p-6" data-testid="intake-page">
      <div className="max-w-sm text-center">
        <h1 className="text-xl font-bold text-gray-900">{title}</h1>
        <p className="mt-2 text-sm text-gray-500">{text}</p>
        <p className="mt-4 text-xs text-gray-400">Powered by Waaiio</p>
      </div>
    </div>
  );
}

/** Client intake page (#963 lane 2). Answers go only to the business that owns the booking. */
export function IntakeFormView({ token }: { token: string }) {
  const [data, setData] = useState<IntakeData | null>(null);
  const [view, setView] = useState<View>('loading');
  const [message, setMessage] = useState({ title: '', text: '' });
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/intake/${encodeURIComponent(token)}`, { cache: 'no-store' });
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setMessage({ title: 'Link not available', text: body.error || 'This link is not valid.' });
          setView('message');
          return;
        }
        setData(body);
        if (body.status === 'submitted') setView('done');
        else if (body.status === 'expired') {
          setMessage({ title: 'This link has expired', text: 'Please contact the business for a new link.' });
          setView('message');
        } else if (body.status === 'unavailable') {
          setMessage({ title: 'Form not available', text: 'This form is not accepting answers. Please contact the business.' });
          setView('message');
        } else setView('ready');
      } catch {
        if (cancelled) return;
        setMessage({ title: 'Something went wrong', text: 'Please check your connection and try again.' });
        setView('message');
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  function update(id: string, value: unknown) {
    setAnswers(prev => ({ ...prev, [id]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!data?.fields) return;
    const missing = data.fields.find(f => f.required && isMissing(f, answers[f.id]));
    if (missing) { setError(`"${missing.label}" is required`); return; }
    setError('');
    setView('submitting');
    try {
      const res = await fetch(`/api/intake/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers }),
      });
      const body = await res.json();
      if (res.ok) { setView('done'); return; }
      if (res.status === 410 || res.status === 404) {
        setMessage({ title: 'Link not available', text: body.error || 'Please contact the business.' });
        setView('message');
        return;
      }
      setError(body.error || 'Something went wrong. Please try again.');
      setView('ready');
    } catch {
      setError('Something went wrong. Please try again.');
      setView('ready');
    }
  }

  if (view === 'loading') {
    return (
      <div className="ph-no-capture flex min-h-screen items-center justify-center bg-gray-50">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-gray-200 border-t-violet-600" />
      </div>
    );
  }
  if (view === 'message') return <Message title={message.title} text={message.text} />;
  if (view === 'done') {
    return (
      <Message
        title="Thank you"
        text={`Your answers have been sent${data?.business_name ? ` to ${data.business_name}` : ''}. You can go back to WhatsApp now.`}
      />
    );
  }
  if (!data?.fields) return null;

  const when = data.booking_date
    ? new Date(`${data.booking_date}T${(data.booking_time || '00:00').slice(0, 5)}`).toLocaleString(undefined, {
        weekday: 'short', day: 'numeric', month: 'short', ...(data.booking_time ? { hour: 'numeric', minute: '2-digit' } : {}),
      })
    : null;

  return (
    // ph-no-capture: analytics must never record the client's answers or taps.
    <div className="ph-no-capture min-h-screen bg-gray-50" data-testid="intake-page">
      <div className="mx-auto max-w-lg px-4 py-8">
        <div className="mb-6">
          {data.business_logo && (
            <Image src={data.business_logo} alt={data.business_name} width={120} height={40} className="mb-3 h-10 w-auto rounded" />
          )}
          <p className="text-xs font-medium text-gray-400">{data.business_name}</p>
          <h1 className="text-2xl font-bold text-gray-900">{data.title}</h1>
          {(data.service_name || when) && (
            <p className="mt-1 text-sm text-gray-600">{[data.service_name, when].filter(Boolean).join(' · ')}</p>
          )}
          {data.description && <p className="mt-1 text-sm text-gray-500">{data.description}</p>}
          <p className="mt-2 text-xs text-gray-400">Only {data.business_name || 'the business'} can see your answers.</p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-5">
            {data.fields.map(field => {
              const value = answers[field.id];
              const options = field.options || [];
              return (
                <div key={field.id}>
                  {field.type === 'radio' || field.type === 'multi_select' ? (
                    <p className="mb-1 block text-sm font-medium text-gray-700">
                      {field.label} {field.required && <span className="text-red-400">*</span>}
                    </p>
                  ) : (
                    <label className="mb-1 block text-sm font-medium text-gray-700" htmlFor={`f-${field.id}`}>
                      {field.label} {field.required && <span className="text-red-400">*</span>}
                    </label>
                  )}
                  {(field.type === 'text' || field.type === 'email' || field.type === 'phone' || field.type === 'date' || field.type === 'number') && (
                    <input id={`f-${field.id}`}
                      type={field.type === 'phone' ? 'tel' : field.type} maxLength={MAX_ANSWER_LENGTH}
                      value={(value as string) || ''} onChange={e => update(field.id, e.target.value)} className={INPUT} />
                  )}
                  {field.type === 'textarea' && (
                    <textarea id={`f-${field.id}`} rows={3} maxLength={MAX_ANSWER_LENGTH} value={(value as string) || ''}
                      onChange={e => update(field.id, e.target.value)} className={INPUT} />
                  )}
                  {field.type === 'select' && (
                    <select id={`f-${field.id}`} value={(value as string) || ''} onChange={e => update(field.id, e.target.value)} className={INPUT}>
                      <option value="">Select...</option>
                      {options.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  )}
                  {field.type === 'radio' && (
                    <div className="space-y-2">
                      {options.map(o => (
                        <label key={o} className="flex cursor-pointer items-center gap-2">
                          <input type="radio" name={field.id} checked={value === o} onChange={() => update(field.id, o)} />
                          <span className="text-sm text-gray-700">{o}</span>
                        </label>
                      ))}
                    </div>
                  )}
                  {field.type === 'multi_select' && (
                    <div className="space-y-2">
                      {options.map(o => {
                        const list = (value as string[]) || [];
                        const on = list.includes(o);
                        return (
                          <label key={o} className="flex cursor-pointer items-center gap-2">
                            <input type="checkbox" checked={on}
                              onChange={() => update(field.id, on ? list.filter(v => v !== o) : [...list, o])} />
                            <span className="text-sm text-gray-700">{o}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                  {field.type === 'checkbox' && (
                    <label className="flex items-center gap-2">
                      <input id={`f-${field.id}`} type="checkbox" checked={value === true} onChange={e => update(field.id, e.target.checked)} />
                      <span className="text-sm text-gray-600">Yes</span>
                    </label>
                  )}
                </div>
              );
            })}
          </div>

          {error && <p className="text-sm text-red-600" role="alert">{error}</p>}

          <button type="submit" disabled={view === 'submitting'}
            className="w-full rounded-xl bg-violet-600 px-6 py-3.5 text-sm font-bold text-white shadow-md transition hover:bg-violet-700 disabled:opacity-50">
            {view === 'submitting' ? 'Sending...' : 'Send my answers'}
          </button>
          <p className="text-center text-xs text-gray-400">Powered by Waaiio</p>
        </form>
      </div>
    </div>
  );
}

'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export function NativeFormOptions({ businessId, settings, hasEmail, onChange }: {
  businessId: string; settings: Record<string, unknown>; hasEmail: boolean; onChange: (value: Record<string, unknown>) => void;
}) {
  const [events, setEvents] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    let current = true;
    setEvents([]); setError(false);
    void (async () => {
      try {
        const { data, error } = await createClient().from('events').select('id,name').eq('business_id', businessId)
          .eq('status', 'published').gte('date', new Date().toISOString().slice(0, 10)).order('date').limit(100);
        if (current) { setEvents(data || []); setError(!!error); }
      } catch { if (current) setError(true); }
    })();
    return () => { current = false; };
  }, [businessId]);
  const change = (key: string, value: unknown) => onChange({ ...settings, [key]: value });
  return <fieldset className="mt-4 max-w-2xl space-y-3 rounded-lg border border-gray-200 p-4">
    <legend className="px-1 text-sm font-semibold">Inside WhatsApp</legend>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={settings.native_whatsapp_opt_in === true} onChange={e => change('native_whatsapp_opt_in', e.target.checked)} />
      <span>Offer WhatsApp updates<span className="block text-xs text-gray-500">Optional. Customers confirm with Yes in chat before receiving updates.</span></span></label>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={hasEmail && settings.email_marketing_opt_in === true} disabled={!hasEmail} onChange={e => change('email_marketing_opt_in', e.target.checked)} />
      <span>Offer email news and offers<span className="block text-xs text-gray-500">Optional and separate from WhatsApp. The entered email is not verified.{!hasEmail && ' Add an Email field first.'}</span></span></label>
    <label className="block text-sm">Continue to an event after submission
      <select value={String(settings.registration_event_id || '')} onChange={e => change('registration_event_id', e.target.value || null)} className="mt-1 block w-full rounded border border-gray-300 p-2">
        <option value="">Collect information only</option>
        {!!settings.registration_event_id && !events.some(e => e.id === settings.registration_event_id) && <option value={String(settings.registration_event_id)}>Previously selected event — check availability</option>}
        {events.map(event => <option key={event.id} value={event.id}>{event.name}</option>)}
      </select>
    </label>
    {error && <p role="alert" className="text-sm text-red-600">Could not load events. Reopen the form to retry.</p>}
    <p className="text-xs text-gray-500">One response covers the purchaser’s registration. Customers choose tickets in chat and use secure checkout when payment is needed. Registration and payment are confirmed separately.</p>
  </fieldset>;
}

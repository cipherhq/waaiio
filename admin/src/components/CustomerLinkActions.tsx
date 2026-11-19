/**
 * "Email link" and "Copy link" for a ticket, booking, order or stay (Owner decision
 * 2026-11-18). Emails the customer the link to their existing ticket or
 * confirmation page, or copies it to share. No WhatsApp message is sent.
 * Server: /api/admin/customer-links/resend (audit-logged on send).
 */
import { useEffect, useState } from 'react';
import { adminApiFetch, adminJson } from '@/lib/adminApi';

type Kind = 'ticket' | 'booking' | 'order' | 'stay';

interface LinkStatus {
  link: string;
  canEmail: boolean;
  reason: string | null;
  emailHint: string | null;
}

const PATH = '/api/admin/customer-links/resend';

export function CustomerLinkActions({ kind, id }: { kind: Kind; id: string }) {
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    setStatus(null);
    setLoadError(null);
    setNotice(null);
    adminApiFetch(PATH, { kind, id, check: true })
      .then(res => adminJson<LinkStatus>(res))
      .then(data => { if (alive) setStatus(data); })
      .catch(err => { if (alive) setLoadError(err instanceof Error ? err.message : 'request failed'); });
    return () => { alive = false; };
  }, [kind, id]);

  async function emailLink() {
    setSending(true);
    setNotice(null);
    try {
      const data = await adminJson<{ sentTo: string }>(await adminApiFetch(PATH, { kind, id }));
      setNotice({ text: `Link emailed to ${data.sentTo}.` });
    } catch (err) {
      setNotice({ text: `Email not sent: ${err instanceof Error ? err.message : 'request failed'}`, error: true });
    }
    setSending(false);
  }

  async function copyLink() {
    if (!status) return;
    try {
      await navigator.clipboard.writeText(status.link);
      setNotice({ text: 'Link copied. Paste it into WhatsApp or anywhere else.' });
    } catch {
      setNotice({ text: 'Could not copy the link. Please try again.', error: true });
    }
  }

  if (loadError) {
    return <p className="text-sm text-red-600">Could not load the customer link: {loadError}</p>;
  }

  const reasonId = `customer-link-reason-${id}`;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={emailLink}
          disabled={!status || !status.canEmail || sending}
          aria-describedby={status?.reason ? reasonId : undefined}
          title={status?.reason || undefined}
          className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sending ? 'Sending...' : 'Email link'}
        </button>
        <button
          type="button"
          onClick={copyLink}
          disabled={!status}
          className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          Copy link
        </button>
      </div>
      {status?.reason && <p id={reasonId} className="text-xs text-gray-500">Email is off: {status.reason}</p>}
      {status?.canEmail && status.emailHint && !notice && (
        <p className="text-xs text-gray-500">Sends to {status.emailHint}</p>
      )}
      {notice && (
        <p role={notice.error ? 'alert' : 'status'} className={`text-sm ${notice.error ? 'text-red-600' : 'text-green-700'}`}>
          {notice.text}
        </p>
      )}
    </div>
  );
}

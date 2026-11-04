'use client';

import { useEffect, useState } from 'react';

/**
 * Display-only direct WhatsApp link (not copyable), with why the Waaiio link
 * is the one to share. Rendered only when the server confirms the link works.
 */
export function DirectWhatsAppLink({ businessId }: { businessId: string }) {
  const [link, setLink] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLink(null);
    fetch(`/api/whatsapp/direct-link?business_id=${encodeURIComponent(businessId)}`)
      .then(res => (res.ok ? res.json() : null))
      .then(data => { if (!cancelled) setLink(typeof data?.link === 'string' ? data.link : null); })
      .catch(() => { if (!cancelled) setLink(null); });
    return () => { cancelled = true; };
  }, [businessId]);

  if (!link) return null;
  return (
    <div className="mt-3 rounded-lg bg-white/60 dark:bg-gray-700/40 px-3 py-2" data-testid="direct-whatsapp-link">
      <p className="text-[11px] font-medium text-gray-500 dark:text-gray-400">Direct WhatsApp link</p>
      <p className="select-none break-all text-xs text-gray-600 dark:text-gray-300">{link}</p>
      <p className="mt-1 text-[11px] leading-snug text-gray-500 dark:text-gray-400">
        This also opens a chat with your shop. Please share your Waaiio link instead: it keeps working if your WhatsApp number ever changes, and if your shop is paused customers see a clear message instead of a chat that goes nowhere.
      </p>
    </div>
  );
}

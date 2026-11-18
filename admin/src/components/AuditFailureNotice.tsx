import { useEffect, useState } from 'react';
import { AUDIT_FAILED_EVENT } from '@/lib/auditLog';

/** Shows a dismissible alert when an admin action's audit entry was not recorded. */
export function AuditFailureNotice() {
  const [action, setAction] = useState<string | null>(null);

  useEffect(() => {
    const onFailed = (event: Event) => {
      const detail = (event as CustomEvent<{ action?: string }>).detail;
      setAction(detail?.action || 'admin action');
    };
    window.addEventListener(AUDIT_FAILED_EVENT, onFailed);
    return () => window.removeEventListener(AUDIT_FAILED_EVENT, onFailed);
  }, []);

  if (!action) return null;
  return (
    <div role="alert" className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
      <span>
        The action <strong>{action.replace(/_/g, ' ')}</strong> was done, but its audit log entry was not recorded.
        Note what you changed and report it.
      </span>
      <button type="button" onClick={() => setAction(null)} className="shrink-0 font-medium underline">Dismiss</button>
    </div>
  );
}

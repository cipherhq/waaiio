'use client';

import { useEffect, useState } from 'react';

interface Alert {
  id: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  is_read: boolean;
  created_at: string;
}

export function AlertBanner() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    fetch('/api/dashboard/alerts?page=1')
      .then(r => r.json())
      .then(data => {
        const unread = (data.alerts || []).filter((a: Alert) => !a.is_read);
        // Deduplicate by message — keep only the latest per unique message
        const seen = new Map<string, Alert>();
        for (const a of unread) {
          const key = a.message.replace(/\d+/g, '').trim(); // Normalize numbers for dedup
          if (!seen.has(key) || new Date(a.created_at) > new Date(seen.get(key)!.created_at)) {
            seen.set(key, a);
          }
        }
        setAlerts(Array.from(seen.values()).slice(0, 5));
      })
      .catch(() => {});
  }, []);

  if (alerts.length === 0) return null;

  const criticalCount = alerts.filter(a => a.severity === 'critical').length;
  const bgColor = criticalCount > 0 ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200';
  const iconColor = criticalCount > 0 ? 'text-red-500' : 'text-amber-500';
  const textColor = criticalCount > 0 ? 'text-red-900' : 'text-amber-900';

  async function markAsRead(ids: string[]) {
    await fetch('/api/dashboard/alerts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertIds: ids }),
    });
    setAlerts(prev => prev.filter(a => !ids.includes(a.id)));
  }

  return (
    <div className={`border-b ${bgColor} px-4 py-2.5`}>
      <div className="mx-auto max-w-6xl">
        <div className="flex items-center justify-between">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-2"
          >
            <svg aria-hidden="true" className={`h-5 w-5 ${iconColor}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
            </svg>
            <span className={`text-sm font-semibold ${textColor}`}>
              {alerts.length} unread alert{alerts.length !== 1 ? 's' : ''}
            </span>
            <svg aria-hidden="true" className={`h-4 w-4 ${textColor} transition ${expanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <button
            onClick={() => markAsRead(alerts.map(a => a.id))}
            className="text-xs font-medium text-gray-500 hover:text-gray-700 transition"
          >
            Dismiss all
          </button>
        </div>

        {expanded && (
          <div className="mt-3 space-y-2">
            {alerts.map(alert => (
              <div key={alert.id} className="flex items-start justify-between rounded-lg bg-white p-3 shadow-sm">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                      alert.severity === 'critical' ? 'bg-red-100 text-red-700' :
                      alert.severity === 'warning' ? 'bg-yellow-100 text-yellow-700' :
                      'bg-blue-100 text-blue-700'
                    }`}>
                      {alert.severity}
                    </span>
                    <span className="text-sm font-semibold text-gray-900">{alert.title}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-gray-600">{alert.message}</p>
                  <p className="mt-0.5 text-[10px] text-gray-400">
                    {new Date(alert.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
                <button
                  onClick={() => markAsRead([alert.id])}
                  className="ml-2 shrink-0 text-gray-400 hover:text-gray-600"
                >
                  <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

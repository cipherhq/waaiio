'use client';

import { useEffect, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';

interface TemplateComponent {
  type: string;
  format?: string;
  text?: string;
  buttons?: Array<{ type: string; text: string; url?: string; phone_number?: string }>;
}

interface MessageTemplate {
  id: string;
  name: string;
  status: 'APPROVED' | 'PENDING' | 'REJECTED' | 'PAUSED' | 'DISABLED';
  category: string;
  language: string;
  components: TemplateComponent[];
}

const STATUS_STYLES: Record<string, string> = {
  APPROVED: 'bg-green-100 text-green-700',
  PENDING: 'bg-yellow-100 text-yellow-700',
  REJECTED: 'bg-red-100 text-red-700',
  PAUSED: 'bg-gray-100 text-gray-600',
  DISABLED: 'bg-gray-100 text-gray-600',
};

export default function TemplatesPage() {
  const business = useBusiness();
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<MessageTemplate | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/whatsapp/templates?business_id=${business.id}`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.message || 'Failed to load templates');
        }
        const data = await res.json();
        setTemplates(data.data || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [business.id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-emerald-200 border-t-emerald-600" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Message Templates</h1>
          <p className="mt-1 text-sm text-gray-500">
            WhatsApp message templates approved for your business account.
            Templates are auto-provisioned when you enable features like WhatsApp Sign.
          </p>
        </div>
        <button
          onClick={() => window.location.reload()}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {templates.length === 0 && !error ? (
        <div className="mt-8 rounded-xl border border-gray-200 bg-gray-50 px-6 py-12 text-center">
          <p className="text-gray-500">No message templates found.</p>
          <p className="mt-1 text-sm text-gray-400">
            Templates will be automatically created when you enable features that require them.
          </p>
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {templates.map((t) => (
            <div
              key={t.id}
              className="rounded-xl border border-gray-200 bg-white p-4 hover:border-gray-300 cursor-pointer transition"
              onClick={() => setSelected(selected?.id === t.id ? null : t)}
            >
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-mono text-sm font-medium text-gray-900">{t.name}</span>
                  <div className="mt-1 flex items-center gap-2">
                    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${
                      t.category === 'UTILITY' ? 'bg-blue-100 text-blue-700' :
                      t.category === 'MARKETING' ? 'bg-purple-100 text-purple-700' :
                      'bg-orange-100 text-orange-700'
                    }`}>
                      {t.category}
                    </span>
                    <span className="text-xs text-gray-400">{t.language}</span>
                  </div>
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_STYLES[t.status] || 'bg-gray-100 text-gray-600'}`}>
                  {t.status}
                </span>
              </div>

              {selected?.id === t.id && (
                <div className="mt-4 border-t pt-4 space-y-3">
                  {t.components.map((c, i) => (
                    <div key={i} className="rounded-lg bg-gray-50 p-3">
                      <span className="text-xs font-semibold uppercase text-gray-400">{c.type}</span>
                      {c.text && <p className="mt-1 text-sm whitespace-pre-wrap text-gray-700">{c.text}</p>}
                      {c.buttons?.map((b, j) => (
                        <div key={j} className="mt-1 text-xs text-gray-500">
                          [{b.type}] {b.text} {b.url || b.phone_number || ''}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

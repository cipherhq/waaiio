'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

interface ApiKey {
  id: string;
  key_prefix: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export function IntegrationsTab({ businessId, subscriptionTier }: { businessId: string; subscriptionTier: string }) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [keyName, setKeyName] = useState('');
  const [copied, setCopied] = useState(false);
  const [showDocs, setShowDocs] = useState(false);

  const isPaid = subscriptionTier && subscriptionTier !== 'free';

  useEffect(() => {
    fetchKeys();
  }, [businessId]);

  async function fetchKeys() {
    const res = await fetch(`/api/integrations/api-keys?businessId=${businessId}`);
    const data = await res.json();
    setKeys(data.keys || []);
    setLoading(false);
  }

  async function handleGenerate() {
    setGenerating(true);
    const res = await fetch('/api/integrations/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessId, name: keyName || 'Default' }),
    });
    const data = await res.json();
    if (data.key) {
      setNewKey(data.key);
      setKeyName('');
      fetchKeys();
    }
    setGenerating(false);
  }

  async function handleRevoke(id: string) {
    if (!confirm('Revoke this API key? Any systems using it will stop working.')) return;
    await fetch(`/api/integrations/api-keys/${id}`, { method: 'DELETE' });
    fetchKeys();
  }

  function copyKey() {
    if (newKey) {
      navigator.clipboard.writeText(newKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  const activeKeys = keys.filter(k => !k.revoked_at);
  const revokedKeys = keys.filter(k => k.revoked_at);

  if (!isPaid) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-brand/10">
          <svg className="h-6 w-6 text-brand" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        </div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">API Integrations</h3>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          Connect your existing booking system to Waaiio. Available on Growth plan and above.
        </p>
        <a href="/dashboard/settings?tab=account" className="mt-4 inline-block rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand/90">
          Upgrade Plan
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">API Integration</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Connect your existing booking or appointment system to Waaiio. When a booking is created in your system,
          send it to Waaiio and we&apos;ll handle WhatsApp confirmations, reminders, feedback, and customer profiles.
        </p>

        <button
          onClick={() => setShowDocs(!showDocs)}
          className="mt-3 text-sm font-medium text-brand hover:text-brand/80"
        >
          {showDocs ? 'Hide' : 'View'} API Documentation
        </button>

        {showDocs && (
          <div className="mt-4 rounded-lg bg-gray-50 dark:bg-gray-900 p-4 text-sm">
            <h4 className="font-semibold text-gray-900 dark:text-gray-100">Endpoint</h4>
            <code className="mt-1 block rounded bg-gray-200 dark:bg-gray-700 px-3 py-2 text-xs text-gray-800 dark:text-gray-200">
              POST https://www.waaiio.com/api/integrations/external-booking
            </code>

            <h4 className="mt-4 font-semibold text-gray-900 dark:text-gray-100">Headers</h4>
            <code className="mt-1 block rounded bg-gray-200 dark:bg-gray-700 px-3 py-2 text-xs text-gray-800 dark:text-gray-200">
              x-api-key: your_api_key_here<br />
              Content-Type: application/json
            </code>

            <h4 className="mt-4 font-semibold text-gray-900 dark:text-gray-100">Request Body</h4>
            <pre className="mt-1 overflow-x-auto rounded bg-gray-200 dark:bg-gray-700 px-3 py-2 text-xs text-gray-800 dark:text-gray-200">
{`{
  "customer_name": "Jane Doe",
  "customer_phone": "+2348012345678",
  "date": "2026-06-15",
  "time": "10:00",
  "service_name": "Haircut",
  "party_size": 1,
  "notes": "First time customer",
  "reference": "EXT-12345"
}`}
            </pre>

            <h4 className="mt-4 font-semibold text-gray-900 dark:text-gray-100">Required Fields</h4>
            <ul className="mt-1 list-disc pl-5 text-gray-600 dark:text-gray-400">
              <li><strong>customer_name</strong> — customer&apos;s full name</li>
              <li><strong>customer_phone</strong> — E.164 format (e.g. +2348012345678)</li>
              <li><strong>date</strong> — YYYY-MM-DD format</li>
              <li><strong>time</strong> — HH:MM format (24hr)</li>
              <li><strong>service_name</strong> — name of the service booked</li>
            </ul>

            <h4 className="mt-4 font-semibold text-gray-900 dark:text-gray-100">Optional Fields</h4>
            <ul className="mt-1 list-disc pl-5 text-gray-600 dark:text-gray-400">
              <li><strong>party_size</strong> — number of guests (default: 1)</li>
              <li><strong>notes</strong> — additional notes (max 1000 chars)</li>
              <li><strong>reference</strong> — your system&apos;s booking reference (max 200 chars)</li>
            </ul>

            <h4 className="mt-4 font-semibold text-gray-900 dark:text-gray-100">Response</h4>
            <pre className="mt-1 overflow-x-auto rounded bg-gray-200 dark:bg-gray-700 px-3 py-2 text-xs text-gray-800 dark:text-gray-200">
{`{
  "success": true,
  "booking_id": "uuid",
  "reference_code": "ABCD-L2K3MN",
  "status": "confirmed",
  "whatsapp_sent": true
}`}
            </pre>

            <h4 className="mt-4 font-semibold text-gray-900 dark:text-gray-100">Example (cURL)</h4>
            <pre className="mt-1 overflow-x-auto rounded bg-gray-200 dark:bg-gray-700 px-3 py-2 text-xs text-gray-800 dark:text-gray-200">
{`curl -X POST https://www.waaiio.com/api/integrations/external-booking \\
  -H "x-api-key: wai_your_key_here" \\
  -H "Content-Type: application/json" \\
  -d '{"customer_name":"Jane","customer_phone":"+2348012345678","date":"2026-06-15","time":"10:00","service_name":"Haircut"}'`}
            </pre>
          </div>
        )}
      </div>

      {/* New key dialog */}
      {newKey && (
        <div className="rounded-xl border-2 border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-900/20 p-6">
          <h4 className="font-semibold text-green-800 dark:text-green-200">API Key Generated</h4>
          <p className="mt-1 text-sm text-green-700 dark:text-green-300">
            Copy this key now. It will not be shown again.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 rounded-lg bg-white dark:bg-gray-800 border border-green-200 dark:border-green-700 px-4 py-3 text-sm font-mono text-gray-900 dark:text-gray-100 select-all break-all">
              {newKey}
            </code>
            <button
              onClick={copyKey}
              className="shrink-0 rounded-lg bg-green-600 px-4 py-3 text-sm font-medium text-white hover:bg-green-700"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <button
            onClick={() => setNewKey(null)}
            className="mt-3 text-sm text-green-600 dark:text-green-400 hover:underline"
          >
            I&apos;ve saved it — close this
          </button>
        </div>
      )}

      {/* Generate new key */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
        <h4 className="font-medium text-gray-900 dark:text-gray-100">Generate API Key</h4>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Create a key to authenticate API requests. You can have up to 5 active keys.
        </p>
        <div className="mt-3 flex items-end gap-3">
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">Key Name (optional)</label>
            <input
              type="text"
              value={keyName}
              onChange={e => setKeyName(e.target.value)}
              placeholder="e.g. Calendly, My Website"
              maxLength={100}
              className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
            />
          </div>
          <button
            onClick={handleGenerate}
            disabled={generating || activeKeys.length >= 5}
            className="shrink-0 rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-white hover:bg-brand/90 disabled:opacity-50"
          >
            {generating ? 'Generating...' : 'Generate Key'}
          </button>
        </div>
      </div>

      {/* Active keys */}
      {loading ? (
        <div className="flex justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
        </div>
      ) : activeKeys.length > 0 ? (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700">
            <h4 className="font-medium text-gray-900 dark:text-gray-100">Active Keys ({activeKeys.length})</h4>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-700">
            {activeKeys.map(k => (
              <div key={k.id} className="flex items-center justify-between px-6 py-4">
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{k.name}</p>
                  <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 font-mono">
                    {k.key_prefix}{'•'.repeat(20)}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">
                    Created {new Date(k.created_at).toLocaleDateString()}
                    {k.last_used_at && ` · Last used ${new Date(k.last_used_at).toLocaleDateString()}`}
                  </p>
                </div>
                <button
                  onClick={() => handleRevoke(k.id)}
                  className="rounded-lg border border-red-200 dark:border-red-800 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-8 text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400">No active API keys. Generate one above to get started.</p>
        </div>
      )}

      {/* Revoked keys */}
      {revokedKeys.length > 0 && (
        <details className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden">
          <summary className="px-6 py-4 cursor-pointer text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300">
            Revoked Keys ({revokedKeys.length})
          </summary>
          <div className="divide-y divide-gray-100 dark:divide-gray-700">
            {revokedKeys.map(k => (
              <div key={k.id} className="flex items-center justify-between px-6 py-3 opacity-50">
                <div>
                  <p className="text-sm text-gray-600 dark:text-gray-400">{k.name}</p>
                  <p className="text-xs text-gray-400 font-mono">{k.key_prefix}{'•'.repeat(20)}</p>
                </div>
                <span className="text-xs text-red-500">Revoked</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

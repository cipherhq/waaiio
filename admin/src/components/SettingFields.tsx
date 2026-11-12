import { useEffect, useState } from 'react';
import { adminDb } from '@/lib/supabase';

export const friendlyLabel = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');

/** Display nested configuration without requiring JSON literacy. Values remain in their stored units. */
export function SettingSummary({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span>Not configured</span>;
  if (typeof value !== 'object') return <span>{typeof value === 'boolean' ? (value ? 'Enabled' : 'Disabled') : value === 999999999 ? 'Unlimited' : String(value)}</span>;
  return <dl className="space-y-2">{Object.entries(value).map(([key, child]) => <div key={key} className="border-l pl-3"><dt className="text-xs font-medium capitalize">{friendlyLabel(key)}</dt><dd><SettingSummary value={child} /></dd></div>)}</dl>;
}

export function DirectoryBusinessEditor({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  const [businesses, setBusinesses] = useState<Array<{ id: string; name: string; country_code: string }>>([]);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    let active = true;
    void (async () => {
      const result = await adminDb.from('businesses').select('id, name, country_code').order('name');
      if (!active) return;
      if (result.error) setError('Business names could not be loaded. Existing selections are retained.');
      else setBusinesses(result.data || []);
    })().catch(() => { if (active) setError('Business names could not be loaded. Existing selections are retained.'); });
    return () => { active = false; };
  }, []);
  return <div className="space-y-2">
    {error && <p role="alert">{error}</p>}
    <ul>{value.map((id, index) => { const business = businesses.find(b => b.id === id); return <li key={`${id}-${index}`} className="flex gap-2 items-center"><span>{business ? `${business.name} (${business.country_code})` : `Business ${id}`}</span><button type="button" aria-label={`Remove ${business?.name || id}`} onClick={() => onChange(value.filter((_, i) => i !== index))}>Remove</button></li>; })}</ul>
    <input aria-label="Search businesses" placeholder="Search businesses by name" value={search} onChange={e => setSearch(e.target.value)} className="border rounded px-3 py-2" />
    <select aria-label="Add business" value="" onChange={e => { if (e.target.value && !value.includes(e.target.value)) onChange([...value, e.target.value]); }} className="border rounded px-3 py-2">
      <option value="">Choose a business…</option>
      {businesses.filter(b => !value.includes(b.id) && b.name.toLowerCase().includes(search.toLowerCase())).map(b => <option key={b.id} value={b.id}>{b.name} ({b.country_code})</option>)}
    </select>
  </div>;
}

export function KeywordPayloadEditor({ action, value, onChange }: { action: string; value: string; onChange: (value: string) => void }) {
  let parsed: Record<string, unknown> | null = null;
  try { const candidate = JSON.parse(value || '{}'); if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) parsed = candidate; } catch { /* Keep malformed/legacy payload editable only in advanced mode. */ }
  const field = ['reply', 'acknowledge'].includes(action) ? 'message' : action === 'start_capability' ? 'capability' : null;
  const label = field === 'message' ? 'Reply message' : 'Capability key';
  const canEdit = field && parsed && (parsed[field] === undefined || typeof parsed[field] === 'string');
  return <div className="space-y-2">
    {canEdit && <label className="block">{label}<textarea aria-label={label} className="block w-full border rounded p-2" value={String(parsed![field!] || '')} onChange={e => onChange(JSON.stringify({ ...parsed, [field!]: e.target.value }, null, 2))} /></label>}
    {!canEdit && <p>This action uses an advanced payload. Existing content is preserved.</p>}
    <details open={!canEdit}><summary>Advanced JSON</summary><textarea aria-label="Advanced keyword payload" className="w-full border rounded p-2 font-mono" rows={4} value={value} onChange={e => onChange(e.target.value)} /></details>
  </div>;
}

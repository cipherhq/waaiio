import { useCallback, useEffect, useState } from 'react';
import { adminApiFetch, adminApiGet } from '@/lib/adminApi';
import { useAdminSession } from '@/components/AdminLayout';
import { useStepUp } from '@/hooks/useStepUp';
import { StepUpDialog } from '@/components/StepUpDialog';

type Action = 'create' | 'approve' | 'refresh' | 'execute';
type Evidence = { type: string; document_id?: string; request_id?: string; snapshot?: { status?: string; reviewed_at?: string; completed_at?: string } };
interface Operation {
  business_id: string; target_action: string; target_channel_id: string | null; target_candidate_id: string | null;
  reason: string; request_version: number;
  target_snapshot?: { phone_number?: string; phone_number_normalized?: string; country_code?: string; status?: string };
  verification_record?: { owner_reverified?: boolean; verification_method?: string; evidence_refs?: Evidence[] };
}
interface ChangeRequest extends Operation {
  id: string; request_type: string; status: string; requester_admin_id: string; approver_admin_id: string | null;
  requester_step_up_verified_at: string; approver_step_up_verified_at: string | null;
}
interface Preview {
  action: Action; input: Record<string, unknown>; payload: Record<string, unknown>; url: string;
  previewHash: string; actionType: string; targetId: string; operation: Operation;
}
const INITIAL = {
  business_id: '', request_type: 'recovery', reason: '', target_action: 'transition_to_shared',
  target_channel_id: '', target_candidate_id: '', verification_method: 'manual_document_review',
  evidence_type: 'business_document', evidence_id: '', owner_reverified: false,
};

function OperationSummary({ operation }: { operation: Operation }) {
  const target = operation.target_snapshot;
  return <dl className="space-y-1 text-sm">
    <div><dt className="inline text-gray-500">Business: </dt><dd className="inline font-mono">{operation.business_id}</dd></div>
    <div><dt className="inline text-gray-500">Action: </dt><dd className="inline">{operation.target_action.replaceAll('_', ' ')}</dd></div>
    <div><dt className="inline text-gray-500">Destination: </dt><dd className="inline font-mono">{operation.target_channel_id || operation.target_candidate_id}</dd></div>
    {target && <div><dt className="inline text-gray-500">Number / country: </dt><dd className="inline">{target.phone_number || target.phone_number_normalized} / {target.country_code}</dd></div>}
    <div><dt className="inline text-gray-500">Reason: </dt><dd className="inline">{operation.reason}</dd></div>
    <div><dt className="inline text-gray-500">Version: </dt><dd className="inline">{operation.request_version}</dd></div>
    {operation.verification_record?.owner_reverified && <div>Owner manually reverified · {operation.verification_record.verification_method?.replaceAll('_', ' ')}</div>}
    {operation.verification_record?.evidence_refs?.map((ref, i) => <div key={i}>
      Evidence: {ref.type.replaceAll('_', ' ')} · {ref.document_id || ref.request_id} · {ref.snapshot?.status}
      {ref.snapshot?.reviewed_at && ` · reviewed ${ref.snapshot.reviewed_at}`}
      {ref.snapshot?.completed_at && ` · completed ${ref.snapshot.completed_at}`}
    </div>)}
  </dl>;
}

export default function ChannelChanges() {
  const [requests, setRequests] = useState<ChangeRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ ...INITIAL });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [pending, setPending] = useState<((id: string) => Promise<void>) | null>(null);
  const session = useAdminSession();
  const stepUp = useStepUp();
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApiGet('/api/admin/channel-changes');
      if (!res.ok) throw new Error('Unable to load requests');
      setRequests((await res.json()).requests || []);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, [refresh]);

  async function fail(error: unknown) {
    setPreview(null); setReviewed(false); setBusy(false);
    await refresh().catch(() => undefined);
    setError(error instanceof Error ? error.message : 'Operation failed. Reload and review again.');
  }
  async function loadPreview(action: Action, req?: ChangeRequest) {
    setBusy(true); setError(''); setMessage(''); setReviewed(false); setPreview(null);
    const payload: Record<string, unknown> = action === 'create' ? {
      business_id: form.business_id, request_type: form.request_type, reason: form.reason,
      target_action: form.target_action,
      target_channel_id: form.target_action === 'promote_candidate' ? null : form.target_channel_id,
      target_candidate_id: form.target_action === 'promote_candidate' ? form.target_candidate_id : null,
      ...(form.request_type === 'recovery' ? { verification_record: {
        owner_reverified: form.owner_reverified, verification_method: form.verification_method,
        evidence_refs: [{ type: form.evidence_type, [form.evidence_type === 'business_document' ? 'document_id' : 'request_id']: form.evidence_id }],
      } } : {}),
    } : action === 'approve' ? { review_confirmed: true } : {};
    const input = { action, ...(req ? { approval_id: req.id } : { business_id: form.business_id }), details: payload };
    try {
      const res = await adminApiFetch('/api/admin/channel-changes/preview', input);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Preview unavailable');
      setPreview({ ...data, action, input, payload, url: action === 'create' ? '/api/admin/channel-changes' : `/api/admin/channel-changes/${req!.id}/${action === 'refresh' ? 're-request' : action}` });
    } catch (error) { await fail(error); }
    finally { setBusy(false); }
  }
  async function authorize() {
    if (!preview || !reviewed || busy) return;
    const selected = preview;
    setBusy(true); setError('');
    const perform = async (stepUpId: string) => {
      try {
        const res = await adminApiFetch(selected.url, { ...selected.payload, previewHash: selected.previewHash, stepUpId });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Request failed. Review a fresh preview.');
        setMessage(selected.action === 'refresh' ? 'Authorization refreshed. A second admin must review and approve again.' : 'Channel change action completed.');
        setPreview(null); setPending(null); setReviewed(false);
        if (selected.action === 'create') { setShowCreate(false); setForm({ ...INITIAL }); }
        await refresh();
      } catch (error) { await fail(error); throw error; }
      finally { setBusy(false); }
    };
    try {
      await stepUp.execute({ actionType: selected.actionType, targetId: selected.targetId,
        params: { channel_change: selected.input, previewHash: selected.previewHash },
        description: `${selected.action} channel change for ${selected.operation.business_id}`, onAuthorized: perform });
      setPending(() => perform);
    } catch (error) { await fail(error); }
  }
  async function reject(req: ChangeRequest, action: 'reject' | 'cancel') {
    setBusy(true); setError('');
    try {
      const res = await adminApiFetch(`/api/admin/channel-changes/${req.id}/reject`, { action });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      await refresh();
    } catch (error) { await fail(error); }
    finally { setBusy(false); }
  }
  const fieldClass = 'block w-full border rounded px-3 py-2 text-sm';
  const buttonClass = 'border rounded px-3 py-2 text-sm disabled:opacity-50';
  return <div className="space-y-6">
    <div><h1 className="text-2xl font-bold">Channel Change Requests</h1>
      <p className="text-sm text-gray-500">Recovery and shared replacement require two distinct admins. Approvals expire after five minutes. Existing WhatsApp chat history is not transferred.</p></div>
    <button className={buttonClass} disabled={busy} onClick={() => { setShowCreate(!showCreate); setPreview(null); }}> {showCreate ? 'Close form' : 'Create Request'}</button>
    {showCreate && <fieldset disabled={busy} className="border rounded-lg p-4 space-y-3">
      <legend>New request</legend>
      <label className="block">Business ID<input className={fieldClass} value={form.business_id} onChange={e => setForm({ ...form, business_id: e.target.value })} /></label>
      <label className="block">Request type<select className={fieldClass} value={form.request_type} onChange={e => setForm({ ...form, request_type: e.target.value, target_action: e.target.value === 'shared_replacement' ? 'reassign_shared_channel' : 'transition_to_shared' })}>
        <option value="recovery">Lost-access recovery</option><option value="shared_replacement">Shared replacement</option>
      </select></label>
      <label className="block">Action<select className={fieldClass} value={form.target_action} onChange={e => setForm({ ...form, target_action: e.target.value })}>
        {form.request_type === 'recovery' && <option value="transition_to_shared">Transition to shared</option>}
        <option value="reassign_shared_channel">Reassign shared channel</option>
        {form.request_type === 'recovery' && <option value="promote_candidate">Promote ready candidate</option>}
      </select></label>
      {form.target_action === 'promote_candidate'
        ? <label className="block">Ready candidate ID<input className={fieldClass} value={form.target_candidate_id} onChange={e => setForm({ ...form, target_candidate_id: e.target.value })} /></label>
        : <label className="block">Shared destination channel ID<input className={fieldClass} value={form.target_channel_id} onChange={e => setForm({ ...form, target_channel_id: e.target.value })} /></label>}
      <label className="block">Reason<textarea maxLength={1000} className={fieldClass} value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} /></label>
      {form.request_type === 'recovery' && <div className="space-y-3">
        <label className="block">Verification method<select className={fieldClass} value={form.verification_method} onChange={e => setForm({ ...form, verification_method: e.target.value })}>
          {['manual_document_review', 'identity_verification', 'video_verification', 'in_person_verification'].map(method => <option key={method} value={method}>{method.replaceAll('_', ' ')}</option>)}
        </select></label>
        <label className="block">Evidence type<select className={fieldClass} value={form.evidence_type} onChange={e => setForm({ ...form, evidence_type: e.target.value })}>
          <option value="business_document">Approved business document</option><option value="verification_request">Completed verification request</option>
        </select></label>
        <label className="block">Evidence ID<input className={fieldClass} value={form.evidence_id} onChange={e => setForm({ ...form, evidence_id: e.target.value })} /></label>
        <label className="block"><input type="checkbox" checked={form.owner_reverified} onChange={e => setForm({ ...form, owner_reverified: e.target.checked })} /> I manually reverified this business owner's identity using the referenced evidence.</label>
      </div>}
      <button className={buttonClass} onClick={() => loadPreview('create')} disabled={!form.business_id || !form.reason || (form.request_type === 'recovery' && (!form.owner_reverified || !form.evidence_id))}>Preview request</button>
    </fieldset>}
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {message && <p role="status" className="text-green-700">{message}</p>}
    {preview && <section className="border border-blue-400 rounded-lg p-4 space-y-3" aria-label="Review exact channel change">
      <h2 className="font-semibold">Review before {preview.action}</h2>
      <OperationSummary operation={preview.operation} />
      {preview.action === 'refresh' && <p>Refreshing invalidates the prior approval. A second admin must approve again.</p>}
      <label className="block"><input type="checkbox" checked={reviewed} disabled={busy} onChange={e => setReviewed(e.target.checked)} /> I reviewed the exact destination, reason and verification evidence shown above.</label>
      <button className={buttonClass} disabled={!reviewed || busy} onClick={authorize}>Confirm with MFA</button>
      <button className={buttonClass} disabled={busy} onClick={() => setPreview(null)}>Dismiss preview</button>
    </section>}
    {loading ? <p>Loading…</p> : requests.length === 0 ? <p>No channel change requests.</p> : requests.map(req => {
      const open = ['pending', 'approved'].includes(req.status);
      const stale = Date.now() - new Date(req.requester_step_up_verified_at).getTime() >= 300000 || (req.approver_step_up_verified_at && Date.now() - new Date(req.approver_step_up_verified_at).getTime() >= 300000);
      return <article key={req.id} className="border rounded-lg p-4 space-y-3">
        <h2 className="font-semibold">{req.request_type.replaceAll('_', ' ')} · {req.status}</h2>
        <OperationSummary operation={req} />
        <p className="text-xs">Requester: {req.requester_admin_id} · Approver: {req.approver_admin_id || 'Awaiting second admin'}</p>
        {open && stale && <p className="text-amber-700">Approval expired. The requester must refresh, then a second admin must review again.</p>}
        <div className="flex flex-wrap gap-2">
          {req.status === 'pending' && req.requester_admin_id !== session?.userId && <button className={buttonClass} disabled={busy || !!stale} onClick={() => loadPreview('approve', req)}>Review and approve</button>}
          {req.status === 'approved' && <button className={buttonClass} disabled={busy || !!stale} onClick={() => loadPreview('execute', req)}>Review and execute</button>}
          {open && req.requester_admin_id === session?.userId && <button className={buttonClass} disabled={busy} onClick={() => loadPreview('refresh', req)}>Refresh authorization</button>}
          {open && <button className={buttonClass} disabled={busy} onClick={() => reject(req, 'reject')}>Reject</button>}
          {open && req.requester_admin_id === session?.userId && <button className={buttonClass} disabled={busy} onClick={() => reject(req, 'cancel')}>Cancel request</button>}
        </div>
      </article>;
    })}
    <StepUpDialog state={stepUp.state} onSubmit={async code => { if (pending) await stepUp.submitCode(code, pending); }}
      onCancel={() => { stepUp.reset(); setPending(null); setBusy(false); }} />
  </div>;
}

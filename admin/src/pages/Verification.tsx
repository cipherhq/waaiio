import { useEffect, useState, useRef } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDate, fmtDateTime, fmtCurrency } from '@/lib/formatters';
import { logAudit } from '@/lib/auditLog';
import {
  LEVEL_LABELS, LEVEL_COLORS,
  getPayoutLimit, formatPayoutLimit, getDocTypeLabel, getCurrencyCode,
  type CountryCode, type VerificationLevel,
} from '@/lib/verification';
import { Clock, CheckCircle, XCircle } from 'lucide-react';

interface BusinessDoc {
  id: string;
  business_id: string;
  type: string;
  file_url: string;
  file_name: string | null;
  status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
  uploaded_at: string;
}

interface VerificationRequest {
  id: string;
  business_id: string;
  requested_level: string;
  requested_by: string;
  documents_required: string[];
  message: string | null;
  status: string;
  completed_at: string | null;
  created_at: string;
  businesses?: { name: string; owner_id: string; country_code: string; verification_level: string; verification_status: string };
}

export default function Verification() {
  const [requests, setRequests] = useState<VerificationRequest[]>([]);
  const [pendingDocs, setPendingDocs] = useState<BusinessDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState<'pending' | 'history'>('pending');
  const [selected, setSelected] = useState<VerificationRequest | null>(null);
  const [docs, setDocs] = useState<BusinessDoc[]>([]);
  const [reviewNotes, setReviewNotes] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [processing, setProcessing] = useState(false);
  const loadRef = useRef(false);
  const perPage = 20;

  // Stats
  const [stats, setStats] = useState({ pending: 0, approvedThisMonth: 0, rejected: 0 });

  useEffect(() => {
    if (loadRef.current) return;
    loadRef.current = true;
    load();
  }, []);

  async function load() {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const [reqRes, docsRes, approvedRes, rejectedRes] = await Promise.all([
      adminDb
        .from('verification_requests')
        .select('*, businesses(name, owner_id, country_code, verification_level, verification_status)')
        .order('created_at', { ascending: false }),
      adminDb
        .from('business_documents')
        .select('*')
        .eq('status', 'pending')
        .order('uploaded_at', { ascending: false }),
      adminDb
        .from('businesses')
        .select('id', { count: 'exact', head: true })
        .eq('verification_status', 'verified')
        .gte('verified_at', monthStart),
      adminDb
        .from('verification_requests')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'rejected'),
    ]);

    setRequests((reqRes.data || []) as VerificationRequest[]);
    setPendingDocs(docsRes.data || []);
    setStats({
      pending: (docsRes.data || []).length,
      approvedThisMonth: approvedRes.count || 0,
      rejected: rejectedRes.count || 0,
    });
    setLoading(false);
  }

  // Load documents for selected request
  useEffect(() => {
    if (!selected) { setDocs([]); return; }
    adminDb
      .from('business_documents')
      .select('*')
      .eq('business_id', selected.business_id)
      .order('uploaded_at', { ascending: false })
      .then(({ data }) => setDocs(data || []));
  }, [selected]);

  const filteredRequests = tab === 'pending'
    ? requests.filter(r => r.status === 'pending')
    : requests;

  const totalPages = Math.max(1, Math.ceil(filteredRequests.length / perPage));
  const pageItems = filteredRequests.slice((page - 1) * perPage, page * perPage);

  async function approveVerification() {
    if (!selected || processing) return;
    setProcessing(true);

    // Idempotency check — verify the request is still pending
    const { data: current } = await adminDb
      .from('verification_requests')
      .select('status')
      .eq('id', selected.id)
      .single();

    if (current?.status !== 'pending') {
      alert('This request has already been processed');
      setProcessing(false);
      return;
    }

    const level = selected.requested_level as VerificationLevel;
    const cc = (selected.businesses?.country_code || 'NG') as CountryCode;
    const limit = getPayoutLimit(cc, level);

    // Update business
    const { error } = await adminDb
      .from('businesses')
      .update({
        verification_level: level,
        verification_status: 'verified',
        verification_notes: reviewNotes || null,
        verified_at: new Date().toISOString(),
        payout_limit_monthly: limit,
      })
      .eq('id', selected.business_id);

    if (error) {
      alert('Failed to approve: ' + error.message);
      setProcessing(false);
      return;
    }

    // Mark request completed
    await adminDb
      .from('verification_requests')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', selected.id);

    // Approve all pending docs for this business
    await adminDb
      .from('business_documents')
      .update({ status: 'approved', reviewed_at: new Date().toISOString() })
      .eq('business_id', selected.business_id)
      .eq('status', 'pending');

    // Send KYC approved email via API
    if (selected.businesses?.owner_id) {
      const { data: owner } = await adminDb
        .from('profiles')
        .select('email')
        .eq('id', selected.businesses.owner_id)
        .single();
      if (owner?.email) {
        const limitStr = formatPayoutLimit(cc, level);
        fetch(`${import.meta.env.VITE_API_URL}/api/email/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: owner.email,
            subject: `Verification approved — ${selected.businesses.name}`,
            html: `<p>Your business <strong>${selected.businesses.name}</strong> has been verified at the <strong>${LEVEL_LABELS[level]}</strong> level. Monthly payout limit: <strong>${limitStr}</strong>.</p>`,
          }),
        }).catch(() => {});
      }
    }

    await logAudit({
      action: 'approve_verification',
      entity_type: 'business',
      entity_id: selected.business_id,
      details: { level, limit, request_id: selected.id },
    });

    setSelected(null);
    setReviewNotes('');
    setProcessing(false);
    loadRef.current = false;
    load();
  }

  async function rejectVerification() {
    if (!selected || !rejectionReason.trim() || processing) return;
    setProcessing(true);

    // Idempotency check — verify the request is still pending
    const { data: current } = await adminDb
      .from('verification_requests')
      .select('status')
      .eq('id', selected.id)
      .single();

    if (current?.status !== 'pending') {
      alert('This request has already been processed');
      setProcessing(false);
      return;
    }

    await adminDb
      .from('businesses')
      .update({
        verification_status: 'rejected',
        verification_notes: rejectionReason,
      })
      .eq('id', selected.business_id);

    await adminDb
      .from('verification_requests')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', selected.id);

    // Send KYC rejected email
    if (selected.businesses?.owner_id) {
      const { data: owner } = await adminDb
        .from('profiles')
        .select('email')
        .eq('id', selected.businesses.owner_id)
        .single();
      if (owner?.email) {
        fetch(`${import.meta.env.VITE_API_URL}/api/email/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: owner.email,
            subject: `Verification update — ${selected.businesses.name}`,
            html: `<p>Verification for <strong>${selected.businesses.name}</strong> was not approved. Reason: ${rejectionReason}</p>`,
          }),
        }).catch(() => {});
      }
    }

    await logAudit({
      action: 'reject_verification',
      entity_type: 'business',
      entity_id: selected.business_id,
      details: { reason: rejectionReason, request_id: selected.id },
    });

    setSelected(null);
    setRejectionReason('');
    setProcessing(false);
    loadRef.current = false;
    load();
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Verification</h1>
      <p className="mt-1 text-sm text-gray-500">Review account verification requests and documents</p>

      {/* Summary Cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <SummaryCard label="Pending Reviews" value={stats.pending} icon={Clock} color="yellow" />
        <SummaryCard label="Verified This Month" value={stats.approvedThisMonth} icon={CheckCircle} color="green" />
        <SummaryCard label="Rejected" value={stats.rejected} icon={XCircle} color="red" />
      </div>

      {/* Tabs */}
      <div className="mt-6 flex gap-1 rounded-lg bg-gray-100 p-1 w-fit">
        <button
          onClick={() => { setTab('pending'); setPage(1); }}
          className={`rounded-md px-4 py-2 text-sm font-medium transition ${
            tab === 'pending' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Pending ({requests.filter(r => r.status === 'pending').length})
        </button>
        <button
          onClick={() => { setTab('history'); setPage(1); }}
          className={`rounded-md px-4 py-2 text-sm font-medium transition ${
            tab === 'history' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          All Requests
        </button>
      </div>

      {/* Pending Documents Alert */}
      {pendingDocs.length > 0 && tab === 'pending' && (
        <div className="mt-4 rounded-xl border border-yellow-200 bg-yellow-50 p-4">
          <p className="text-sm font-medium text-yellow-800">
            {pendingDocs.length} document{pendingDocs.length !== 1 ? 's' : ''} awaiting review
          </p>
        </div>
      )}

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">
            {tab === 'pending' ? 'No pending verification requests' : 'No verification requests yet'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Business</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Level Requested</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Documents</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Requested</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(r => (
                <tr
                  key={r.id}
                  onClick={() => setSelected(r)}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {r.businesses?.name || '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${LEVEL_COLORS[r.requested_level] || 'bg-gray-100 text-gray-600'}`}>
                      {LEVEL_LABELS[r.requested_level] || r.requested_level}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {r.documents_required.map(d => getDocTypeLabel((r.businesses?.country_code || 'NG') as CountryCode, d)).join(', ') || '—'}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtDate(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      {/* Review Modal */}
      <DetailModal
        open={!!selected}
        onClose={() => { setSelected(null); setReviewNotes(''); setRejectionReason(''); }}
        title={`Verify: ${selected?.businesses?.name || ''}`}
        wide
      >
        {selected && (
          <div className="space-y-5">
            {/* Current Status */}
            <div className="space-y-2 text-sm">
              <DetailRow label="Current Level" value={LEVEL_LABELS[selected.businesses?.verification_level || 'unverified']} />
              <DetailRow label="Current Status" value={selected.businesses?.verification_status || 'unverified'} />
              <DetailRow label="Requested Level" value={LEVEL_LABELS[selected.requested_level]} />
              <DetailRow label="New Payout Limit" value={
                formatPayoutLimit((selected.businesses?.country_code || 'NG') as CountryCode, selected.requested_level as VerificationLevel)
              } />
              {selected.message && <DetailRow label="Admin Note" value={selected.message} />}
            </div>

            {/* Required Documents */}
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Required Documents</p>
              <div className="space-y-1">
                {selected.documents_required.map(d => (
                  <div key={d} className="text-sm text-gray-700">
                    {getDocTypeLabel((selected.businesses?.country_code || 'NG') as CountryCode, d)}
                  </div>
                ))}
                {selected.documents_required.length === 0 && (
                  <p className="text-sm text-gray-400">No specific documents required</p>
                )}
              </div>
            </div>

            {/* Uploaded Documents */}
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Uploaded Documents ({docs.length})</p>
              {docs.length === 0 ? (
                <p className="text-sm text-gray-400">No documents uploaded yet</p>
              ) : (
                <div className="space-y-2">
                  {docs.map(doc => (
                    <div key={doc.id} className="flex items-center justify-between rounded-lg border border-gray-100 px-3 py-2">
                      <div>
                        <p className="text-sm font-medium text-gray-900">{getDocTypeLabel((selected?.businesses?.country_code || 'NG') as CountryCode, doc.type)}</p>
                        <p className="text-xs text-gray-400">{doc.file_name || 'Document'} &middot; {fmtDate(doc.uploaded_at)}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusBadge status={doc.status} />
                        <a
                          href={doc.file_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-brand hover:underline"
                          onClick={e => e.stopPropagation()}
                        >
                          View
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Actions (only for pending requests) */}
            {selected.status === 'pending' && (
              <div className="space-y-4 border-t border-gray-100 pt-4">
                {/* Approve */}
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Notes (optional)</label>
                  <textarea
                    value={reviewNotes}
                    onChange={e => setReviewNotes(e.target.value)}
                    rows={2}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
                    placeholder="Optional review notes..."
                  />
                  <button
                    onClick={approveVerification}
                    disabled={processing}
                    className="mt-2 w-full rounded-xl bg-green-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-green-700 disabled:opacity-50"
                  >
                    {processing ? 'Processing...' : `Approve — Set to ${LEVEL_LABELS[selected.requested_level]}`}
                  </button>
                </div>

                {/* Reject */}
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Rejection Reason</label>
                  <textarea
                    value={rejectionReason}
                    onChange={e => setRejectionReason(e.target.value)}
                    rows={2}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
                    placeholder="Reason for rejection..."
                  />
                  <button
                    onClick={rejectVerification}
                    disabled={processing || !rejectionReason.trim()}
                    className="mt-2 w-full rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-red-700 disabled:opacity-50"
                  >
                    {processing ? 'Processing...' : 'Reject Verification'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </DetailModal>
    </div>
  );
}

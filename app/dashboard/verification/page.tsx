'use client';

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import {
  formatCurrency, formatPayoutLimit, getVerificationTiers, getDocTypesForCountry,
  type CountryCode, type VerificationLevel,
} from '@/lib/constants';

interface BusinessDoc {
  id: string;
  type: string;
  file_url: string;
  file_name: string | null;
  status: string;
  rejection_reason: string | null;
  uploaded_at: string;
}

interface VerificationRequest {
  id: string;
  requested_level: string;
  documents_required: string[];
  message: string | null;
  status: string;
  created_at: string;
}

const LEVEL_COLORS: Record<string, string> = {
  unverified: 'bg-gray-100 text-gray-600 border-gray-200',
  basic: 'bg-blue-50 text-blue-700 border-blue-200',
  standard: 'bg-purple-50 text-purple-700 border-purple-200',
  full: 'bg-green-50 text-green-700 border-green-200',
};

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
};

export default function VerificationPage() {
  const business = useBusiness();
  const supabase = createClient();
  const [docs, setDocs] = useState<BusinessDoc[]>([]);
  const [requests, setRequests] = useState<VerificationRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedDocType, setSelectedDocType] = useState<string | null>(null);

  const biz = business as unknown as Record<string, unknown>;
  const verificationLevel = (biz.verification_level as string) || 'unverified';
  const verificationStatus = (biz.verification_status as string) || 'unverified';
  const payoutLimit = Number(biz.payout_limit_monthly || 0);
  const country = (business.country_code || 'NG') as CountryCode;
  const tiers = getVerificationTiers(country);
  const docTypes = getDocTypesForCountry(country);

  useEffect(() => {
    async function load() {
      const [docsRes, reqRes] = await Promise.all([
        supabase
          .from('business_documents')
          .select('id, type, file_url, file_name, status, rejection_reason, uploaded_at')
          .eq('business_id', business.id)
          .order('uploaded_at', { ascending: false }),
        supabase
          .from('verification_requests')
          .select('id, requested_level, documents_required, message, status, created_at')
          .eq('business_id', business.id)
          .order('created_at', { ascending: false }),
      ]);
      setDocs(docsRes.data || []);
      setRequests(reqRes.data || []);
      setLoading(false);
    }
    load();
  }, [business.id]);

  async function handleUpload(docType: string, file: File) {
    setUploading(docType);

    const ext = file.name.split('.').pop() || 'pdf';
    const path = `verification/${business.id}/${docType}-${Date.now()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('business-documents')
      .upload(path, file, { upsert: false });

    if (uploadError) {
      alert('Upload failed: ' + uploadError.message);
      setUploading(null);
      return;
    }

    const { data: urlData } = supabase.storage
      .from('business-documents')
      .getPublicUrl(path);

    const fileUrl = urlData.publicUrl;

    const { error: insertError } = await supabase
      .from('business_documents')
      .insert({
        business_id: business.id,
        type: docType,
        file_url: fileUrl,
        file_name: file.name,
        status: 'pending',
      });

    if (insertError) {
      alert('Failed to save document: ' + insertError.message);
      setUploading(null);
      return;
    }

    // Reload docs
    const { data } = await supabase
      .from('business_documents')
      .select('id, type, file_url, file_name, status, rejection_reason, uploaded_at')
      .eq('business_id', business.id)
      .order('uploaded_at', { ascending: false });
    setDocs(data || []);
    setUploading(null);
  }

  function triggerFileUpload(docType: string) {
    setSelectedDocType(docType);
    setTimeout(() => fileInputRef.current?.click(), 0);
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file && selectedDocType) {
      handleUpload(selectedDocType, file);
    }
    e.target.value = '';
  }

  // Get latest doc for each type
  function getDocForType(type: string): BusinessDoc | undefined {
    return docs.find(d => d.type === type);
  }

  const pendingRequest = requests.find(r => r.status === 'pending');

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <Link href="/dashboard" className="text-gray-400 hover:text-gray-600">
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </Link>
        <h1 className="text-2xl font-bold text-gray-900">Verification</h1>
      </div>
      <p className="mt-1 text-sm text-gray-500">Verify your business to unlock payouts and higher limits</p>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png"
        className="hidden"
        onChange={onFileChange}
      />

      {/* Current Level Card */}
      <div className={`mt-6 rounded-xl border p-5 ${LEVEL_COLORS[verificationLevel]}`}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold uppercase opacity-70">Verification Level</p>
            <p className="mt-1 text-xl font-bold">{tiers[verificationLevel as VerificationLevel]?.label || verificationLevel}</p>
          </div>
          <div className="text-right">
            <p className="text-xs font-semibold uppercase opacity-70">Monthly Payout Limit</p>
            <p className="mt-1 text-xl font-bold">
              {payoutLimit >= 999999999 ? 'Unlimited' : payoutLimit === 0 ? 'No payouts' : formatCurrency(payoutLimit, country)}
            </p>
          </div>
        </div>
        {verificationStatus === 'pending' && (
          <p className="mt-3 text-sm opacity-80">Your verification is being reviewed...</p>
        )}
        {verificationStatus === 'rejected' && (
          <p className="mt-3 text-sm opacity-80">Verification was not approved. Please review feedback and resubmit documents.</p>
        )}
      </div>

      {/* Verification Tiers */}
      <div className="mt-6">
        <h2 className="text-base font-semibold text-gray-900">Verification Tiers</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(['unverified', 'basic', 'standard', 'full'] as VerificationLevel[]).map(level => {
            const tier = tiers[level];
            return { level, label: tier.label, limit: formatPayoutLimit(country, level), req: tier.requirements };
          }).map(tier => (
            <div
              key={tier.level}
              className={`rounded-xl border p-4 ${
                verificationLevel === tier.level
                  ? 'border-brand bg-brand-50/30 ring-1 ring-brand/20'
                  : 'border-gray-200 bg-white'
              }`}
            >
              <p className="text-sm font-semibold text-gray-900">{tier.label}</p>
              <p className="mt-1 text-lg font-bold text-gray-900">{tier.limit}</p>
              <p className="mt-1 text-xs text-gray-500">{tier.req}</p>
              {verificationLevel === tier.level && (
                <span className="mt-2 inline-block rounded-full bg-brand px-2 py-0.5 text-[10px] font-semibold text-white">
                  Current
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Pending Request from Admin */}
      {pendingRequest && (
        <div className="mt-6 rounded-xl border border-blue-200 bg-blue-50 p-4">
          <p className="text-sm font-semibold text-blue-800">Verification Requested</p>
          <p className="mt-1 text-xs text-blue-700">
            You've been asked to verify at the <strong>{tiers[pendingRequest.requested_level as VerificationLevel]?.label || pendingRequest.requested_level}</strong> level.
            {pendingRequest.message && <> — {pendingRequest.message}</>}
          </p>
          {pendingRequest.documents_required.length > 0 && (
            <p className="mt-2 text-xs text-blue-700">
              <strong>Required:</strong> {pendingRequest.documents_required.map(d =>
                docTypes.find(t => t.key === d)?.label || d.replace(/_/g, ' ')
              ).join(', ')}
            </p>
          )}
        </div>
      )}

      {/* Upload Documents */}
      <div className="mt-6">
        <h2 className="text-base font-semibold text-gray-900">Documents</h2>
        <p className="mt-1 text-xs text-gray-500">Upload documents to verify your business. Accepted: PDF, JPG, PNG (max 10MB)</p>

        <div className="mt-4 space-y-3">
          {docTypes.map(docType => {
            const doc = getDocForType(docType.key);
            const isRequired = pendingRequest?.documents_required.includes(docType.key);

            return (
              <div
                key={docType.key}
                className={`flex items-center justify-between rounded-xl border p-4 ${
                  isRequired ? 'border-blue-200 bg-blue-50/30' : 'border-gray-100 bg-white'
                }`}
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-gray-900">{docType.label}</p>
                    {isRequired && (
                      <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700">
                        Required
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500">{docType.desc}</p>
                  {doc && (
                    <div className="mt-1.5 flex items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_COLORS[doc.status] || 'bg-gray-100 text-gray-600'}`}>
                        {doc.status}
                      </span>
                      <span className="text-xs text-gray-400">{doc.file_name || 'Document'}</span>
                      {doc.status === 'rejected' && doc.rejection_reason && (
                        <span className="text-xs text-red-600">— {doc.rejection_reason}</span>
                      )}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => triggerFileUpload(docType.key)}
                  disabled={uploading === docType.key}
                  className={`shrink-0 rounded-lg px-3 py-2 text-xs font-semibold transition ${
                    doc?.status === 'approved'
                      ? 'border border-green-200 bg-green-50 text-green-700'
                      : 'bg-brand text-white hover:bg-brand-600'
                  } disabled:opacity-50`}
                >
                  {uploading === docType.key ? 'Uploading...' : doc?.status === 'approved' ? 'Approved' : doc ? 'Re-upload' : 'Upload'}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Submitted Documents History */}
      {docs.length > 0 && (
        <div className="mt-6">
          <h2 className="text-base font-semibold text-gray-900">Submission History</h2>
          <div className="mt-3 overflow-x-auto rounded-xl border border-gray-100 bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-50 bg-gray-50/50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Document</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">File</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Uploaded</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {docs.map(doc => (
                  <tr key={doc.id}>
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {docTypes.find(t => t.key === doc.type)?.label || doc.type.replace(/_/g, ' ')}
                    </td>
                    <td className="px-4 py-3">
                      <a
                        href={doc.file_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-brand hover:underline text-xs"
                      >
                        {doc.file_name || 'View'}
                      </a>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[doc.status] || 'bg-gray-100 text-gray-600'}`}>
                        {doc.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {new Date(doc.uploaded_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

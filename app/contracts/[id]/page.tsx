import { notFound } from 'next/navigation';
import { createServiceClient } from '@/lib/supabase/service';
import { Metadata } from 'next';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ token?: string }>;
}

export const metadata: Metadata = {
  title: 'Signed Document',
  robots: 'noindex, nofollow',
};

function maskIp(ip: string): string {
  if (!ip || ip === 'unknown') return 'unknown';
  const parts = ip.split('.');
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.*.* `;
  }
  // IPv6 or other format — show first segment only
  return ip.split(':').slice(0, 2).join(':') + ':***';
}

export default async function ContractAccessPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { token } = await searchParams;

  if (!token || token.length < 16) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6">
        <div className="max-w-sm text-center">
          <h1 className="text-xl font-bold text-gray-900">Access Denied</h1>
          <p className="mt-2 text-gray-600">A valid signer token is required to view this document.</p>
        </div>
      </div>
    );
  }

  const supabase = createServiceClient();

  // Fetch contract
  const { data: contract, error } = await supabase
    .from('contracts')
    .select('id, title, status, business_id, token, signed_at, signed_url, audit_trail, signer_name, signer_email')
    .eq('id', id)
    .single();

  if (error || !contract) {
    notFound();
  }

  // Verify token: check single-signer token or multi-signer token
  let authorized = false;
  let viewerName = contract.signer_name || 'Signer';
  let auditData = contract.audit_trail as { ip?: string; signed_at?: string; device_type?: string } | null;

  if (contract.token === token) {
    authorized = true;
  }

  if (!authorized) {
    const { data: signer } = await supabase
      .from('contract_signers')
      .select('id, signer_name, signed_at, audit_trail, status')
      .eq('contract_id', contract.id)
      .eq('token', token)
      .maybeSingle();

    if (signer) {
      authorized = true;
      viewerName = signer.signer_name || 'Signer';
      auditData = signer.audit_trail as typeof auditData;
    }
  }

  if (!authorized) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6">
        <div className="max-w-sm text-center">
          <h1 className="text-xl font-bold text-gray-900">Access Denied</h1>
          <p className="mt-2 text-gray-600">This token does not have access to this document.</p>
        </div>
      </div>
    );
  }

  // Get business name
  const { data: biz } = await supabase
    .from('businesses')
    .select('name, logo_url')
    .eq('id', contract.business_id)
    .single();

  const businessName = biz?.name || 'Business';
  const hasPdf = contract.signed_url?.endsWith('.pdf') && contract.status === 'signed';
  const downloadUrl = `/api/contracts/pdf/${contract.id}?token=${token}`;

  const signedAt = contract.signed_at || auditData?.signed_at;
  const formattedDate = signedAt
    ? new Date(signedAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  return (
    <div className="flex min-h-screen flex-col items-center bg-gray-50 p-6">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="mb-6 text-center">
          {biz?.logo_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={biz.logo_url}
              alt={businessName}
              className="mx-auto mb-3 h-12 w-12 rounded-lg object-contain"
            />
          )}
          <p className="text-xs font-medium uppercase tracking-wider text-gray-400">
            {businessName}
          </p>
        </div>

        {/* Card */}
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-bold text-gray-900">{contract.title}</h1>

          {/* Status badge */}
          <div className="mt-3">
            {contract.status === 'signed' ? (
              <span className="inline-flex items-center rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800">
                Signed
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full bg-yellow-100 px-3 py-1 text-xs font-medium text-yellow-800">
                {contract.status === 'pending' ? 'Pending' : contract.status}
              </span>
            )}
          </div>

          {/* Details */}
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">Business</dt>
              <dd className="font-medium text-gray-900">{businessName}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Signer</dt>
              <dd className="font-medium text-gray-900">{viewerName}</dd>
            </div>
            {formattedDate && (
              <div className="flex justify-between">
                <dt className="text-gray-500">Signed</dt>
                <dd className="font-medium text-gray-900">{formattedDate}</dd>
              </div>
            )}
          </dl>

          {/* Download button */}
          {hasPdf && (
            <a
              href={downloadUrl}
              className="mt-6 block w-full rounded-lg bg-blue-600 px-4 py-3 text-center text-sm font-medium text-white transition hover:bg-blue-700"
            >
              Download Signed PDF
            </a>
          )}

          {!hasPdf && contract.status === 'signed' && (
            <p className="mt-4 text-sm text-gray-500">
              The signed PDF is not yet available. It will be generated once all parties have signed.
            </p>
          )}

          {/* Audit trail summary */}
          {auditData && contract.status === 'signed' && (
            <div className="mt-6 border-t border-gray-100 pt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                Audit Trail
              </h3>
              <dl className="mt-2 space-y-1 text-xs text-gray-500">
                <div className="flex justify-between">
                  <dt>Signed by</dt>
                  <dd className="text-gray-700">{viewerName}</dd>
                </div>
                {auditData.signed_at && (
                  <div className="flex justify-between">
                    <dt>Date</dt>
                    <dd className="text-gray-700">
                      {new Date(auditData.signed_at).toLocaleString('en-US')}
                    </dd>
                  </div>
                )}
                {auditData.ip && (
                  <div className="flex justify-between">
                    <dt>IP (partial)</dt>
                    <dd className="text-gray-700">{maskIp(auditData.ip)}</dd>
                  </div>
                )}
                {auditData.device_type && (
                  <div className="flex justify-between">
                    <dt>Device</dt>
                    <dd className="capitalize text-gray-700">{auditData.device_type}</dd>
                  </div>
                )}
              </dl>
            </div>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-gray-400">
          Powered by Waaiio
        </p>
      </div>
    </div>
  );
}

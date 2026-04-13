'use client';

import { useState, useEffect, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { CONTRACT_TEMPLATES, fillTemplatePlaceholders } from '@/lib/contract-templates';

interface Contract {
  id: string;
  title: string;
  signer_name: string | null;
  signer_phone: string | null;
  status: string;
  signed_at: string | null;
  created_at: string;
  token_expires_at: string;
  document_content: string | null;
  signed_url: string | null;
  audit_trail: Record<string, string> | null;
  signature_data: string | null;
}

export default function ContractsPage() {
  const business = useBusiness();
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [sending, setSending] = useState(false);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [selectedContract, setSelectedContract] = useState<Contract | null>(null);

  // Form state — Step 1: Document
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [title, setTitle] = useState('');
  const [documentContent, setDocumentContent] = useState('');
  const [showPreview, setShowPreview] = useState(false);

  // Form state — Step 2: Signer
  const [signerName, setSignerName] = useState('');
  const [signerPhone, setSignerPhone] = useState('');
  const [signerEmail, setSignerEmail] = useState('');

  const supabase = createClient();

  const loadContracts = useCallback(async () => {
    const { data } = await supabase
      .from('contracts')
      .select('id, title, signer_name, signer_phone, status, signed_at, created_at, token_expires_at, document_content, signed_url, audit_trail, signature_data')
      .eq('business_id', business.id)
      .order('created_at', { ascending: false });

    setContracts(data || []);
    setLoading(false);
  }, [business.id, supabase]);

  useEffect(() => {
    loadContracts();
  }, [loadContracts]);

  function resetForm() {
    setStep(1);
    setSelectedTemplate('');
    setTitle('');
    setDocumentContent('');
    setShowPreview(false);
    setSignerName('');
    setSignerPhone('');
    setSignerEmail('');
  }

  function handleTemplateChange(templateId: string) {
    setSelectedTemplate(templateId);
    if (templateId) {
      const tmpl = CONTRACT_TEMPLATES.find(t => t.id === templateId);
      if (tmpl) {
        setTitle(tmpl.name);
        setDocumentContent(tmpl.content);
      }
    }
  }

  async function handleSendForSignature(e: React.FormEvent) {
    e.preventDefault();
    if (!title || !signerPhone) return;

    setSending(true);

    // Replace placeholders before sending
    const finalContent = documentContent
      ? fillTemplatePlaceholders(documentContent, {
          business_name: business.name,
          signer_name: signerName || undefined,
        })
      : undefined;

    try {
      const res = await fetch('/api/contracts/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: business.id,
          title,
          signer_phone: signerPhone,
          signer_name: signerName || undefined,
          signer_email: signerEmail || undefined,
          document_content: finalContent,
        }),
      });

      if (res.ok) {
        setShowModal(false);
        resetForm();
        await loadContracts();
      }
    } catch (err) {
      console.error('Failed to send:', err);
    } finally {
      setSending(false);
    }
  }

  async function handleResend(contractId: string) {
    setResendingId(contractId);
    try {
      await fetch('/api/contracts/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contract_id: contractId }),
      });
      await loadContracts();
    } catch (err) {
      console.error('Failed to resend:', err);
    } finally {
      setResendingId(null);
    }
  }

  function getStatusBadge(status: string) {
    switch (status) {
      case 'signed':
        return <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700">Signed</span>;
      case 'pending':
        return <span className="inline-flex items-center rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-700">Pending</span>;
      case 'expired':
        return <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600">Expired</span>;
      case 'revoked':
        return <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700">Revoked</span>;
      default:
        return <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600">{status}</span>;
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Contracts</h1>
          <p className="mt-1 text-sm text-gray-500">Send documents for e-signature via WhatsApp</p>
        </div>
        <button
          onClick={() => { resetForm(); setShowModal(true); }}
          className="rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90"
        >
          Send for Signature
        </button>
      </div>

      {/* Contracts table */}
      {loading ? (
        <div className="py-20 text-center text-gray-400">Loading contracts...</div>
      ) : contracts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 py-20 text-center">
          <p className="text-gray-500">No contracts yet</p>
          <p className="mt-1 text-sm text-gray-400">Send your first document for signature</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Document</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Signer</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Date</th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {contracts.map(c => (
                <tr
                  key={c.id}
                  className="cursor-pointer hover:bg-gray-50"
                  onClick={() => setSelectedContract(c)}
                >
                  <td className="whitespace-nowrap px-4 py-3">
                    <p className="text-sm font-medium text-gray-900">{c.title}</p>
                    {c.document_content && (
                      <p className="text-xs text-gray-400">Has document content</p>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <p className="text-sm text-gray-700">{c.signer_name || '—'}</p>
                    <p className="text-xs text-gray-400">{c.signer_phone}</p>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    {getStatusBadge(c.status)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500">
                    {c.signed_at
                      ? new Date(c.signed_at).toLocaleDateString()
                      : new Date(c.created_at).toLocaleDateString()}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-2">
                      {(c.status === 'expired' || c.status === 'pending') && (
                        <button
                          onClick={() => handleResend(c.id)}
                          disabled={resendingId === c.id}
                          className="text-sm font-medium text-brand hover:underline disabled:opacity-50"
                        >
                          {resendingId === c.id ? 'Sending...' : 'Re-send'}
                        </button>
                      )}
                      {c.status === 'signed' && c.signed_url?.endsWith('.pdf') && (
                        <a
                          href={`/api/contracts/pdf/${c.id}`}
                          className="text-sm font-medium text-brand hover:underline"
                        >
                          Download PDF
                        </a>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Contract Detail Modal */}
      {selectedContract && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="mx-4 max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="text-lg font-bold text-gray-900">{selectedContract.title}</h2>
                <p className="mt-1 text-sm text-gray-500">
                  {selectedContract.signer_name || 'No name'} &middot; {selectedContract.signer_phone}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {getStatusBadge(selectedContract.status)}
                <button
                  onClick={() => setSelectedContract(null)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Document Content */}
            {selectedContract.document_content ? (
              <div className="mb-4 max-h-64 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-4">
                <pre className="whitespace-pre-wrap font-sans text-sm text-gray-700">
                  {selectedContract.document_content}
                </pre>
              </div>
            ) : (
              <p className="mb-4 text-sm italic text-gray-400">No document content (title-only contract)</p>
            )}

            {/* Signature + Audit (for signed contracts) */}
            {selectedContract.status === 'signed' && (
              <div className="space-y-3 border-t border-gray-200 pt-4">
                <p className="text-sm font-medium text-gray-700">
                  Signed on: {selectedContract.signed_at ? new Date(selectedContract.signed_at).toLocaleString() : '—'}
                </p>

                {selectedContract.signature_data && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-gray-500">Signature:</p>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={selectedContract.signature_data}
                      alt="Signature"
                      className="h-20 rounded border border-gray-200 bg-white"
                    />
                  </div>
                )}

                {selectedContract.audit_trail && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-gray-500">Audit Trail:</p>
                    <div className="rounded bg-gray-50 p-2 text-xs text-gray-600">
                      <p>IP: {selectedContract.audit_trail.ip}</p>
                      <p>Device: {selectedContract.audit_trail.device_type}</p>
                      <p className="truncate">UA: {selectedContract.audit_trail.user_agent}</p>
                    </div>
                  </div>
                )}

                {selectedContract.signed_url?.endsWith('.pdf') && (
                  <a
                    href={`/api/contracts/pdf/${selectedContract.id}`}
                    className="inline-block rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
                  >
                    Download Signed PDF
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Send Modal — 2-Step Flow */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="mx-4 max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl">
            <h2 className="text-lg font-bold text-gray-900">Send for Signature</h2>
            <p className="mt-1 text-sm text-gray-500">
              {step === 1 ? 'Create your document' : 'Enter signer details'}
            </p>

            {/* Step indicators */}
            <div className="mt-3 flex gap-2">
              <div className={`h-1 flex-1 rounded ${step >= 1 ? 'bg-brand' : 'bg-gray-200'}`} />
              <div className={`h-1 flex-1 rounded ${step >= 2 ? 'bg-brand' : 'bg-gray-200'}`} />
            </div>

            <form onSubmit={handleSendForSignature} className="mt-4">
              {step === 1 && (
                <div className="space-y-4">
                  {/* Template selector */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Template</label>
                    <select
                      value={selectedTemplate}
                      onChange={e => handleTemplateChange(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                    >
                      <option value="">Blank Document</option>
                      {CONTRACT_TEMPLATES.map(t => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                  </div>

                  {/* Title */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Document Title *</label>
                    <input
                      type="text"
                      value={title}
                      onChange={e => setTitle(e.target.value)}
                      placeholder="e.g. Tenancy Agreement"
                      required
                      className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                    />
                  </div>

                  {/* Document content */}
                  {showPreview ? (
                    <div>
                      <div className="mb-1 flex items-center justify-between">
                        <label className="block text-sm font-medium text-gray-700">Preview</label>
                        <button
                          type="button"
                          onClick={() => setShowPreview(false)}
                          className="text-xs font-medium text-brand hover:underline"
                        >
                          Edit
                        </button>
                      </div>
                      <div className="max-h-64 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-4">
                        <pre className="whitespace-pre-wrap font-sans text-sm text-gray-700">
                          {fillTemplatePlaceholders(documentContent, {
                            business_name: business.name,
                            signer_name: signerName || '{{signer_name}}',
                          })}
                        </pre>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="mb-1 flex items-center justify-between">
                        <label className="block text-sm font-medium text-gray-700">Document Content</label>
                        {documentContent && (
                          <button
                            type="button"
                            onClick={() => setShowPreview(true)}
                            className="text-xs font-medium text-brand hover:underline"
                          >
                            Preview
                          </button>
                        )}
                      </div>
                      <textarea
                        value={documentContent}
                        onChange={e => setDocumentContent(e.target.value)}
                        rows={15}
                        placeholder="Enter the document text that the signer will review..."
                        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                      />
                      <p className="mt-1 text-xs text-gray-400">
                        Use {'{{business_name}}'}, {'{{signer_name}}'}, {'{{date}}'} as placeholders
                      </p>
                    </div>
                  )}

                  <div className="flex gap-3 pt-2">
                    <button
                      type="button"
                      onClick={() => { setShowModal(false); resetForm(); }}
                      className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => setStep(2)}
                      disabled={!title}
                      className="flex-1 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}

              {step === 2 && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Signer Phone *</label>
                    <input
                      type="tel"
                      value={signerPhone}
                      onChange={e => setSignerPhone(e.target.value)}
                      placeholder="e.g. 2348012345678"
                      required
                      className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Signer Name</label>
                    <input
                      type="text"
                      value={signerName}
                      onChange={e => setSignerName(e.target.value)}
                      placeholder="e.g. John Doe"
                      className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Signer Email</label>
                    <input
                      type="email"
                      value={signerEmail}
                      onChange={e => setSignerEmail(e.target.value)}
                      placeholder="e.g. john@example.com"
                      className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                    />
                  </div>

                  <div className="flex gap-3 pt-2">
                    <button
                      type="button"
                      onClick={() => setStep(1)}
                      className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                    >
                      Back
                    </button>
                    <button
                      type="submit"
                      disabled={sending || !title || !signerPhone}
                      className="flex-1 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                    >
                      {sending ? 'Sending...' : 'Send via WhatsApp'}
                    </button>
                  </div>
                </div>
              )}
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

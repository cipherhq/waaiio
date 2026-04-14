'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { CONTRACT_TEMPLATES, fillTemplatePlaceholders } from '@/lib/contract-templates';
import { PhoneInput } from '@/components/auth/PhoneInput';

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
  template_url: string | null;
}

type DocTab = 'template' | 'write' | 'upload';

export default function ContractsPage() {
  const business = useBusiness();
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [sending, setSending] = useState(false);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [selectedContract, setSelectedContract] = useState<Contract | null>(null);

  // Edit state
  const [editingContract, setEditingContract] = useState<Contract | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editSignerName, setEditSignerName] = useState('');
  const [editSignerPhone, setEditSignerPhone] = useState('');
  const [editSignerEmail, setEditSignerEmail] = useState('');
  const [saving, setSaving] = useState(false);

  // Form state — Step 1: Document
  const [step, setStep] = useState<1 | 2>(1);
  const [docTab, setDocTab] = useState<DocTab>('template');
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [title, setTitle] = useState('');
  const [documentContent, setDocumentContent] = useState('');
  const [showPreview, setShowPreview] = useState(false);

  // Upload state
  const [uploadedFileUrl, setUploadedFileUrl] = useState('');
  const [uploadedFileName, setUploadedFileName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Form state — Step 2: Signer
  const [signerName, setSignerName] = useState('');
  const [signerPhone, setSignerPhone] = useState('');
  const [signerEmail, setSignerEmail] = useState('');

  const supabase = createClient();

  const loadContracts = useCallback(async () => {
    const { data } = await supabase
      .from('contracts')
      .select('id, title, signer_name, signer_phone, status, signed_at, created_at, token_expires_at, document_content, signed_url, audit_trail, signature_data, template_url')
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
    setDocTab('template');
    setSelectedTemplate('');
    setTitle('');
    setDocumentContent('');
    setShowPreview(false);
    setUploadedFileUrl('');
    setUploadedFileName('');
    setUploading(false);
    setUploadError('');
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

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadError('');
    setUploading(true);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('business_id', business.id);

    try {
      const res = await fetch('/api/contracts/upload', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        setUploadError(data.error || 'Upload failed');
        return;
      }

      setUploadedFileUrl(data.file_url);
      setUploadedFileName(data.file_name);
      if (!title) {
        setTitle(data.file_name.replace(/\.[^.]+$/, ''));
      }
    } catch {
      setUploadError('Upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  }

  function removeUploadedFile() {
    setUploadedFileUrl('');
    setUploadedFileName('');
    setUploadError('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
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
          template_url: uploadedFileUrl || undefined,
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

  function openEditModal(c: Contract) {
    setEditingContract(c);
    setEditTitle(c.title);
    setEditSignerName(c.signer_name || '');
    setEditSignerPhone(c.signer_phone || '');
    setEditSignerEmail('');
  }

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingContract || !editTitle || !editSignerPhone) return;

    setSaving(true);
    try {
      const res = await fetch('/api/contracts/update', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contract_id: editingContract.id,
          title: editTitle,
          signer_name: editSignerName || null,
          signer_phone: editSignerPhone,
          signer_email: editSignerEmail || null,
        }),
      });

      if (res.ok) {
        setEditingContract(null);
        setSelectedContract(null);
        await loadContracts();
      }
    } catch (err) {
      console.error('Failed to update:', err);
    } finally {
      setSaving(false);
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

  // Check if Step 1 can proceed to Step 2
  const canProceed = title && (docTab !== 'upload' || uploadedFileUrl);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Waaiio Sign</h1>
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
        <div className="py-20 text-center text-gray-400">Loading documents...</div>
      ) : contracts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 py-20 text-center">
          <p className="text-gray-500">No documents yet</p>
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
                    {c.template_url ? (
                      <p className="text-xs text-gray-400">Uploaded document</p>
                    ) : c.document_content ? (
                      <p className="text-xs text-gray-400">Has document content</p>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <p className="text-sm text-gray-700">{c.signer_name || '\u2014'}</p>
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
                        <>
                          <button
                            onClick={() => openEditModal(c)}
                            className="text-sm font-medium text-gray-600 hover:underline"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleResend(c.id)}
                            disabled={resendingId === c.id}
                            className="text-sm font-medium text-brand hover:underline disabled:opacity-50"
                          >
                            {resendingId === c.id ? 'Sending...' : 'Re-send'}
                          </button>
                        </>
                      )}
                      {c.status === 'signed' && c.signed_url?.endsWith('.pdf') && (
                        <>
                          <a
                            href={`/api/contracts/pdf/${c.id}?view=true`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm font-medium text-brand hover:underline"
                          >
                            View
                          </a>
                          <a
                            href={`/api/contracts/pdf/${c.id}`}
                            className="text-sm font-medium text-gray-600 hover:underline"
                          >
                            Download
                          </a>
                        </>
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
                {(selectedContract.status === 'pending' || selectedContract.status === 'expired') && (
                  <button
                    onClick={() => openEditModal(selectedContract)}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-gray-50"
                  >
                    Edit
                  </button>
                )}
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

            {/* Uploaded Document */}
            {selectedContract.template_url && (
              <div className="mb-4">
                <p className="mb-2 text-xs font-medium text-gray-500">Uploaded Document</p>
                <a
                  href={`/api/contracts/document/${selectedContract.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-brand hover:bg-gray-100"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  View uploaded document
                </a>
              </div>
            )}

            {/* Document Content */}
            {selectedContract.document_content ? (
              <div className="mb-4 max-h-64 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-4">
                <pre className="whitespace-pre-wrap font-sans text-sm text-gray-700">
                  {selectedContract.document_content}
                </pre>
              </div>
            ) : !selectedContract.template_url ? (
              <p className="mb-4 text-sm italic text-gray-400">No document content (title-only)</p>
            ) : null}

            {/* Signature + Audit (for signed contracts) */}
            {selectedContract.status === 'signed' && (
              <div className="space-y-3 border-t border-gray-200 pt-4">
                <p className="text-sm font-medium text-gray-700">
                  Signed on: {selectedContract.signed_at ? new Date(selectedContract.signed_at).toLocaleString() : '\u2014'}
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
                  <div className="flex gap-3">
                    <a
                      href={`/api/contracts/pdf/${selectedContract.id}?view=true`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                      View PDF
                    </a>
                    <a
                      href={`/api/contracts/pdf/${selectedContract.id}`}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      Download
                    </a>
                  </div>
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
                  {/* Document source tabs */}
                  <div className="flex rounded-lg border border-gray-200 p-0.5">
                    {([
                      { key: 'template' as DocTab, label: 'Template' },
                      { key: 'write' as DocTab, label: 'Write Content' },
                      { key: 'upload' as DocTab, label: 'Upload File' },
                    ]).map(tab => (
                      <button
                        key={tab.key}
                        type="button"
                        onClick={() => setDocTab(tab.key)}
                        className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                          docTab === tab.key
                            ? 'bg-brand text-white'
                            : 'text-gray-600 hover:text-gray-900'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>

                  {/* Title (shown for all tabs) */}
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

                  {/* Template tab */}
                  {docTab === 'template' && (
                    <>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Template</label>
                        <select
                          value={selectedTemplate}
                          onChange={e => handleTemplateChange(e.target.value)}
                          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                        >
                          <option value="">Select a template...</option>
                          {CONTRACT_TEMPLATES.map(t => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                          ))}
                        </select>
                      </div>

                      {documentContent && (
                        showPreview ? (
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
                              <label className="block text-sm font-medium text-gray-700">Content</label>
                              <button
                                type="button"
                                onClick={() => setShowPreview(true)}
                                className="text-xs font-medium text-brand hover:underline"
                              >
                                Preview
                              </button>
                            </div>
                            <textarea
                              value={documentContent}
                              onChange={e => setDocumentContent(e.target.value)}
                              rows={10}
                              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                            />
                          </div>
                        )
                      )}
                    </>
                  )}

                  {/* Write content tab */}
                  {docTab === 'write' && (
                    <div>
                      <div className="mb-1 flex items-center justify-between">
                        <label className="block text-sm font-medium text-gray-700">Document Content</label>
                        {documentContent && (
                          <button
                            type="button"
                            onClick={() => setShowPreview(!showPreview)}
                            className="text-xs font-medium text-brand hover:underline"
                          >
                            {showPreview ? 'Edit' : 'Preview'}
                          </button>
                        )}
                      </div>
                      {showPreview && documentContent ? (
                        <div className="max-h-64 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-4">
                          <pre className="whitespace-pre-wrap font-sans text-sm text-gray-700">
                            {fillTemplatePlaceholders(documentContent, {
                              business_name: business.name,
                              signer_name: signerName || '{{signer_name}}',
                            })}
                          </pre>
                        </div>
                      ) : (
                        <>
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
                        </>
                      )}
                    </div>
                  )}

                  {/* Upload file tab */}
                  {docTab === 'upload' && (
                    <div>
                      {uploadedFileUrl ? (
                        <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                          <div className="flex items-center gap-3">
                            <svg className="h-8 w-8 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            <div>
                              <p className="text-sm font-medium text-gray-900">{uploadedFileName}</p>
                              <p className="text-xs text-green-600">Uploaded successfully</p>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={removeUploadedFile}
                            className="text-gray-400 hover:text-red-500"
                          >
                            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      ) : (
                        <div
                          onClick={() => !uploading && fileInputRef.current?.click()}
                          className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-8 text-center transition ${
                            uploading
                              ? 'border-gray-200 bg-gray-50'
                              : 'border-gray-300 hover:border-brand hover:bg-gray-50'
                          }`}
                        >
                          {uploading ? (
                            <>
                              <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-brand" />
                              <p className="mt-3 text-sm text-gray-500">Uploading...</p>
                            </>
                          ) : (
                            <>
                              <svg className="h-10 w-10 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                              </svg>
                              <p className="mt-2 text-sm font-medium text-gray-700">Click to upload a document</p>
                              <p className="mt-1 text-xs text-gray-400">PDF, PNG, JPG up to 10MB</p>
                            </>
                          )}
                        </div>
                      )}

                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".pdf,.png,.jpg,.jpeg"
                        onChange={handleFileUpload}
                        className="hidden"
                      />

                      {uploadError && (
                        <p className="mt-2 text-sm text-red-600">{uploadError}</p>
                      )}
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
                      disabled={!canProceed}
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
                    <label className="mb-1 block text-sm font-medium text-gray-700">Signer Phone *</label>
                    <PhoneInput
                      value={signerPhone}
                      onChange={setSignerPhone}
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

      {/* Edit Modal */}
      {editingContract && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40">
          <div className="mx-4 w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold text-gray-900">Edit Document</h2>
              <button
                onClick={() => setEditingContract(null)}
                className="text-gray-400 hover:text-gray-600"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Document Title *</label>
                <input
                  type="text"
                  value={editTitle}
                  onChange={e => setEditTitle(e.target.value)}
                  required
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Signer Phone *</label>
                <PhoneInput
                  value={editSignerPhone}
                  onChange={setEditSignerPhone}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Signer Name</label>
                <input
                  type="text"
                  value={editSignerName}
                  onChange={e => setEditSignerName(e.target.value)}
                  placeholder="e.g. John Doe"
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Signer Email</label>
                <input
                  type="email"
                  value={editSignerEmail}
                  onChange={e => setEditSignerEmail(e.target.value)}
                  placeholder="e.g. john@example.com"
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingContract(null)}
                  className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || !editTitle || !editSignerPhone}
                  className="flex-1 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

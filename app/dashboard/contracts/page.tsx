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
  signer_email: string | null;
  decline_reason: string | null;
  declined_at: string | null;
  require_otp: boolean;
  signing_mode: string;
  wa_delivery_status: string | null;
  contract_signers?: { id: string; signer_name: string | null; signer_phone: string; status: string; signed_at: string | null; wa_delivery_status: string | null }[];
}

interface CustomTemplate {
  id: string;
  title: string;
  content: string | null;
  template_url: string | null;
  category: string;
}

type DocTab = 'template' | 'write' | 'upload';

export default function ContractsPage() {
  const business = useBusiness();
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [sending, setSending] = useState(false);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState('');
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
  const [requireOtp, setRequireOtp] = useState(false);

  // Multi-signer state
  const [additionalSigners, setAdditionalSigners] = useState<{ name: string; phone: string; email: string }[]>([]);
  const [signingMode, setSigningMode] = useState<'parallel' | 'sequential'>('parallel');

  // CC recipients
  const [ccRecipients, setCcRecipients] = useState<{ phone: string }[]>([]);

  // Custom templates
  const [customTemplates, setCustomTemplates] = useState<CustomTemplate[]>([]);
  const [savingTemplate, setSavingTemplate] = useState(false);

  const supabase = createClient();

  const loadContracts = useCallback(async () => {
    const { data } = await supabase
      .from('contracts')
      .select('id, title, signer_name, signer_phone, signer_email, status, signed_at, created_at, token_expires_at, document_content, signed_url, audit_trail, signature_data, template_url, decline_reason, declined_at, require_otp, signing_mode, wa_delivery_status, contract_signers(id, signer_name, signer_phone, status, signed_at, wa_delivery_status)')
      .eq('business_id', business.id)
      .order('created_at', { ascending: false });

    setContracts(data || []);
    setLoading(false);
  }, [business.id, supabase]);

  const loadCustomTemplates = useCallback(async () => {
    try {
      const res = await fetch(`/api/contracts/templates?business_id=${business.id}`);
      if (res.ok) {
        const data = await res.json();
        setCustomTemplates(data.templates || []);
      }
    } catch {
      // Silent fail — custom templates are supplementary
    }
  }, [business.id]);

  useEffect(() => {
    loadContracts();
    loadCustomTemplates();
  }, [loadContracts, loadCustomTemplates]);

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
    setRequireOtp(false);
    setAdditionalSigners([]);
    setSigningMode('parallel');
    setCcRecipients([]);
  }

  function handleTemplateChange(templateId: string) {
    setSelectedTemplate(templateId);
    if (templateId) {
      // Check custom templates first
      const custom = customTemplates.find(t => t.id === templateId);
      if (custom) {
        setTitle(custom.title);
        setDocumentContent(custom.content || '');
        return;
      }
      // Then built-in templates
      const tmpl = CONTRACT_TEMPLATES.find(t => t.id === templateId);
      if (tmpl) {
        setTitle(tmpl.name);
        setDocumentContent(tmpl.content);
      }
    }
  }

  async function handleSaveAsTemplate() {
    if (!title && !documentContent) return;
    setSavingTemplate(true);
    try {
      const res = await fetch('/api/contracts/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: business.id,
          title: title || 'Untitled Template',
          content: documentContent || null,
        }),
      });
      if (res.ok) {
        setToastMsg('Saved as template');
        setTimeout(() => setToastMsg(''), 3000);
        await loadCustomTemplates();
      }
    } catch {
      console.error('Failed to save template');
    } finally {
      setSavingTemplate(false);
    }
  }

  async function handleDeleteCustomTemplate(templateId: string) {
    try {
      const res = await fetch(`/api/contracts/templates?id=${templateId}`, { method: 'DELETE' });
      if (res.ok) {
        setToastMsg('Template deleted');
        setTimeout(() => setToastMsg(''), 3000);
        await loadCustomTemplates();
      }
    } catch {
      console.error('Failed to delete template');
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

    // Build signers list if multi-signer
    const allSigners = [
      { name: signerName || undefined, phone: signerPhone, email: signerEmail || undefined },
      ...additionalSigners.filter(s => s.phone).map(s => ({
        name: s.name || undefined,
        phone: s.phone,
        email: s.email || undefined,
      })),
    ];

    const isMulti = allSigners.length > 1;

    try {
      const res = await fetch('/api/contracts/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: business.id,
          title,
          ...(isMulti
            ? { signers: allSigners, signing_mode: signingMode }
            : { signer_phone: signerPhone, signer_name: signerName || undefined, signer_email: signerEmail || undefined }
          ),
          document_content: finalContent,
          template_url: uploadedFileUrl || undefined,
          require_otp: requireOtp || undefined,
          cc_recipients: ccRecipients.filter(cc => cc.phone) || undefined,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setShowModal(false);
        resetForm();
        await loadContracts();
        if (data.message_delivered === false || data.messages_delivered === 0) {
          setToastMsg('Contract created but WhatsApp message could not be delivered. Share the signing link manually.');
          setTimeout(() => setToastMsg(''), 6000);
        }
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
      const res = await fetch('/api/contracts/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contract_id: contractId }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.message_delivered === false) {
          setToastMsg('Link regenerated but WhatsApp message could not be delivered. Share the link manually.');
          setTimeout(() => setToastMsg(''), 6000);
        } else {
          setToastMsg('Signing link re-sent via WhatsApp');
          setTimeout(() => setToastMsg(''), 3000);
        }
      }
      await loadContracts();
    } catch (err) {
      console.error('Failed to resend:', err);
    } finally {
      setResendingId(null);
    }
  }

  async function handleRevoke(contractId: string) {
    setRevokingId(contractId);
    try {
      const res = await fetch('/api/contracts/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contract_id: contractId }),
      });
      if (res.ok) {
        await loadContracts();
      }
    } catch (err) {
      console.error('Failed to revoke:', err);
    } finally {
      setRevokingId(null);
      setConfirmRevokeId(null);
    }
  }

  function openEditModal(c: Contract) {
    setEditingContract(c);
    setEditTitle(c.title);
    setEditSignerName(c.signer_name || '');
    setEditSignerPhone(c.signer_phone || '');
    setEditSignerEmail(c.signer_email || '');
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

  function getDeliveryIndicator(waStatus: string | null) {
    if (!waStatus || waStatus === 'sent') {
      return <span className="text-gray-400" title="Sent">&#10003;</span>;
    }
    if (waStatus === 'delivered') {
      return <span className="text-gray-400" title="Delivered">&#10003;&#10003;</span>;
    }
    if (waStatus === 'read') {
      return <span className="text-blue-500" title="Read">&#10003;&#10003;</span>;
    }
    return null;
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
      case 'declined':
        return <span className="inline-flex items-center rounded-full bg-orange-100 px-2.5 py-0.5 text-xs font-medium text-orange-700">Declined</span>;
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

      {/* Stats Cards */}
      {!loading && contracts.length > 0 && (() => {
        const total = contracts.length;
        const pending = contracts.filter(c => c.status === 'pending').length;
        const signed = contracts.filter(c => c.status === 'signed').length;
        const expired = contracts.filter(c => c.status === 'expired').length;
        const stats = [
          { label: 'Total', value: total, color: 'bg-blue-50 text-blue-700' },
          { label: 'Pending', value: pending, color: 'bg-yellow-50 text-yellow-700' },
          { label: 'Signed', value: signed, color: 'bg-green-50 text-green-700' },
          { label: 'Expired', value: expired, color: 'bg-gray-50 text-gray-600' },
        ];
        return (
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {stats.map(s => (
              <div key={s.label} className={`rounded-xl border border-gray-200 p-4 ${s.color}`}>
                <p className="text-2xl font-bold">{s.value}</p>
                <p className="text-xs font-medium opacity-70">{s.label}</p>
              </div>
            ))}
          </div>
        );
      })()}

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
                    {c.contract_signers && c.contract_signers.length > 0 ? (
                      <>
                        <p className="text-sm text-gray-700">{c.contract_signers.length} signers</p>
                        <p className="flex items-center gap-1 text-xs text-gray-400">
                          {c.contract_signers.filter(s => s.status === 'signed').length}/{c.contract_signers.length} signed
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="flex items-center gap-1.5 text-sm text-gray-700">
                          {c.signer_name || '\u2014'}
                          {c.status === 'pending' && getDeliveryIndicator(c.wa_delivery_status)}
                        </p>
                        <p className="text-xs text-gray-400">{c.signer_phone}</p>
                      </>
                    )}
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
                      {c.status === 'pending' && (
                        <button
                          onClick={() => setConfirmRevokeId(c.id)}
                          disabled={revokingId === c.id}
                          className="text-sm font-medium text-red-600 hover:underline disabled:opacity-50"
                        >
                          {revokingId === c.id ? 'Voiding...' : 'Void'}
                        </button>
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

            {/* Save as Template (detail modal) */}
            {selectedContract.document_content && (
              <div className="mb-4">
                <button
                  onClick={async () => {
                    setSavingTemplate(true);
                    try {
                      const res = await fetch('/api/contracts/templates', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          business_id: business.id,
                          title: selectedContract.title,
                          content: selectedContract.document_content,
                        }),
                      });
                      if (res.ok) {
                        setToastMsg('Saved as template');
                        setTimeout(() => setToastMsg(''), 3000);
                        await loadCustomTemplates();
                      }
                    } catch { /* ignore */ } finally {
                      setSavingTemplate(false);
                    }
                  }}
                  disabled={savingTemplate}
                  className="text-xs font-medium text-brand hover:underline disabled:opacity-50"
                >
                  {savingTemplate ? 'Saving...' : 'Save as Template'}
                </button>
              </div>
            )}

            {/* Multi-signer list */}
            {selectedContract.contract_signers && selectedContract.contract_signers.length > 0 && (
              <div className="mb-4">
                <p className="mb-2 text-xs font-medium text-gray-500">Signers</p>
                <div className="space-y-1.5">
                  {selectedContract.contract_signers.map(s => (
                    <div key={s.id} className="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div>
                          <p className="text-sm font-medium text-gray-700">{s.signer_name || 'No name'}</p>
                          <p className="text-xs text-gray-400">{s.signer_phone}</p>
                        </div>
                        {s.status === 'pending' && getDeliveryIndicator(s.wa_delivery_status)}
                      </div>
                      {getStatusBadge(s.status)}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Decline info */}
            {selectedContract.status === 'declined' && (
              <div className="mb-4 rounded-lg border border-orange-200 bg-orange-50 p-3">
                <p className="text-sm font-medium text-orange-700">
                  Declined{selectedContract.declined_at ? ` on ${new Date(selectedContract.declined_at).toLocaleDateString()}` : ''}
                </p>
                {selectedContract.decline_reason && (
                  <p className="mt-1 text-sm text-orange-600">Reason: {selectedContract.decline_reason}</p>
                )}
              </div>
            )}

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
                          {customTemplates.length > 0 && (
                            <optgroup label="My Templates">
                              {customTemplates.map(t => (
                                <option key={t.id} value={t.id}>{t.title}</option>
                              ))}
                            </optgroup>
                          )}
                          <optgroup label="Built-in">
                            {CONTRACT_TEMPLATES.map(t => (
                              <option key={t.id} value={t.id}>{t.name}</option>
                            ))}
                          </optgroup>
                        </select>
                        {/* Delete custom template button */}
                        {selectedTemplate && customTemplates.some(t => t.id === selectedTemplate) && (
                          <button
                            type="button"
                            onClick={() => { handleDeleteCustomTemplate(selectedTemplate); setSelectedTemplate(''); setDocumentContent(''); setTitle(''); }}
                            className="mt-1 text-xs text-red-500 hover:underline"
                          >
                            Delete this template
                          </button>
                        )}
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

                  {/* Save as Template */}
                  {(documentContent || uploadedFileUrl) && title && (
                    <button
                      type="button"
                      onClick={handleSaveAsTemplate}
                      disabled={savingTemplate}
                      className="w-full rounded-lg border border-dashed border-gray-300 px-3 py-2 text-sm font-medium text-gray-500 transition hover:border-brand hover:text-brand disabled:opacity-50"
                    >
                      {savingTemplate ? 'Saving...' : 'Save as Template'}
                    </button>
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

                  {/* Additional Signers */}
                  {additionalSigners.map((s, i) => (
                    <div key={i} className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-medium text-gray-500">Signer {i + 2}</p>
                        <button
                          type="button"
                          onClick={() => setAdditionalSigners(prev => prev.filter((_, j) => j !== i))}
                          className="text-xs text-red-500 hover:underline"
                        >
                          Remove
                        </button>
                      </div>
                      <PhoneInput
                        value={s.phone}
                        onChange={val => setAdditionalSigners(prev => prev.map((x, j) => j === i ? { ...x, phone: val } : x))}
                      />
                      <input
                        type="text"
                        value={s.name}
                        onChange={e => setAdditionalSigners(prev => prev.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                        placeholder="Name"
                        className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                      />
                    </div>
                  ))}

                  <button
                    type="button"
                    onClick={() => setAdditionalSigners(prev => [...prev, { name: '', phone: '', email: '' }])}
                    className="w-full rounded-lg border border-dashed border-gray-300 px-3 py-2 text-sm font-medium text-gray-500 transition hover:border-brand hover:text-brand"
                  >
                    + Add Another Signer
                  </button>

                  {/* Signing mode (only if multiple signers) */}
                  {additionalSigners.length > 0 && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Signing Order</label>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setSigningMode('parallel')}
                          className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition ${
                            signingMode === 'parallel' ? 'border-brand bg-brand/5 text-brand' : 'border-gray-200 text-gray-600'
                          }`}
                        >
                          All at once
                        </button>
                        <button
                          type="button"
                          onClick={() => setSigningMode('sequential')}
                          className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition ${
                            signingMode === 'sequential' ? 'border-brand bg-brand/5 text-brand' : 'border-gray-200 text-gray-600'
                          }`}
                        >
                          In order
                        </button>
                      </div>
                    </div>
                  )}

                  {/* OTP toggle */}
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={requireOtp}
                      onChange={e => setRequireOtp(e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                    />
                    <div>
                      <p className="text-sm font-medium text-gray-700">Require OTP Verification</p>
                      <p className="text-xs text-gray-400">Signer must verify via WhatsApp code before signing</p>
                    </div>
                  </label>

                  {/* CC Recipients */}
                  {ccRecipients.map((cc, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <div className="flex-1">
                        <PhoneInput
                          value={cc.phone}
                          onChange={val => setCcRecipients(prev => prev.map((x, j) => j === i ? { ...x, phone: val } : x))}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setCcRecipients(prev => prev.filter((_, j) => j !== i))}
                        className="text-xs text-red-500 hover:underline"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => setCcRecipients(prev => [...prev, { phone: '' }])}
                    className="text-xs font-medium text-gray-500 hover:text-brand"
                  >
                    + Add CC Recipient
                  </button>

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

      {/* Revoke Confirmation Dialog */}
      {confirmRevokeId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="mx-4 w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
            <h2 className="text-lg font-bold text-gray-900">Void Document?</h2>
            <p className="mt-2 text-sm text-gray-600">
              This will cancel the signing link and notify the signer. This action cannot be undone.
            </p>
            <div className="mt-5 flex gap-3">
              <button
                onClick={() => setConfirmRevokeId(null)}
                className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => handleRevoke(confirmRevokeId)}
                disabled={!!revokingId}
                className="flex-1 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
              >
                {revokingId ? 'Voiding...' : 'Void Document'}
              </button>
            </div>
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

      {/* Toast */}
      {toastMsg && (
        <div className="fixed bottom-6 left-1/2 z-[100] -translate-x-1/2 rounded-lg bg-gray-900 px-5 py-3 text-sm text-white shadow-lg">
          {toastMsg}
        </div>
      )}
    </div>
  );
}

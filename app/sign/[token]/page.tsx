'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { ReturnToWhatsApp } from '@/components/ReturnToWhatsApp';

interface ContractInfo {
  id: string;
  title: string;
  signer_name: string | null;
  business_name: string;
  status: string;
  expires_at: string;
  document_content: string | null;
  template_url: string | null;
  signed_at?: string;
  has_pdf?: boolean;
  require_otp?: boolean;
  otp_verified?: boolean;
  logo_url?: string | null;
}

type PageState = 'loading' | 'otp_required' | 'otp_verifying' | 'ready' | 'signing' | 'submitting' | 'success' | 'already_signed' | 'declined' | 'error';

export default function SignPage() {
  const params = useParams();
  const token = params.token as string;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [contract, setContract] = useState<ContractInfo | null>(null);
  const [state, setState] = useState<PageState>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasDrawn, setHasDrawn] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [hasPdf, setHasPdf] = useState(false);

  // Decline state
  const [showDeclineModal, setShowDeclineModal] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [declining, setDeclining] = useState(false);

  // OTP state
  const [otpCode, setOtpCode] = useState('');
  const [otpSending, setOtpSending] = useState(false);
  const [otpError, setOtpError] = useState('');

  // Document display state
  const [docBlobUrl, setDocBlobUrl] = useState<string | null>(null);
  const [pdfPages, setPdfPages] = useState<string[]>([]);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState('');

  // Fetch contract details
  useEffect(() => {
    async function fetchContract() {
      try {
        const res = await fetch(`/api/contracts/${token}`);
        if (!res.ok) {
          const data = await res.json();
          setErrorMsg(data.error || 'Unable to load document');
          setState('error');
          return;
        }
        const data = await res.json();
        setContract(data);

        // If already signed, show the signed view
        if (data.status === 'signed') {
          setHasPdf(data.has_pdf === true);
          setState('already_signed');
          return;
        }

        // If no document content and no uploaded file, auto-agree (backwards compatible)
        if (!data.document_content && !data.template_url) {
          setAgreed(true);
        }

        // Check if OTP is required and not yet verified — auto-send OTP
        if (data.require_otp && !data.otp_verified) {
          setState('otp_required');
          // Auto-send OTP code
          fetch('/api/contracts/otp/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token }),
          }).catch(() => {});
          return;
        }

        setState('ready');
      } catch {
        setErrorMsg('Unable to load document. Please check your link.');
        setState('error');
      }
    }
    if (token) fetchContract();
  }, [token]);

  // Load uploaded document for inline display
  const loadDocument = useCallback(async () => {
    if (!contract?.template_url || !contract.id) return;

    setDocLoading(true);
    setDocError('');

    const url = `/api/contracts/document/${contract.id}?token=${token}`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        setDocError('Could not load document');
        setDocLoading(false);
        return;
      }

      const contentType = res.headers.get('content-type') || '';
      const blob = await res.blob();

      if (contentType.startsWith('image/')) {
        // Images: create blob URL and display directly
        setDocBlobUrl(URL.createObjectURL(blob));
        setDocLoading(false);
      } else if (contentType === 'application/pdf') {
        // PDFs: render pages using pdf.js
        await renderPdfPages(blob);
        setDocLoading(false);
      } else {
        // Fallback: download link
        setDocBlobUrl(URL.createObjectURL(blob));
        setDocLoading(false);
      }
    } catch {
      setDocError('Failed to load document');
      setDocLoading(false);
    }
  }, [contract?.template_url, contract?.id, token]);

  useEffect(() => {
    if (contract?.template_url) {
      loadDocument();
    }
    // Cleanup blob URLs on unmount
    return () => {
      if (docBlobUrl) URL.revokeObjectURL(docBlobUrl);
    };
  }, [contract?.template_url, loadDocument]);

  async function renderPdfPages(blob: Blob) {
    try {
      // Load pdf.js from CDN
      const pdfjsLib = await import('pdfjs-dist');
      pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

      const arrayBuffer = await blob.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
      const pages: string[] = [];

      // Render each page sequentially
      const totalPages = pdf.numPages;
      for (let i = 1; i <= totalPages; i++) {
        try {
          const page = await pdf.getPage(i);
          // Use scale 2 for desktops, 1.2 for mobile to avoid memory issues
          const isMobile = window.innerWidth < 768;
          const scale = isMobile ? 1.2 : 2;
          const viewport = page.getViewport({ scale });

          const offscreen = document.createElement('canvas');
          offscreen.width = viewport.width;
          offscreen.height = viewport.height;
          const ctx = offscreen.getContext('2d');
          if (!ctx) continue;

          const renderTask = page.render({ canvasContext: ctx, viewport } as any);
          await renderTask.promise;

          pages.push(offscreen.toDataURL('image/jpeg', 0.92));

          // Clean up to free memory
          page.cleanup();
        } catch (pageErr) {
          console.warn(`Failed to render page ${i}:`, pageErr);
        }
      }

      if (pages.length > 0) {
        setPdfPages(pages);
      } else {
        // No pages rendered, fallback
        setDocBlobUrl(URL.createObjectURL(blob));
      }
    } catch (err) {
      console.error('PDF render error:', err);
      setDocBlobUrl(URL.createObjectURL(blob));
    }
  }

  // Initialize signature canvas
  useEffect(() => {
    if (state !== 'ready' && state !== 'signing') return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * 2;
    canvas.height = rect.height * 2;
    ctx.scale(2, 2);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, [state]);

  function getPoint(e: React.TouchEvent | React.MouseEvent) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    if ('touches' in e) {
      const touch = e.touches[0];
      return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
    }
    return { x: (e as React.MouseEvent).clientX - rect.left, y: (e as React.MouseEvent).clientY - rect.top };
  }

  function startDraw(e: React.TouchEvent | React.MouseEvent) {
    e.preventDefault();
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    setIsDrawing(true);
    setHasDrawn(true);
    setState('signing');
    const point = getPoint(e);
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
  }

  function draw(e: React.TouchEvent | React.MouseEvent) {
    e.preventDefault();
    if (!isDrawing) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const point = getPoint(e);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
  }

  function endDraw(e: React.TouchEvent | React.MouseEvent) {
    e.preventDefault();
    setIsDrawing(false);
  }

  function clearCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasDrawn(false);
    setState('ready');
  }

  async function handleDecline() {
    setDeclining(true);
    try {
      const res = await fetch('/api/contracts/decline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, reason: declineReason || undefined }),
      });
      if (res.ok) {
        setShowDeclineModal(false);
        setState('declined');
      } else {
        const data = await res.json();
        setErrorMsg(data.error || 'Failed to decline');
        setState('error');
      }
    } catch {
      setErrorMsg('Failed to decline. Please try again.');
      setState('error');
    } finally {
      setDeclining(false);
    }
  }

  async function sendOtp() {
    setOtpSending(true);
    setOtpError('');
    try {
      const res = await fetch('/api/contracts/otp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        const data = await res.json();
        setOtpError(data.error || 'Failed to send code');
      }
    } catch {
      setOtpError('Failed to send code');
    } finally {
      setOtpSending(false);
    }
  }

  async function verifyOtp() {
    setState('otp_verifying');
    setOtpError('');
    try {
      const res = await fetch('/api/contracts/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, otp: otpCode }),
      });
      if (res.ok) {
        setState('ready');
      } else {
        const data = await res.json();
        setOtpError(data.error || 'Verification failed');
        setState('otp_required');
      }
    } catch {
      setOtpError('Verification failed');
      setState('otp_required');
    }
  }

  async function submitSignature() {
    const canvas = canvasRef.current;
    if (!canvas) return;

    setState('submitting');
    const signatureData = canvas.toDataURL('image/png');

    try {
      const res = await fetch('/api/contracts/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, signature_data: signatureData }),
      });

      if (!res.ok) {
        const data = await res.json();
        setErrorMsg(data.error || 'Failed to submit signature');
        setState('error');
        return;
      }

      const data = await res.json();
      setHasPdf(data.has_pdf === true);
      setState('success');
    } catch {
      setErrorMsg('Failed to submit. Please try again.');
      setState('signing');
    }
  }

  if (state === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-gray-200 border-t-blue-600" />
          <p className="mt-4 text-gray-500">Loading document...</p>
        </div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
            <svg className="h-8 w-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-900">Unable to Sign</h1>
          <p className="mt-2 text-gray-600">{errorMsg}</p>
        </div>
      </div>
    );
  }

  if (state === 'already_signed') {
    const signedDate = contract?.signed_at
      ? new Date(contract.signed_at).toLocaleDateString('en-US', {
          year: 'numeric', month: 'long', day: 'numeric',
          hour: '2-digit', minute: '2-digit',
        })
      : null;

    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-blue-100">
            <svg className="h-8 w-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-900">Document Already Signed</h1>
          <p className="mt-2 text-gray-600">
            &quot;{contract?.title}&quot; was signed
            {contract?.signer_name && <> by <span className="font-medium">{contract.signer_name}</span></>}
            {signedDate && <> on {signedDate}</>}.
          </p>

          {hasPdf && contract && (
            <a
              href={`/api/contracts/pdf/${contract.id}?token=${token}`}
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-medium text-white transition hover:bg-blue-700"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Download Signed Copy
            </a>
          )}

          <ReturnToWhatsApp />
          <p className="mt-4 text-xs text-gray-400">Powered by Waaiio</p>
        </div>
      </div>
    );
  }

  if (state === 'declined') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-orange-100">
            <svg className="h-8 w-8 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-900">Document Declined</h1>
          <p className="mt-2 text-gray-600">
            You have declined to sign &quot;{contract?.title}&quot;. The sender has been notified.
          </p>
          <ReturnToWhatsApp />
          <p className="mt-4 text-xs text-gray-400">Powered by Waaiio</p>
        </div>
      </div>
    );
  }

  if (state === 'otp_required' || state === 'otp_verifying') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6">
        <div className="w-full max-w-sm">
          <div className="rounded-xl bg-white p-6 shadow-lg">
            <div className="mb-4 text-center">
              <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-blue-100">
                <svg className="h-7 w-7 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <h1 className="text-lg font-bold text-gray-900">Verify Your Identity</h1>
              <p className="mt-1 text-sm text-gray-500">
                Enter the 6-digit code sent to your WhatsApp to continue signing &quot;{contract?.title}&quot;.
              </p>
            </div>

            <div className="space-y-4">
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={otpCode}
                onChange={e => setOtpCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-center text-2xl font-bold tracking-[0.5em] focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />

              {otpError && (
                <p className="text-center text-sm text-red-600">{otpError}</p>
              )}

              <button
                onClick={verifyOtp}
                disabled={otpCode.length !== 6 || state === 'otp_verifying'}
                className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
              >
                {state === 'otp_verifying' ? 'Verifying...' : 'Verify'}
              </button>

              <button
                onClick={sendOtp}
                disabled={otpSending}
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
              >
                {otpSending ? 'Sending...' : 'Resend Code'}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (state === 'success') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
            <svg className="h-8 w-8 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-900">Document Signed!</h1>
          <p className="mt-2 text-gray-600">
            Your signature for &quot;{contract?.title}&quot; has been recorded successfully.
          </p>

          {hasPdf && contract && (
            <a
              href={`/api/contracts/pdf/${contract.id}?token=${token}`}
              className="mt-4 inline-block rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-medium text-white transition hover:bg-blue-700"
            >
              Download Signed Copy
            </a>
          )}

          <ReturnToWhatsApp />
          <p className="mt-4 text-xs text-gray-400">Powered by Waaiio</p>
        </div>
      </div>
    );
  }

  const hasContent = !!(contract?.document_content || contract?.template_url);
  const documentApiUrl = contract?.template_url
    ? `/api/contracts/document/${contract.id}?token=${token}`
    : null;

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      {/* Header */}
      <header className="border-b bg-white px-4 py-4 shadow-sm">
        <div className="mx-auto max-w-lg">
          <div className="flex items-center gap-3">
            {contract?.logo_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={contract.logo_url}
                alt={contract.business_name}
                className="h-10 w-10 rounded-lg object-contain"
              />
            )}
            <p className="text-xs font-medium uppercase tracking-wider text-gray-400">
              {contract?.business_name}
            </p>
          </div>
          <h1 className="mt-1 text-lg font-bold text-gray-900">{contract?.title}</h1>
          {contract?.signer_name && (
            <p className="mt-1 text-sm text-gray-500">
              Signing as: <span className="font-medium text-gray-700">{contract.signer_name}</span>
            </p>
          )}
        </div>
      </header>

      {/* Main content */}
      <main className="flex flex-1 flex-col items-center px-4 py-6">
        <div className="w-full max-w-lg pb-24 md:pb-0">

          {/* Uploaded Document Section */}
          {contract?.template_url && (
            <div className="mb-6">
              <h2 className="mb-2 text-sm font-semibold text-gray-700">Document to Review</h2>

              {docLoading && (
                <div className="flex items-center justify-center rounded-xl border border-gray-200 bg-white py-16 shadow-sm">
                  <div className="text-center">
                    <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-blue-600" />
                    <p className="mt-3 text-sm text-gray-500">Loading document...</p>
                  </div>
                </div>
              )}

              {docError && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-center">
                  <p className="text-sm text-red-600">{docError}</p>
                  {documentApiUrl && (
                    <a
                      href={documentApiUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-block text-sm font-medium text-blue-600 hover:underline"
                    >
                      Open document in new tab
                    </a>
                  )}
                </div>
              )}

              {/* Rendered PDF pages */}
              {pdfPages.length > 0 && (
                <div className="space-y-2 rounded-xl border border-gray-200 bg-white p-2 shadow-sm">
                  {pdfPages.map((pageDataUrl, i) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={i}
                      src={pageDataUrl}
                      alt={`Page ${i + 1}`}
                      className="w-full rounded border border-gray-100"
                    />
                  ))}
                </div>
              )}

              {/* Image display */}
              {docBlobUrl && pdfPages.length === 0 && !docLoading && (
                <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={docBlobUrl}
                    alt="Document"
                    className="w-full"
                  />
                </div>
              )}

              {/* Download link */}
              {documentApiUrl && !docLoading && !docError && (
                <a
                  href={documentApiUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:underline"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Download document
                </a>
              )}
            </div>
          )}

          {/* Document Content Section (text-based) */}
          {contract?.document_content && (
            <div className="mb-6">
              {!contract.template_url && (
                <h2 className="mb-2 text-sm font-semibold text-gray-700">Document to Review</h2>
              )}
              <div className="max-h-80 overflow-y-auto rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-gray-700">
                  {contract.document_content}
                </pre>
              </div>
            </div>
          )}

          {/* Agreement checkbox */}
          {hasContent && (
            <label className="mb-6 flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={agreed}
                onChange={e => setAgreed(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-gray-600">
                I have read and agree to the above document
              </span>
            </label>
          )}

          {/* Legal disclaimer */}
          <div className="mb-6 rounded-lg bg-gray-100 p-4">
            <p className="text-xs leading-relaxed text-gray-500">
              Waaiio provides e-signature technology as a service. Waaiio is not a law firm and does not provide legal advice. This platform facilitates electronic document signing in accordance with applicable e-signature laws (ESIGN Act, UETA, eIDAS). By using this service, you acknowledge that you have reviewed the document and are signing voluntarily. For legal questions about this document, consult a qualified attorney.
            </p>
            <p className="mt-2 text-xs leading-relaxed text-gray-500">
              Your signature, IP address, and device information are recorded for verification purposes. See our{' '}
              <a href="/privacy" className="font-medium text-blue-600 hover:underline">Privacy Policy</a>.
            </p>
          </div>

          {/* Signature area */}
          <p className="mb-3 text-center text-sm text-gray-500">
            Draw your signature below using your finger or mouse
          </p>

          <div className="overflow-hidden rounded-xl border-2 border-dashed border-gray-300 bg-white">
            <canvas
              ref={canvasRef}
              className="h-56 md:h-48 w-full cursor-crosshair"
              style={{ touchAction: 'none' }}
              onMouseDown={startDraw}
              onMouseMove={draw}
              onMouseUp={endDraw}
              onMouseLeave={endDraw}
              onTouchStart={startDraw}
              onTouchMove={draw}
              onTouchEnd={endDraw}
            />
          </div>

          {!hasDrawn && (
            <p className="mt-2 text-center text-xs text-gray-400">
              Tap and drag to sign
            </p>
          )}

          {/* Legal note (above sticky footer on mobile) */}
          <p className="mt-6 text-center text-xs text-gray-400">
            By signing, you agree that this electronic signature is as valid as a handwritten signature.
          </p>
        </div>
      </main>

      {/* Scroll-to-sign indicator on mobile */}
      {!hasDrawn && (
        <div className="fixed bottom-20 left-1/2 z-10 -translate-x-1/2 rounded-full bg-brand px-4 py-2 text-xs text-white shadow-lg md:hidden animate-bounce">
          ↓ Scroll down to sign
        </div>
      )}

      {/* Sticky footer buttons on mobile, inline on desktop */}
      <div className="fixed bottom-0 left-0 right-0 z-10 border-t border-gray-200 bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:relative md:border-0 md:p-0 md:pb-0">
        <div className="mx-auto max-w-lg">
          <div className="flex gap-3">
            <button
              onClick={clearCanvas}
              disabled={!hasDrawn || state === 'submitting'}
              className="flex-1 rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
            >
              Clear
            </button>
            <button
              onClick={submitSignature}
              disabled={!hasDrawn || !agreed || state === 'submitting'}
              className="flex-1 rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
            >
              {state === 'submitting' ? 'Submitting...' : 'Submit Signature'}
            </button>
          </div>
          <div className="mt-2 text-center">
            <button
              onClick={() => setShowDeclineModal(true)}
              className="text-sm font-medium text-red-500 hover:text-red-600 hover:underline"
            >
              Decline to Sign
            </button>
          </div>
        </div>
      </div>

      {/* Decline Modal */}
      {showDeclineModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
            <h2 className="text-lg font-bold text-gray-900">Decline Document</h2>
            <p className="mt-1 text-sm text-gray-500">
              Are you sure you want to decline &quot;{contract?.title}&quot;? The sender will be notified.
            </p>
            <textarea
              value={declineReason}
              onChange={e => setDeclineReason(e.target.value)}
              placeholder="Reason for declining (optional)"
              rows={3}
              className="mt-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500"
            />
            <div className="mt-4 flex gap-3">
              <button
                onClick={() => setShowDeclineModal(false)}
                className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDecline}
                disabled={declining}
                className="flex-1 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
              >
                {declining ? 'Declining...' : 'Confirm Decline'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

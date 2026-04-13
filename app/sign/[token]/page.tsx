'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';

interface ContractInfo {
  id: string;
  title: string;
  signer_name: string | null;
  business_name: string;
  status: string;
  expires_at: string;
  document_content: string | null;
  template_url: string | null;
}

type PageState = 'loading' | 'ready' | 'signing' | 'submitting' | 'success' | 'error';

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
        // If no document content and no uploaded file, auto-agree (backwards compatible)
        if (!data.document_content && !data.template_url) {
          setAgreed(true);
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

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

          <p className="mt-4 text-sm text-gray-400">You can close this page now.</p>
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
          <p className="text-xs font-medium uppercase tracking-wider text-gray-400">
            {contract?.business_name}
          </p>
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
        <div className="w-full max-w-lg">

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
                    alt="Contract document"
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

          {/* Signature area */}
          <p className="mb-3 text-center text-sm text-gray-500">
            Draw your signature below using your finger or mouse
          </p>

          <div className="overflow-hidden rounded-xl border-2 border-dashed border-gray-300 bg-white">
            <canvas
              ref={canvasRef}
              className="h-48 w-full cursor-crosshair"
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

          {/* Buttons */}
          <div className="mt-6 flex gap-3">
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

          {/* Legal note */}
          <p className="mt-6 text-center text-xs text-gray-400">
            By signing, you agree that this electronic signature is as valid as a handwritten signature.
          </p>
        </div>
      </main>
    </div>
  );
}

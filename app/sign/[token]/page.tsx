'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';

interface ContractInfo {
  id: string;
  title: string;
  signer_name: string | null;
  business_name: string;
  status: string;
  expires_at: string;
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
        setState('ready');
      } catch {
        setErrorMsg('Unable to load document. Please check your link.');
        setState('error');
      }
    }
    if (token) fetchContract();
  }, [token]);

  // Initialize canvas
  useEffect(() => {
    if (state !== 'ready' && state !== 'signing') return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size for mobile
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
          <p className="mt-4 text-sm text-gray-400">You can close this page now.</p>
        </div>
      </div>
    );
  }

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

      {/* Signing area */}
      <main className="flex flex-1 flex-col items-center px-4 py-6">
        <div className="w-full max-w-lg">
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
              disabled={!hasDrawn || state === 'submitting'}
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

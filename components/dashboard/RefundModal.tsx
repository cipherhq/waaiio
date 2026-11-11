'use client';

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { loadTaxRefundLines, refundLineSelection, zeroValueReturnSelection, type RefundLineChoice } from '@/lib/tax/refund-ui';
import { formatCurrency, type CountryCode } from '@/lib/constants';

interface RefundModalProps {
  open: boolean;
  onClose: () => void;
  paymentId: string;
  paymentAmount: number;
  existingRefundAmount: number;
  currency: string;
  businessId: string;
  isDirectSplit: boolean;
  countryCode: CountryCode;
  onSuccess: () => void;
}

export function RefundModal({
  open,
  onClose,
  paymentId,
  paymentAmount,
  existingRefundAmount,
  currency,
  businessId,
  isDirectSplit,
  countryCode,
  onSuccess,
}: RefundModalProps) {
  const maxRefund = paymentAmount - existingRefundAmount;
  const [amount, setAmount] = useState(String(maxRefund));
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resultState, setResultState] = useState<
    | { type: 'success' }
    | { type: 'pending' }
    | { type: 'provider_pending' }
    | { type: 'provider_ambiguous' }
    | { type: 'provider_success_unfinalized' }
    | { type: 'failed'; message: string }
    | null
  >(null);

  const [taxLines,setTaxLines]=useState<RefundLineChoice[]|null>(null);
  const [taxLoading,setTaxLoading]=useState(true);
  const [taxReadError,setTaxReadError]=useState('');
  const [partialTax,setPartialTax]=useState(false);
  const [zeroReturn,setZeroReturn]=useState(false);
  const [lineAmounts,setLineAmounts]=useState<Record<string,string>>({});
  const requestRef=useRef<{key:string;id:string}|null>(null);
  useEffect(()=>{
    if(!open) return;
    let active=true;setTaxLoading(true);setTaxReadError('');setPartialTax(false);setZeroReturn(false);setLineAmounts({});requestRef.current=null;
    setAmount(String(paymentAmount-existingRefundAmount));setResultState(null);
    loadTaxRefundLines(createClient(),paymentId,businessId).then(lines=>{if(active)setTaxLines(lines);})
      .catch(()=>{if(active)setTaxReadError('Refund details could not be loaded. Close and try again.');})
      .finally(()=>{if(active)setTaxLoading(false);});
    return ()=>{active=false;};
  },[open,paymentId,businessId,paymentAmount,existingRefundAmount]);

  if (!open) return null;

  async function handleSubmit() {
    if(taxLoading||taxReadError)return;
    let refundAmount = taxLines&&!partialTax ? maxRefund : parseFloat(amount);
    let taxSelection:ReturnType<typeof refundLineSelection>['taxSelection']|undefined; let requestId:string|undefined;
    if(taxLines&&(partialTax||zeroReturn)){
      try { const selected=zeroReturn?zeroValueReturnSelection(taxLines,lineAmounts):refundLineSelection(taxLines,lineAmounts);refundAmount=selected.amount;taxSelection=selected.taxSelection; }
      catch(err){setError(err instanceof Error?err.message:'Select items to refund');return;}
      const key=JSON.stringify([paymentId,taxSelection,refundAmount,reason.trim()]);
      if(requestRef.current?.key!==key)requestRef.current={key,id:crypto.randomUUID()};
      requestId=requestRef.current.id;
    }
    if (isNaN(refundAmount) || refundAmount < 0 || (refundAmount === 0 && !zeroReturn)) {
      setError('Enter a valid amount');
      return;
    }
    if (refundAmount > maxRefund) {
      setError(`Maximum refundable: ${formatCurrency(maxRefund, countryCode)}`);
      return;
    }

    setLoading(true);
    setError('');
    setResultState(null);

    try {
      const res = await fetch('/api/payments/refund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentId,
          businessId,
          amount: refundAmount,
          reason: reason.trim() || undefined,
          ...(taxSelection?{taxSelection,requestId}:{}),
        }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        setResultState({ type: 'success' });
        onSuccess();
        return;
      }

      // Map the 6-state domain vocabulary to UI presentation
      const state = data.state as string | undefined;
      if (state === 'pending') {
        setResultState({ type: 'pending' });
      } else if (state === 'provider_pending') {
        setResultState({ type: 'provider_pending' });
      } else if (state === 'provider_ambiguous') {
        setResultState({ type: 'provider_ambiguous' });
      } else if (state === 'provider_success_unfinalized') {
        setResultState({ type: 'provider_success_unfinalized' });
      } else {
        setResultState({ type: 'failed', message: data.error || 'Refund failed' });
      }
    } catch {
      setResultState({ type: 'failed', message: 'Network error — please try again' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-labelledby="refund-modal-title" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 id="refund-modal-title" className="text-lg font-semibold text-gray-900">Issue Refund</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
            <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="mt-4 space-y-4">
          {/* Payment info */}
          <div className="rounded-lg bg-gray-50 p-3 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Payment Amount</span>
              <span className="font-medium text-gray-900">{formatCurrency(paymentAmount, countryCode)}</span>
            </div>
            {existingRefundAmount > 0 && (
              <div className="mt-1 flex justify-between">
                <span className="text-gray-500">Already Refunded</span>
                <span className="font-medium text-red-600">{formatCurrency(existingRefundAmount, countryCode)}</span>
              </div>
            )}
            <div className="mt-1 flex justify-between">
              <span className="text-gray-500">Refundable</span>
              <span className="font-medium text-gray-900">{formatCurrency(maxRefund, countryCode)}</span>
            </div>
          </div>

          {/* Direct split warning */}
          {isDirectSplit && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <p className="font-medium">Direct split payment</p>
              <p className="mt-0.5 text-amber-700">
                Please manually return the funds to the customer. This action records the refund in the system only.
              </p>
            </div>
          )}

          {taxReadError&&<p role="alert" className="text-sm text-red-600">{taxReadError}</p>}
          {taxLoading&&<p className="text-sm text-gray-500">Loading refundable items…</p>}
          {taxLines&&<fieldset className="space-y-2">
            <legend className="text-sm font-medium">Refund selection</legend>
            <label className="block text-sm"><input type="radio" checked={!partialTax&&!zeroReturn} onChange={()=>{setPartialTax(false);setZeroReturn(false);}}/> Full remaining payment</label>
            <label className="block text-sm"><input type="radio" checked={partialTax} onChange={()=>{setPartialTax(true);setZeroReturn(false);}}/> Choose item amounts</label>
            {taxLines.some(line=>line.zeroValue)&&<label className="block text-sm"><input type="radio" checked={zeroReturn} onChange={()=>{setPartialTax(false);setZeroReturn(true);}}/> Record a no-value item return</label>}
            {zeroReturn&&taxLines.filter(line=>line.zeroValue).map(line=><label key={line.id} className="block text-sm">{line.label} — no money refunded
              <input aria-label={`Return quantity for ${line.label}`} type="number" min="0" step="1" max={line.quantity}
                value={lineAmounts[line.id]||''} onChange={e=>setLineAmounts({...lineAmounts,[line.id]:e.target.value})}
                className="mt-1 w-full rounded border px-3 py-2"/>
            </label>)}
            {partialTax&&taxLines.map(line=><label key={line.id} className="block text-sm">{line.label} — available {(line.remainingMinor/100).toFixed(2)} {currency}
              <input aria-label={`Refund for ${line.label}`} type="number" min="0" step="0.01" max={line.remainingMinor/100}
                value={lineAmounts[line.id]||''} onChange={e=>setLineAmounts({...lineAmounts,[line.id]:e.target.value})}
                className="mt-1 w-full rounded-lg border px-3 py-2"/>
            </label>)}
            <p className="text-xs text-gray-500">Item amounts include tax. The original tax will be returned with each item.</p>
          </fieldset>}
          {/* Amount input */}
          {!taxLines&&<div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Refund Amount ({currency})</label>
            <input
              type="number"
              step="0.01"
              min="0.01"
              max={maxRefund}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            />
            <div className="mt-1.5 flex gap-2">
              <button
                type="button"
                onClick={() => setAmount(String(maxRefund))}
                className="rounded-md bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200"
              >
                Full Refund
              </button>
              <button
                type="button"
                onClick={() => setAmount(String(Math.round((maxRefund / 2) * 100) / 100))}
                className="rounded-md bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200"
              >
                Half
              </button>
            </div>
          </div>

          }
          {/* Reason */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Reason (optional)</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="e.g. Customer requested cancellation"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            />
          </div>

          {/* Result state feedback */}
          {resultState?.type === 'success' && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
              <p className="font-medium">{zeroReturn?'Item return recorded — no money refunded':'Refund processed successfully'}</p>
            </div>
          )}
          {resultState?.type === 'pending' && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <p className="font-medium">Refund is being processed</p>
              <p className="mt-0.5 text-amber-700">Another process may be handling this refund. Please check back shortly.</p>
            </div>
          )}
          {resultState?.type === 'provider_pending' && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <p className="font-medium">Refund pending at provider</p>
              <p className="mt-0.5 text-amber-700">The payment provider has accepted the refund. It will be reconciled automatically.</p>
            </div>
          )}
          {resultState?.type === 'provider_ambiguous' && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <p className="font-medium">Refund status uncertain</p>
              <p className="mt-0.5 text-amber-700">The refund outcome could not be confirmed. It will be reconciled automatically.</p>
            </div>
          )}
          {resultState?.type === 'provider_success_unfinalized' && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <p className="font-medium">Provider confirmed refund</p>
              <p className="mt-0.5 text-amber-700">The provider confirmed the refund but local finalization is incomplete. It will be retried automatically.</p>
            </div>
          )}
          {resultState?.type === 'failed' && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <p className="font-medium">Refund failed</p>
              <p className="mt-0.5">{resultState.message}</p>
            </div>
          )}

          {/* Validation error (pre-submit) */}
          {error && !resultState && (
            <p className="text-sm text-red-600">{error}</p>
          )}

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              disabled={loading}
              className="flex-1 rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {resultState ? 'Close' : 'Cancel'}
            </button>
            {!resultState && (
              <button
                onClick={handleSubmit}
                disabled={loading||taxLoading||!!taxReadError}
                className="flex-1 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {loading ? 'Processing...' : 'Confirm Refund'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

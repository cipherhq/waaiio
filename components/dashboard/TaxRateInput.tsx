'use client';
import { useEffect, useState, type InputHTMLAttributes } from 'react';
import { parseTaxPercent } from '@/lib/tax/calculation';
/** Keep entered precision visible, and make invalid text invalid in the payload too. */
export function TaxRateInput({ rateBps, onRateChange, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'onRateChange'> & {
  rateBps: number | null; onRateChange: (rateBps: number | null) => void;
}) {
  const [text, setText] = useState(rateBps == null ? '' : String(rateBps / 100));
  useEffect(() => { if (rateBps == null) setText(''); else if (Number.isFinite(rateBps)) setText(String(rateBps / 100)); }, [rateBps]);
  return <input {...props} type="number" min="0" max="100" step="0.0001" value={text} onChange={event => {
    const value = event.target.value; setText(value);
    if (!value) { onRateChange(null); return; }
    try { onRateChange(parseTaxPercent(value)); } catch { onRateChange(Number.NaN); }
  }} />;
}

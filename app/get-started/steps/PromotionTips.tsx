'use client';

import { useState } from 'react';
import type { CapabilityId } from '@/lib/capabilities/types';
import type { BusinessCategoryKey } from '@/lib/constants';
import { buildPromotionTips } from './promotion-tips';

interface PromotionTipsProps {
  category: BusinessCategoryKey | '';
  capabilities: CapabilityId[];
  businessName: string;
  waLink: string;
}

export function PromotionTips({ category, capabilities, businessName, waLink }: PromotionTipsProps) {
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const tips = buildPromotionTips(category, capabilities, businessName, waLink);

  async function copyText(id: string, value: string) {
    setCopied(null);
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
    } catch {
      setCopyError(id);
    }
  }

  return (
    <section className="mt-8 text-left" aria-labelledby="promote-link-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="promote-link-heading" className="text-lg font-bold text-gray-900">Help customers find your WhatsApp link</h3>
        <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand">Optional</span>
      </div>
      <p className="mt-1 text-xs text-gray-500">
        A few quick ways to share your link. Nothing is posted automatically.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {tips.map(tip => (
          <div key={tip.id} className="flex flex-col rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-sm font-semibold text-gray-900">{tip.title}</p>
            <p className="mt-1 flex-1 text-xs leading-relaxed text-gray-500">{tip.description}</p>
            {tip.copyText && tip.copyLabel && (
              <button
                type="button"
                onClick={() => copyText(tip.id, tip.copyText!)}
                className="mt-4 w-full rounded-lg border border-brand/30 px-3 py-2 text-xs font-semibold text-brand transition hover:bg-brand-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                {copied === tip.id ? 'Copied!' : tip.copyLabel}
              </button>
            )}
            {copyError === tip.id && (
              <p className="mt-2 text-xs text-red-600" role="status">Could not copy. Use the link above instead.</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

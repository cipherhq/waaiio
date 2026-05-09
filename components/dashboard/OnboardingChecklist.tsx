'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useBusiness, useCapabilities } from './DashboardProvider';
import { createClient } from '@/lib/supabase/client';

interface ChecklistItem {
  key: string;
  label: string;
  description: string;
  href: string;
  check: () => Promise<boolean>;
}

export function OnboardingChecklist() {
  const business = useBusiness();
  const capabilities = useCapabilities();
  const [completed, setCompleted] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(false);

  const items: ChecklistItem[] = [
    {
      key: 'setup',
      label: 'Set up your business',
      description: 'Add your services, prices, and operating hours so customers can book or order.',
      href: '/dashboard/services',
      check: async () => {
        const supabase = createClient();
        const { count } = await supabase.from('services').select('id', { count: 'exact', head: true }).eq('business_id', business.id);
        return (count || 0) > 0;
      },
    },
    {
      key: 'whatsapp',
      label: 'Connect your WhatsApp number',
      description: 'Get your own dedicated number so customers can message your business directly.',
      href: '/dashboard/whatsapp/connect',
      check: async () => {
        const supabase = createClient();
        const { count } = await supabase
          .from('whatsapp_channels')
          .select('id', { count: 'exact', head: true })
          .eq('business_id', business.id)
          .eq('channel_type', 'dedicated')
          .eq('is_active', true);
        return (count || 0) > 0;
      },
    },
    {
      key: 'test',
      label: 'Test your bot',
      description: 'Send a message to your WhatsApp number and see the bot respond.',
      href: '/dashboard/whatsapp',
      check: async () => {
        const supabase = createClient();
        const { count } = await supabase.from('chat_messages').select('id', { count: 'exact', head: true }).eq('business_id', business.id).eq('direction', 'inbound');
        return (count || 0) > 0;
      },
    },
    {
      key: 'launch',
      label: 'Get paid & go live',
      description: 'Connect your payout account and share your WhatsApp link with customers.',
      href: '/dashboard/payouts',
      check: async () => {
        const supabase = createClient();
        const { count } = await supabase.from('payout_accounts').select('id', { count: 'exact', head: true }).eq('business_id', business.id).eq('is_active', true);
        return (count || 0) > 0;
      },
    },
  ];

  useEffect(() => {
    // Check if dismissed
    const key = `waaiio-checklist-dismissed-${business.id}`;
    if (localStorage.getItem(key) === 'true') {
      setDismissed(true);
      setLoading(false);
      return;
    }

    async function checkAll() {
      const results: Record<string, boolean> = {};
      await Promise.all(
        items.map(async (item) => {
          try { results[item.key] = await item.check(); } catch { results[item.key] = false; }
        })
      );
      setCompleted(results);
      setLoading(false);

      // Auto-dismiss if all complete
      if (Object.values(results).every(Boolean)) {
        localStorage.setItem(key, 'true');
        setDismissed(true);
      }
    }
    checkAll();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business.id]);

  if (dismissed || loading) return null;

  const completedCount = Object.values(completed).filter(Boolean).length;
  const progress = Math.round((completedCount / items.length) * 100);

  return (
    <div className="mb-6 rounded-2xl border border-brand-100 bg-brand-50/50 p-5 dark:border-brand-900 dark:bg-brand-900/20">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">Getting started with Waaiio</h3>
          <p className="mt-0.5 text-xs text-gray-500">{completedCount} of {items.length} steps completed</p>
        </div>
        <button
          onClick={() => {
            localStorage.setItem(`waaiio-checklist-dismissed-${business.id}`, 'true');
            setDismissed(true);
          }}
          className="text-xs text-gray-400 hover:text-gray-600"
        >
          Dismiss
        </button>
      </div>

      {/* Progress bar */}
      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-brand-100 dark:bg-brand-900/40">
        <div
          className="h-full rounded-full bg-brand transition-all duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Checklist items */}
      <div className="mt-4 space-y-2">
        {items.map((item) => (
          <Link
            key={item.key}
            href={item.href}
            className={`flex items-start gap-3 rounded-xl p-3 transition ${
              completed[item.key]
                ? 'bg-green-50/50 dark:bg-green-900/10'
                : 'bg-white hover:bg-gray-50 dark:bg-gray-800 dark:hover:bg-gray-700'
            }`}
          >
            <div className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
              completed[item.key]
                ? 'border-green-500 bg-green-500'
                : 'border-gray-300 dark:border-gray-600'
            }`}>
              {completed[item.key] && (
                <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
              )}
            </div>
            <div>
              <p className={`text-sm font-medium ${completed[item.key] ? 'text-green-700 line-through dark:text-green-400' : 'text-gray-900 dark:text-gray-100'}`}>
                {item.label}
              </p>
              <p className="mt-0.5 text-xs text-gray-500">{item.description}</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

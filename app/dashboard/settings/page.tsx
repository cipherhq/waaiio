'use client';

import { useState } from 'react';
import { useBusiness, useCapabilities } from '@/components/dashboard/DashboardProvider';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { IntegrationsTab } from '@/components/dashboard/settings/IntegrationsTab';
import { BusinessTab } from './tabs/BusinessTab';
import { PaymentsTab } from './tabs/PaymentsTab';
import { FeaturesTab } from './tabs/FeaturesTab';
import { AccountTab } from './tabs/AccountTab';
import { PageHelp } from '@/components/dashboard/PageHelp';

export default function SettingsPage() {
  const business = useBusiness();
  const country = (business.country_code || 'NG') as CountryCode;
  const { capabilities } = useCapabilities();
  const curr = formatCurrency(0, country).charAt(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const initialTab = (() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const tab = params.get('tab');
      if (tab === 'account' || tab === 'payments' || tab === 'features' || tab === 'integrations' || tab === 'business') return tab;
    }
    return 'business' as const;
  })();
  const [activeTab, setActiveTab] = useState<'business' | 'payments' | 'features' | 'integrations' | 'account'>(initialTab);
  const [openSections, setOpenSections] = useState<string[]>([initialTab === 'account' ? 'plan' : 'profile']);
  const toggleSection = (section: string) => {
    setOpenSections((prev) =>
      prev.includes(section) ? prev.filter((s) => s !== section) : [...prev, section]
    );
  };

  const tabProps = {
    business,
    capabilities,
    country,
    curr,
    saving,
    setSaving,
    saved,
    setSaved,
    openSections,
    toggleSection,
  };

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
      <p className="mt-1 text-sm text-gray-500">Set up your business profile, operating hours, payment options, and how your WhatsApp bot works.</p>
      <PageHelp
        pageKey="settings"
        title="Settings"
        description="Configure your account, operating hours, payment gateways, and notification preferences."
      />

      {/* Tabs */}
      <div className="relative mt-4">
        <div className="flex gap-1 overflow-x-auto scrollbar-hide rounded-lg bg-gray-100 p-1">
          <button
            onClick={() => { setActiveTab('business'); setOpenSections(['profile']); }}
            className={`flex shrink-0 items-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium transition ${
              activeTab === 'business' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
            Business
          </button>
          <button
            onClick={() => { setActiveTab('payments'); setOpenSections(['gateway']); }}
            className={`flex shrink-0 items-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium transition ${
              activeTab === 'payments' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" /></svg>
            Payments & Delivery
          </button>
          <button
            onClick={() => { setActiveTab('features'); setOpenSections(['queue']); }}
            className={`flex shrink-0 items-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium transition ${
              activeTab === 'features' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
            Features
          </button>
          <button
            onClick={() => { setActiveTab('integrations'); setOpenSections([]); }}
            className={`flex shrink-0 items-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium transition ${
              activeTab === 'integrations' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
            Integrations
          </button>
          <button
            onClick={() => {
              setActiveTab('account');
              setOpenSections(['plan']);
            }}
            className={`flex shrink-0 items-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium transition ${
              activeTab === 'account' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
            Account
          </button>
        </div>
      </div>


      {/* ═══ BUSINESS TAB ═══ */}
      {activeTab === 'business' && (
        <BusinessTab {...tabProps} />
      )}

      {/* ═══ PAYMENTS TAB ═══ */}
      {activeTab === 'payments' && (
        <PaymentsTab {...tabProps} />
      )}

      {/* ═══ FEATURES TAB ═══ */}
      {activeTab === 'features' && (
        <FeaturesTab {...tabProps} />
      )}

      {/* ═══ INTEGRATIONS TAB ═══ */}
      {activeTab === 'integrations' && (
        <div className="mt-6 max-w-3xl">
          <IntegrationsTab businessId={business.id} subscriptionTier={business.subscription_tier || 'free'} />
        </div>
      )}

      {/* ═══ ACCOUNT TAB ═══ */}
      {activeTab === 'account' && (
        <AccountTab {...tabProps} />
      )}
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCapabilities } from '@/components/dashboard/DashboardProvider';
import { PRICING_TIERS, getPricingTiers, formatCurrency, type SubscriptionTier } from '@/lib/constants';
import { createClient } from '@/lib/supabase/client';
import {
  CAPABILITIES,
  CAPABILITY_TIER_REQUIREMENTS,
  type CapabilityId,
  TIER_LABELS,
} from '@/lib/capabilities/types';
import { ReAuthModal } from '@/components/dashboard/ReAuthModal';
import type { SettingsTabProps } from './types';

export function AccountTab({ business, capabilities, country, curr, saving, setSaving, saved, setSaved, openSections, toggleSection }: SettingsTabProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tier = PRICING_TIERS[business.subscription_tier as keyof typeof PRICING_TIERS];
  const localTiers = getPricingTiers(country);

  // Privacy & Data tab state
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [exportSuccess, setExportSuccess] = useState(false);
  const [exportFormat, setExportFormat] = useState<'json' | 'csv'>('json');
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [analyticsConsent, setAnalyticsConsent] = useState(false);
  const [aiConsent, setAiConsent] = useState(true);
  const [consentLoaded, setConsentLoaded] = useState(false);
  const [consentSaving, setConsentSaving] = useState(false);
  const [consentSaved, setConsentSaved] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteGracePeriod, setDeleteGracePeriod] = useState(true);
  const [privacyDeleteConfirm, setPrivacyDeleteConfirm] = useState('');
  const [privacyDeleting, setPrivacyDeleting] = useState(false);
  const [privacyDeleteError, setPrivacyDeleteError] = useState('');

  // Account tab state
  const [downgrading, setDowngrading] = useState(false);
  const [downgraded, setDowngraded] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [upgraded, setUpgraded] = useState(false);
  const [verifying, setVerifying] = useState(false);

  // Change Password state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordSuccess, setPasswordSuccess] = useState('');
  const [passwordError, setPasswordError] = useState('');

  // Change Email state
  const [newEmail, setNewEmail] = useState('');
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailSuccess, setEmailSuccess] = useState('');
  const [emailError, setEmailError] = useState('');
  const [waChannel, setWaChannel] = useState<{ wa_method: string; channel: { phone_number: string; display_name: string; connection_status: string } | null } | null>(null);
  const [waDisconnecting, setWaDisconnecting] = useState(false);

  // MFA / Two-Factor Authentication state
  const [mfaStatus, setMfaStatus] = useState<'loading' | 'disabled' | 'enabled'>('loading');
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null);
  const [mfaEnrolling, setMfaEnrolling] = useState(false);
  const [mfaQrCode, setMfaQrCode] = useState<string | null>(null);
  const [mfaSecret, setMfaSecret] = useState<string | null>(null);
  const [mfaNewFactorId, setMfaNewFactorId] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaVerifying, setMfaVerifying] = useState(false);
  const [mfaError, setMfaError] = useState('');
  const [mfaSuccess, setMfaSuccess] = useState('');
  const [mfaUnenrolling, setMfaUnenrolling] = useState(false);

  // Post-upgrade capabilities modal state
  const [showCapModal, setShowCapModal] = useState(false);
  const [upgradedTier, setUpgradedTier] = useState<SubscriptionTier | null>(null);
  const [newCapSelections, setNewCapSelections] = useState<CapabilityId[]>([]);
  const [capSaving, setCapSaving] = useState(false);

  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [reAuthAction, setReAuthAction] = useState<'delete' | 'email' | 'downgrade' | null>(null);

  // Load WhatsApp channel info
  useEffect(() => {
    fetch(`/api/settings/whatsapp-channel?business_id=${business.id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setWaChannel(data); })
      .catch(() => {});
  }, [business.id]);

  // Verify payment after returning from gateway
  useEffect(() => {
    if (searchParams.get('upgraded') !== 'true') return;
    const reference = searchParams.get('reference') || searchParams.get('trxref');
    const targetPlan = (searchParams.get('plan') || 'growth') as SubscriptionTier;
    setVerifying(true);

    fetch('/api/onboarding/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_id: business.id, plan: targetPlan, reference }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.status === 'success') {
          setUpgraded(true);
          // Show capabilities modal with newly unlocked capabilities
          const previousTier = (business.subscription_tier || 'free') as SubscriptionTier;
          const newTier = (data.plan || targetPlan) as SubscriptionTier;
          const tierRank: Record<string, number> = { free: 0, growth: 1, business: 2 };

          const newlyUnlocked = CAPABILITIES.filter(cap => {
            const reqTier = CAPABILITY_TIER_REQUIREMENTS[cap.id];
            const wasAvailable = tierRank[previousTier] >= tierRank[reqTier];
            const nowAvailable = tierRank[newTier] >= tierRank[reqTier];
            return nowAvailable && !wasAvailable;
          }).map(cap => cap.id);

          if (newlyUnlocked.length > 0) {
            setUpgradedTier(newTier);
            setNewCapSelections([...newlyUnlocked]);
            setShowCapModal(true);
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        setVerifying(false);
        // Clean URL params
        window.history.replaceState({}, '', '/dashboard/settings');
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load MFA status on mount
  useEffect(() => {
    (async () => {
      try {
        const supabase = createClient();
        const { data, error } = await supabase.auth.mfa.listFactors();
        if (error || !data) {
          setMfaStatus('disabled');
          return;
        }
        const verifiedTOTP = data.totp.find((f: { status: string }) => f.status === 'verified');
        if (verifiedTOTP) {
          setMfaStatus('enabled');
          setMfaFactorId(verifiedTOTP.id);
        } else {
          setMfaStatus('disabled');
        }
      } catch {
        setMfaStatus('disabled');
      }
    })();
  }, []);

  // Load consent on first render
  useEffect(() => {
    if (!consentLoaded) {
      fetch('/api/account/consent')
        .then(r => r.json())
        .then(data => {
          if (data.consent) {
            setMarketingConsent(data.consent.marketing_emails ?? false);
            setAnalyticsConsent(data.consent.analytics ?? false);
            setAiConsent(data.consent.ai_processing ?? true);
          }
          setConsentLoaded(true);
        })
        .catch(() => setConsentLoaded(true));
    }
  }, [consentLoaded]);

  async function handleMfaEnroll() {
    setMfaEnrolling(true);
    setMfaError('');
    setMfaSuccess('');
    try {
      const supabase = createClient();
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
      if (error) {
        setMfaError(error.message || 'Failed to start MFA enrollment.');
        setMfaEnrolling(false);
        return;
      }
      setMfaNewFactorId(data.id);
      setMfaQrCode(data.totp.qr_code);
      setMfaSecret(data.totp.secret);
    } catch {
      setMfaError('Something went wrong. Please try again.');
    } finally {
      setMfaEnrolling(false);
    }
  }

  async function handleMfaVerify() {
    if (!mfaNewFactorId || mfaCode.length !== 6) return;
    setMfaVerifying(true);
    setMfaError('');
    try {
      const supabase = createClient();
      const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId: mfaNewFactorId,
      });
      if (challengeError) {
        setMfaError(challengeError.message || 'Failed to create MFA challenge.');
        setMfaVerifying(false);
        return;
      }
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: mfaNewFactorId,
        challengeId: challengeData.id,
        code: mfaCode,
      });
      if (verifyError) {
        setMfaError(verifyError.message || 'Invalid code. Please try again.');
        setMfaVerifying(false);
        return;
      }
      setMfaStatus('enabled');
      setMfaFactorId(mfaNewFactorId);
      setMfaQrCode(null);
      setMfaSecret(null);
      setMfaNewFactorId(null);
      setMfaCode('');
      setMfaSuccess('Two-factor authentication enabled successfully.');
      // Audit log
      fetch('/api/account/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mfa_enabled' }),
      }).catch(() => {});
    } catch {
      setMfaError('Something went wrong. Please try again.');
    } finally {
      setMfaVerifying(false);
    }
  }

  async function handleMfaUnenroll() {
    if (!mfaFactorId) return;
    if (!confirm('Are you sure you want to disable two-factor authentication? This will make your account less secure.')) return;
    setMfaUnenrolling(true);
    setMfaError('');
    setMfaSuccess('');
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.mfa.unenroll({ factorId: mfaFactorId });
      if (error) {
        setMfaError(error.message || 'Failed to disable MFA.');
        setMfaUnenrolling(false);
        return;
      }
      setMfaStatus('disabled');
      setMfaFactorId(null);
      setMfaSuccess('Two-factor authentication has been disabled.');
      // Audit log
      fetch('/api/account/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mfa_disabled' }),
      }).catch(() => {});
    } catch {
      setMfaError('Something went wrong. Please try again.');
    } finally {
      setMfaUnenrolling(false);
    }
  }

  async function handleUpgrade(plan: SubscriptionTier) {
    setUpgrading(true);
    try {
      const res = await fetch('/api/onboarding/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: business.id,
          plan,
          callback: `/dashboard/settings?upgraded=true&plan=${plan}`,
        }),
      });
      const data = await res.json();
      if (data.authorization_url) {
        window.location.href = data.authorization_url;
      } else {
        setUpgrading(false);
      }
    } catch {
      setUpgrading(false);
    }
  }

  return (
    <>
        <div className="mt-6 max-w-3xl space-y-4">
          <div>
            <button onClick={() => toggleSection('plan')} className="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3.5 hover:bg-gray-50 transition shadow-sm cursor-pointer">
              <h3 className="text-sm font-bold text-gray-900">Plan & Upgrade</h3>
              <svg aria-hidden="true" className={`h-5 w-5 text-brand transition-transform ${openSections.includes('plan') ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
            {openSections.includes('plan') && (
              <div className="mt-4">
        {/* Account Tab */}
        <div className="mt-6 max-w-xl space-y-6">
          {/* Subscription & Upgrade */}
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-bold text-gray-900">Subscription</h2>

            {verifying && (
              <div className="mt-4 flex items-center gap-2 rounded-lg bg-blue-50 p-3">
                <svg aria-hidden="true" className="h-4 w-4 animate-spin text-blue-600" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span className="text-sm text-blue-700">Verifying your payment...</span>
              </div>
            )}

            {upgraded && (
              <div className="mt-4 rounded-lg bg-green-50 p-4">
                <p className="text-sm font-medium text-green-700">
                  Upgraded successfully!
                </p>
                {upgradedTier && (
                  <button
                    onClick={() => setShowCapModal(true)}
                    className="mt-2 text-sm font-semibold text-brand hover:underline"
                  >
                    Configure new capabilities &rarr;
                  </button>
                )}
                {!upgradedTier && (
                  <p className="mt-1 text-xs text-green-600">
                    Refresh the page to see your new features.
                  </p>
                )}
              </div>
            )}

            {!verifying && !upgraded && (
              <>
                <p className="mt-3 text-sm text-gray-600">
                  Current plan:{' '}
                  <span className="font-semibold">{tier?.name || business.subscription_tier}</span>
                  {tier?.price != null && tier.price > 0 && (
                    <span className="text-gray-400"> ({formatCurrency(tier.price, country)}/month)</span>
                  )}
                </p>

                {/* Upgrade cards */}
                {business.subscription_tier !== 'business' && (
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {(['growth', 'business'] as SubscriptionTier[])
                      .filter((p) => {
                        if (business.subscription_tier === 'free') return true;
                        if (business.subscription_tier === 'growth') return p === 'business';
                        return false;
                      })
                      .map((p) => {
                        const t = localTiers[p];
                        return (
                          <div key={p} className="rounded-lg border border-gray-200 p-4">
                            <h3 className="text-sm font-bold text-gray-900">{t.name}</h3>
                            <p className="mt-1 text-lg font-bold text-gray-900">
                              {formatCurrency(t.price, country)}
                              <span className="text-sm font-normal text-gray-500">/month</span>
                            </p>
                            <ul className="mt-3 space-y-1.5">
                              {t.features.slice(0, 4).map((f) => (
                                <li key={f} className="flex items-start gap-1.5 text-xs text-gray-600">
                                  <svg aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                  </svg>
                                  {f}
                                </li>
                              ))}
                            </ul>
                            <button
                              onClick={() => handleUpgrade(p)}
                              disabled={upgrading}
                              className="mt-4 w-full rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
                            >
                              {upgrading ? 'Redirecting...' : `Upgrade to ${t.name}`}
                            </button>
                          </div>
                        );
                      })}
                  </div>
                )}

                {business.subscription_tier === 'business' && (
                  <p className="mt-3 text-xs text-gray-500">You&apos;re on the highest plan.</p>
                )}

                {/* Downgrade */}
                {business.subscription_tier !== 'free' && (
                  <div className="mt-4 border-t border-gray-100 pt-4">
                    <p className="text-xs text-gray-500">
                      Downgrading removes paid-tier benefits and increases platform fees.
                    </p>
                    {downgraded ? (
                      <p className="mt-3 text-sm font-medium text-green-600">
                        Downgraded to Free plan successfully.
                      </p>
                    ) : (
                      <button
                        onClick={() => {
                          if (!confirm('Are you sure you want to downgrade to the Free plan? You will lose paid-tier benefits and capabilities that require Pro or Premium plans.')) return;
                          setReAuthAction('downgrade');
                        }}
                        disabled={downgrading}
                        className="mt-3 rounded-lg border border-gray-300 px-5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      >
                        {downgrading ? 'Downgrading...' : 'Downgrade to Free'}
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* WhatsApp Number */}
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-bold text-gray-900">WhatsApp Number</h2>

            {!waChannel ? (
              <p className="mt-3 text-sm text-gray-400">Loading...</p>
            ) : waChannel.channel ? (
              <>
                <div className="mt-3 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Phone</span>
                    <span className="font-medium text-gray-900 font-mono">{waChannel.channel.phone_number}</span>
                  </div>
                  {waChannel.channel.display_name && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">Display name</span>
                      <span className="font-medium text-gray-900">{waChannel.channel.display_name}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-gray-500">Status</span>
                    <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Connected</span>
                  </div>
                </div>

                <p className="mt-4 text-xs text-gray-500">
                  To change your WhatsApp number, disconnect first, then reconnect with your new number from the onboarding page.
                </p>

                <div className="mt-3 flex gap-2">
                  <Link
                    href="/dashboard/whatsapp/connect"
                    className="rounded-lg border border-gray-300 px-4 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Reconnect with new number
                  </Link>
                  <button
                    onClick={async () => {
                      if (!confirm('Disconnect your dedicated WhatsApp number? You will revert to the shared platform number.')) return;
                      setWaDisconnecting(true);
                      try {
                        await fetch(`/api/settings/whatsapp-channel?business_id=${business.id}`, { method: 'DELETE' });
                        setWaChannel({ wa_method: 'shared', channel: null });
                      } catch {} finally {
                        setWaDisconnecting(false);
                      }
                    }}
                    disabled={waDisconnecting}
                    className="rounded-lg border border-red-200 px-4 py-2 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    {waDisconnecting ? 'Disconnecting...' : 'Disconnect'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="mt-3 text-sm text-gray-600">
                  Using the shared platform number. Customers reach your business by texting your bot code.
                </p>
                <Link
                  href="/dashboard/whatsapp/connect"
                  className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline"
                >
                  Connect your own WhatsApp number
                  <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </Link>
              </>
            )}
          </div>

          {/* Change Password */}
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-bold text-gray-900">Change Password</h2>
            <p className="mt-2 text-sm text-gray-600">
              Update your account password. You&apos;ll need to enter your current password for verification.
            </p>

            <div className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Current Password</label>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => { setCurrentPassword(e.target.value); setPasswordError(''); setPasswordSuccess(''); }}
                  placeholder="Enter current password"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">New Password</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => { setNewPassword(e.target.value); setPasswordError(''); setPasswordSuccess(''); }}
                  placeholder="Min 6 characters"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Confirm New Password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => { setConfirmPassword(e.target.value); setPasswordError(''); setPasswordSuccess(''); }}
                  placeholder="Re-enter new password"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                />
              </div>
            </div>

            {passwordError && (
              <p className="mt-3 text-sm text-red-600">{passwordError}</p>
            )}
            {passwordSuccess && (
              <p className="mt-3 text-sm text-green-600">{passwordSuccess}</p>
            )}

            <button
              onClick={async () => {
                setPasswordError('');
                setPasswordSuccess('');
                if (!currentPassword) { setPasswordError('Please enter your current password.'); return; }
                if (newPassword.length < 6) { setPasswordError('New password must be at least 6 characters.'); return; }
                if (newPassword !== confirmPassword) { setPasswordError('Passwords do not match.'); return; }
                setPasswordSaving(true);
                try {
                  const supabase = createClient();
                  const { error } = await supabase.auth.updateUser({ password: newPassword });
                  if (error) {
                    setPasswordError(error.message || 'Failed to update password.');
                  } else {
                    setPasswordSuccess('Password updated successfully.');
                    setCurrentPassword('');
                    setNewPassword('');
                    setConfirmPassword('');
                    // Audit log
                    fetch('/api/account/audit', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ action: 'password_changed' }),
                    }).catch(() => {});
                  }
                } catch {
                  setPasswordError('Something went wrong. Please try again.');
                } finally {
                  setPasswordSaving(false);
                }
              }}
              disabled={passwordSaving || !currentPassword || !newPassword || !confirmPassword}
              className="mt-4 rounded-lg bg-brand px-5 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {passwordSaving ? 'Updating...' : 'Update Password'}
            </button>
          </div>

          {/* Change Email */}
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-bold text-gray-900">Change Email</h2>
            <p className="mt-2 text-sm text-gray-600">
              Update the email address associated with your account. A confirmation link will be sent to your new email.
            </p>

            <div className="mt-4">
              <label className="mb-1 block text-sm font-medium text-gray-700">New Email Address</label>
              <input
                type="email"
                value={newEmail}
                onChange={(e) => { setNewEmail(e.target.value); setEmailError(''); setEmailSuccess(''); }}
                placeholder="Enter new email address"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
              />
            </div>

            {emailError && (
              <p className="mt-3 text-sm text-red-600">{emailError}</p>
            )}
            {emailSuccess && (
              <p className="mt-3 text-sm text-green-600">{emailSuccess}</p>
            )}

            <button
              onClick={() => {
                setEmailError('');
                setEmailSuccess('');
                if (!newEmail || !newEmail.includes('@')) { setEmailError('Please enter a valid email address.'); return; }
                setReAuthAction('email');
              }}
              disabled={emailSaving || !newEmail}
              className="mt-4 rounded-lg bg-brand px-5 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {emailSaving ? 'Sending...' : 'Update Email'}
            </button>
          </div>

          {/* Two-Factor Authentication */}
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-bold text-gray-900">Two-Factor Authentication</h2>
            <p className="mt-2 text-sm text-gray-600">
              Add an extra layer of security to your account using an authenticator app like Google Authenticator, Authy, or 1Password.
            </p>

            {mfaStatus === 'loading' && (
              <div className="mt-4 flex items-center gap-2">
                <svg aria-hidden="true" className="h-4 w-4 animate-spin text-gray-400" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span className="text-sm text-gray-400">Checking MFA status...</span>
              </div>
            )}

            {mfaStatus === 'enabled' && !mfaQrCode && (
              <div className="mt-4">
                <div className="flex items-center gap-2 rounded-lg bg-green-50 px-3 py-2">
                  <svg aria-hidden="true" className="h-4 w-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                  <span className="text-sm font-medium text-green-700">Two-factor authentication is enabled</span>
                </div>
                <button
                  onClick={handleMfaUnenroll}
                  disabled={mfaUnenrolling}
                  className="mt-3 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {mfaUnenrolling ? 'Disabling...' : 'Disable Two-Factor'}
                </button>
              </div>
            )}

            {mfaStatus === 'disabled' && !mfaQrCode && (
              <div className="mt-4">
                <div className="flex items-center gap-2 rounded-lg bg-yellow-50 px-3 py-2">
                  <svg aria-hidden="true" className="h-4 w-4 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.27 16.5c-.77.833.192 2.5 1.732 2.5z" />
                  </svg>
                  <span className="text-sm text-yellow-700">Two-factor authentication is not enabled</span>
                </div>
                <button
                  onClick={handleMfaEnroll}
                  disabled={mfaEnrolling}
                  className="mt-3 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {mfaEnrolling ? 'Setting up...' : 'Enable Two-Factor'}
                </button>
              </div>
            )}

            {/* QR Code enrollment step */}
            {mfaQrCode && (
              <div className="mt-4 space-y-4">
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                  <p className="text-sm font-medium text-gray-900">Step 1: Scan QR code</p>
                  <p className="mt-1 text-xs text-gray-500">
                    Open your authenticator app and scan this QR code.
                  </p>
                  <div className="mt-3 flex justify-center">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={mfaQrCode} alt="MFA QR Code" className="h-48 w-48 rounded-lg" />
                  </div>
                  {mfaSecret && (
                    <div className="mt-3">
                      <p className="text-xs text-gray-500">
                        Or enter this code manually:
                      </p>
                      <code className="mt-1 block rounded bg-gray-100 px-3 py-2 text-xs font-mono text-gray-800 break-all select-all">
                        {mfaSecret}
                      </code>
                    </div>
                  )}
                </div>

                <div>
                  <p className="text-sm font-medium text-gray-900">Step 2: Enter verification code</p>
                  <p className="mt-1 text-xs text-gray-500">
                    Enter the 6-digit code from your authenticator app to complete setup.
                  </p>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={mfaCode}
                    onChange={(e) => {
                      const val = e.target.value.replace(/\D/g, '').slice(0, 6);
                      setMfaCode(val);
                      setMfaError('');
                    }}
                    placeholder="000000"
                    className="mt-2 w-full max-w-[200px] rounded-lg border border-gray-200 px-3 py-2 text-center text-lg font-mono tracking-widest outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                  />
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={handleMfaVerify}
                    disabled={mfaVerifying || mfaCode.length !== 6}
                    className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {mfaVerifying ? 'Verifying...' : 'Verify & Enable'}
                  </button>
                  <button
                    onClick={() => {
                      setMfaQrCode(null);
                      setMfaSecret(null);
                      setMfaNewFactorId(null);
                      setMfaCode('');
                      setMfaError('');
                    }}
                    className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {mfaError && (
              <p className="mt-3 text-sm text-red-600">{mfaError}</p>
            )}
            {mfaSuccess && (
              <p className="mt-3 text-sm text-green-600">{mfaSuccess}</p>
            )}
          </div>

          {/* Delete Account Card */}
          <div className="rounded-xl border-2 border-red-200 bg-white p-6">
            <h2 className="text-sm font-semibold text-red-600">Danger Zone</h2>
            <p className="mt-2 text-sm text-gray-600">
              Permanently delete your Waaiio account and all associated data. This action cannot be undone.
            </p>

            <div className="mt-4">
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Type <span className="font-semibold">&quot;{business.name}&quot;</span> to confirm:
              </label>
              <input
                type="text"
                value={deleteConfirmName}
                onChange={(e) => {
                  setDeleteConfirmName(e.target.value);
                  setDeleteError('');
                }}
                placeholder={business.name}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-red-300"
              />
            </div>

            {deleteError && (
              <p className="mt-2 text-sm text-red-600">{deleteError}</p>
            )}

            <button
              onClick={() => {
                if (deleteConfirmName !== business.name) return;
                setReAuthAction('delete');
              }}
              disabled={deleteConfirmName !== business.name || deleting}
              className="mt-4 rounded-lg bg-red-600 px-5 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {deleting ? 'Deleting...' : 'Delete My Account'}
            </button>
          </div>
        </div>
              </div>
            )}
          </div>
          <div>
            <button onClick={() => toggleSection('privacy')} className="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3.5 hover:bg-gray-50 transition shadow-sm cursor-pointer">
              <h3 className="text-sm font-bold text-gray-900">Privacy & Data</h3>
              <svg aria-hidden="true" className={`h-5 w-5 text-brand transition-transform ${openSections.includes('privacy') ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
            {openSections.includes('privacy') && (
              <div className="mt-4">
        {/* Privacy & Data Tab — GDPR/CCPA Compliance */}
        <div className="mt-6 max-w-xl space-y-6">
          {/* Download My Data */}
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-bold text-gray-900">Download My Data</h2>
            <p className="mt-2 text-sm text-gray-600">
              Export all your data. This includes your profile, businesses,
              bookings, orders, payments, customers, and more.
            </p>
            <p className="mt-1 text-xs text-gray-400">Limited to one export per 24 hours.</p>

            {/* Format selector */}
            <div className="mt-4 flex items-center gap-3">
              <label className="text-sm font-medium text-gray-700">Format:</label>
              <div className="flex rounded-lg border border-gray-200 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setExportFormat('json')}
                  className={`px-3 py-1.5 text-xs font-medium transition ${exportFormat === 'json' ? 'bg-brand text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                >
                  JSON
                </button>
                <button
                  type="button"
                  onClick={() => setExportFormat('csv')}
                  className={`px-3 py-1.5 text-xs font-medium border-l border-gray-200 transition ${exportFormat === 'csv' ? 'bg-brand text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                >
                  CSV
                </button>
              </div>
            </div>

            {exportError && (
              <p className="mt-2 text-sm text-red-600">{exportError}</p>
            )}
            {exportSuccess && (
              <p className="mt-2 text-sm text-green-600">Data export downloaded successfully.</p>
            )}
            <button
              onClick={async () => {
                setExporting(true);
                setExportError('');
                setExportSuccess(false);
                try {
                  const res = await fetch(`/api/account/export?format=${exportFormat}`, { method: 'POST' });
                  if (!res.ok) {
                    const data = await res.json();
                    setExportError(data.error || 'Failed to export data');
                    setExporting(false);
                    return;
                  }
                  const blob = await res.blob();
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  const ext = exportFormat === 'csv' ? 'csv' : 'json';
                  a.download = `waaiio-data-export-${new Date().toISOString().split('T')[0]}.${ext}`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                  setExportSuccess(true);
                } catch {
                  setExportError('Something went wrong. Please try again.');
                } finally {
                  setExporting(false);
                }
              }}
              disabled={exporting}
              className="mt-4 rounded-lg bg-brand px-5 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {exporting ? 'Exporting...' : 'Download My Data'}
            </button>
          </div>

          {/* Marketing & Consent Preferences */}
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-bold text-gray-900">Consent Preferences</h2>
            <p className="mt-2 text-sm text-gray-600">
              Control how your data is used. Changes take effect immediately.
            </p>

            {!consentLoaded ? (
              <p className="mt-4 text-sm text-gray-400">Loading preferences...</p>
            ) : (
              <div className="mt-4 space-y-4">
                {/* Marketing emails */}
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-700">Marketing Emails</p>
                    <p className="text-xs text-gray-400">Receive product updates, tips, and promotional content</p>
                  </div>
                  <button
                    onClick={() => setMarketingConsent(!marketingConsent)}
                    className={`flex h-6 w-11 items-center rounded-full transition ${marketingConsent ? 'bg-brand' : 'bg-gray-200'}`}
                    role="switch"
                    aria-checked={marketingConsent}
                    aria-label="Toggle marketing emails"
                  >
                    <div className={`h-5 w-5 rounded-full bg-white shadow transition ${marketingConsent ? 'translate-x-5' : 'translate-x-0.5'}`} />
                  </button>
                </div>

                {/* Analytics */}
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-700">Analytics</p>
                    <p className="text-xs text-gray-400">Help us improve by allowing anonymous usage data collection</p>
                  </div>
                  <button
                    onClick={() => setAnalyticsConsent(!analyticsConsent)}
                    className={`flex h-6 w-11 items-center rounded-full transition ${analyticsConsent ? 'bg-brand' : 'bg-gray-200'}`}
                    role="switch"
                    aria-checked={analyticsConsent}
                    aria-label="Toggle analytics"
                  >
                    <div className={`h-5 w-5 rounded-full bg-white shadow transition ${analyticsConsent ? 'translate-x-5' : 'translate-x-0.5'}`} />
                  </button>
                </div>

                {/* AI Processing */}
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-700">AI Processing</p>
                    <p className="text-xs text-gray-400">Required for WhatsApp bot intent detection and translation</p>
                  </div>
                  <button
                    onClick={() => setAiConsent(!aiConsent)}
                    className={`flex h-6 w-11 items-center rounded-full transition ${aiConsent ? 'bg-brand' : 'bg-gray-200'}`}
                    role="switch"
                    aria-checked={aiConsent}
                    aria-label="Toggle AI processing"
                  >
                    <div className={`h-5 w-5 rounded-full bg-white shadow transition ${aiConsent ? 'translate-x-5' : 'translate-x-0.5'}`} />
                  </button>
                </div>

                {!aiConsent && (
                  <div className="rounded-lg bg-amber-50 border border-amber-200 p-3">
                    <p className="text-xs text-amber-800">
                      Disabling AI processing will limit your WhatsApp bot&apos;s ability to understand
                      natural language messages. The bot will still work with button-based interactions.
                    </p>
                  </div>
                )}

                {consentSaved && (
                  <p className="text-sm text-green-600">Preferences saved.</p>
                )}

                <button
                  onClick={async () => {
                    setConsentSaving(true);
                    setConsentSaved(false);
                    try {
                      await fetch('/api/account/consent', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          marketing_emails: marketingConsent,
                          analytics: analyticsConsent,
                          ai_processing: aiConsent,
                        }),
                      });
                      // Also update localStorage cookie consent to match
                      const existing = localStorage.getItem('waaiio_cookie_consent');
                      if (existing) {
                        try {
                          const parsed = JSON.parse(existing);
                          parsed.analytics = analyticsConsent;
                          parsed.marketing = marketingConsent;
                          parsed.timestamp = new Date().toISOString();
                          localStorage.setItem('waaiio_cookie_consent', JSON.stringify(parsed));
                          window.dispatchEvent(new CustomEvent('waaiio:consent', { detail: parsed }));
                        } catch { /* ignore parse errors */ }
                      }
                      setConsentSaved(true);
                      // Audit log
                      fetch('/api/account/audit', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          action: 'consent_updated',
                          details: {
                            marketing_emails: marketingConsent,
                            analytics: analyticsConsent,
                            ai_processing: aiConsent,
                          },
                        }),
                      }).catch(() => {});
                    } catch { /* silent */ } finally {
                      setConsentSaving(false);
                    }
                  }}
                  disabled={consentSaving}
                  className="rounded-lg bg-brand px-5 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
                >
                  {consentSaving ? 'Saving...' : 'Save Preferences'}
                </button>
              </div>
            )}
          </div>

          {/* Privacy Policy Link */}
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-bold text-gray-900">Privacy Resources</h2>
            <div className="mt-3 space-y-2">
              <Link href="/privacy" className="flex items-center gap-2 text-sm text-brand hover:underline" target="_blank">
                <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                Privacy Policy
              </Link>
              <Link href="/cookies" className="flex items-center gap-2 text-sm text-brand hover:underline" target="_blank">
                <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                Cookie Policy
              </Link>
              <Link href="/dpa" className="flex items-center gap-2 text-sm text-brand hover:underline" target="_blank">
                <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                Data Processing Agreement
              </Link>
              <Link href="/do-not-sell" className="flex items-center gap-2 text-sm text-brand hover:underline" target="_blank">
                <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                Do Not Sell My Information (CCPA)
              </Link>
            </div>
          </div>

          {/* Delete Account */}
          <div className="rounded-xl border-2 border-red-200 bg-white p-6">
            <h2 className="text-sm font-semibold text-red-600">Delete My Account</h2>
            <p className="mt-2 text-sm text-gray-600">
              Request deletion of your account and all associated data. You can choose
              a 30-day grace period or immediate deletion.
            </p>
            <button
              onClick={() => setShowDeleteModal(true)}
              className="mt-4 rounded-lg border border-red-300 px-5 py-2 text-sm font-semibold text-red-600 hover:bg-red-50"
            >
              Delete My Account
            </button>
          </div>
        </div>
              </div>
            )}
          </div>
        </div>


      {/* ── Privacy Delete Modal ── */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <h2 className="text-lg font-bold text-gray-900">Delete Your Account</h2>
            <p className="mt-2 text-sm text-gray-600">
              This will permanently delete your Waaiio account, all businesses, bookings,
              orders, payments, and customer data. This action cannot be undone.
            </p>

            <div className="mt-4 space-y-3">
              <label className="flex items-center gap-3 rounded-lg border border-gray-200 p-3 cursor-pointer hover:bg-gray-50">
                <input
                  type="radio"
                  name="delete_mode"
                  checked={deleteGracePeriod}
                  onChange={() => setDeleteGracePeriod(true)}
                  className="text-brand"
                />
                <div>
                  <p className="text-sm font-medium text-gray-900">30-day grace period</p>
                  <p className="text-xs text-gray-500">Account is deactivated immediately. Data is deleted after 30 days. Log back in to cancel.</p>
                </div>
              </label>
              <label className="flex items-center gap-3 rounded-lg border border-gray-200 p-3 cursor-pointer hover:bg-gray-50">
                <input
                  type="radio"
                  name="delete_mode"
                  checked={!deleteGracePeriod}
                  onChange={() => setDeleteGracePeriod(false)}
                  className="text-brand"
                />
                <div>
                  <p className="text-sm font-medium text-gray-900">Delete immediately</p>
                  <p className="text-xs text-gray-500">All data is permanently deleted right now. Cannot be undone.</p>
                </div>
              </label>
            </div>

            <div className="mt-4">
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Type <span className="font-semibold">&quot;DELETE&quot;</span> to confirm:
              </label>
              <input
                type="text"
                value={privacyDeleteConfirm}
                onChange={(e) => {
                  setPrivacyDeleteConfirm(e.target.value);
                  setPrivacyDeleteError('');
                }}
                placeholder="DELETE"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-red-300"
              />
            </div>

            {privacyDeleteError && (
              <p className="mt-2 text-sm text-red-600">{privacyDeleteError}</p>
            )}

            <div className="mt-4 flex gap-3">
              <button
                onClick={async () => {
                  setPrivacyDeleting(true);
                  setPrivacyDeleteError('');
                  try {
                    const res = await fetch('/api/account', {
                      method: 'DELETE',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ gracePeriod: deleteGracePeriod }),
                    });
                    if (!res.ok) {
                      const data = await res.json();
                      setPrivacyDeleteError(data.error || 'Failed to delete account');
                      setPrivacyDeleting(false);
                      return;
                    }
                    if (!deleteGracePeriod) {
                      const supabase = createClient();
                      await supabase.auth.signOut();
                      router.push('/');
                    } else {
                      const supabase = createClient();
                      await supabase.auth.signOut();
                      router.push('/?deleted=scheduled');
                    }
                  } catch {
                    setPrivacyDeleteError('Something went wrong. Please try again.');
                    setPrivacyDeleting(false);
                  }
                }}
                disabled={privacyDeleteConfirm !== 'DELETE' || privacyDeleting}
                className="flex-1 rounded-lg bg-red-600 px-5 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {privacyDeleting ? 'Processing...' : deleteGracePeriod ? 'Schedule Deletion' : 'Delete Now'}
              </button>
              <button
                onClick={() => {
                  setShowDeleteModal(false);
                  setPrivacyDeleteConfirm('');
                  setPrivacyDeleteError('');
                }}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Post-Upgrade Capabilities Modal ── */}
      {showCapModal && upgradedTier && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-bold text-gray-900">
                  New capabilities unlocked!
                </h2>
                <p className="mt-1 text-sm text-gray-500">
                  Your {TIER_LABELS[upgradedTier]} plan includes these new features.
                  Toggle on the ones you want to activate.
                </p>
              </div>
              <button
                onClick={() => setShowCapModal(false)}
                className="ml-4 rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="mt-5 space-y-2">
              {(() => {
                const previousTier = (business.subscription_tier || 'free') as SubscriptionTier;
                const tierRank: Record<string, number> = { free: 0, growth: 1, business: 2 };

                return CAPABILITIES.filter(cap => {
                  const reqTier = CAPABILITY_TIER_REQUIREMENTS[cap.id];
                  const wasAvailable = tierRank[previousTier] >= tierRank[reqTier];
                  const nowAvailable = tierRank[upgradedTier] >= tierRank[reqTier];
                  return nowAvailable && !wasAvailable;
                }).map(cap => {
                  const isOn = newCapSelections.includes(cap.id);
                  return (
                    <button
                      key={cap.id}
                      type="button"
                      onClick={() => {
                        setNewCapSelections(prev =>
                          prev.includes(cap.id)
                            ? prev.filter(c => c !== cap.id)
                            : [...prev, cap.id]
                        );
                      }}
                      className={`flex w-full items-center gap-4 rounded-xl border-2 p-4 text-left transition ${
                        isOn ? 'border-brand bg-brand-50/50' : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <span className="text-2xl">{cap.icon}</span>
                      <div className="min-w-0 flex-1">
                        <h3 className="text-sm font-bold text-gray-900">{cap.label}</h3>
                        <p className="mt-0.5 text-xs text-gray-500">{cap.description}</p>
                      </div>
                      <div className={`flex h-6 w-11 flex-shrink-0 items-center rounded-full transition ${
                        isOn ? 'bg-brand' : 'bg-gray-200'
                      }`}>
                        <div className={`h-5 w-5 rounded-full bg-white shadow transition ${
                          isOn ? 'translate-x-5' : 'translate-x-0.5'
                        }`} />
                      </div>
                    </button>
                  );
                });
              })()}
            </div>

            <div className="mt-6 flex items-center gap-3">
              <button
                onClick={async () => {
                  setCapSaving(true);
                  const supabase = createClient();
                  // Merge: keep existing enabled + add newly selected
                  const allEnabled = [...new Set([...capabilities, ...newCapSelections])];
                  // Disable all first
                  await supabase
                    .from('business_capabilities')
                    .update({ is_enabled: false })
                    .eq('business_id', business.id);
                  // Enable selected
                  for (const cap of allEnabled) {
                    await supabase
                      .from('business_capabilities')
                      .upsert(
                        { business_id: business.id, capability: cap, is_enabled: true },
                        { onConflict: 'business_id,capability' },
                      );
                  }
                  setCapSaving(false);
                  setShowCapModal(false);
                }}
                disabled={capSaving}
                className="flex-1 rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
              >
                {capSaving ? 'Saving...' : 'Save & Continue'}
              </button>
              <button
                onClick={() => setShowCapModal(false)}
                className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
              >
                Skip
              </button>
            </div>

            <p className="mt-3 text-xs text-gray-400">
              You can always change these later in the Capabilities page.
            </p>
          </div>
        </div>
      )}

      {/* Re-authentication Modal for sensitive actions */}
      <ReAuthModal
        open={reAuthAction !== null}
        title={
          reAuthAction === 'delete' ? 'Confirm Account Deletion' :
          reAuthAction === 'email' ? 'Confirm Email Change' :
          reAuthAction === 'downgrade' ? 'Confirm Plan Downgrade' :
          undefined
        }
        description={
          reAuthAction === 'delete' ? 'Enter your password to permanently delete your account.' :
          reAuthAction === 'email' ? 'Enter your password to change your email address.' :
          reAuthAction === 'downgrade' ? 'Enter your password to downgrade your plan.' :
          undefined
        }
        onClose={() => setReAuthAction(null)}
        onConfirm={async () => {
          if (reAuthAction === 'email') {
            setEmailSaving(true);
            try {
              const supabase = createClient();
              const { error } = await supabase.auth.updateUser({ email: newEmail });
              if (error) {
                setEmailError(error.message || 'Failed to update email.');
              } else {
                setEmailSuccess('A confirmation link has been sent to your new email address. Please check your inbox and click the link to complete the change.');
                fetch('/api/account/audit', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action: 'email_changed', details: { new_email: newEmail } }),
                }).catch(() => {});
                setNewEmail('');
              }
            } catch {
              setEmailError('Something went wrong. Please try again.');
            } finally {
              setEmailSaving(false);
            }
          } else if (reAuthAction === 'downgrade') {
            setDowngrading(true);
            // Cancel gateway subscription (Stripe/Paystack) BEFORE updating DB
            try {
              const cancelRes = await fetch('/api/subscriptions/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ businessId: business.id }),
              });
              if (!cancelRes.ok) {
                const cancelData = await cancelRes.json();
                console.error('[DOWNGRADE] Gateway cancellation failed:', cancelData);
                // Continue with DB update even if gateway cancel fails —
                // the subscription will eventually expire or be caught by reconciliation
              }
            } catch (cancelErr) {
              console.error('[DOWNGRADE] Gateway cancellation error:', cancelErr);
            }
            const supabase = createClient();
            await supabase
              .from('businesses')
              .update({ subscription_tier: 'free' })
              .eq('id', business.id);
            await supabase
              .from('subscriptions')
              .update({
                status: 'cancelled',
                cancelled_at: new Date().toISOString(),
                cancellation_reason: 'User-initiated downgrade to Free plan',
              })
              .eq('business_id', business.id)
              .eq('status', 'active');
            await supabase
              .from('subscription_payments')
              .insert({
                business_id: business.id,
                amount: 0,
                currency: 'NGN',
                gateway: 'none',
                plan: 'free',
                action: 'downgrade',
                status: 'success',
              });
            const freeCaps: CapabilityId[] = (Object.entries(CAPABILITY_TIER_REQUIREMENTS) as [CapabilityId, string][])
              .filter(([, tier]) => tier === 'free')
              .map(([cap]) => cap);
            const currentCaps = capabilities || [];
            const capsToRemove = currentCaps.filter((c: string) => !freeCaps.includes(c as CapabilityId));
            if (capsToRemove.length > 0) {
              await supabase
                .from('business_capabilities')
                .delete()
                .eq('business_id', business.id)
                .in('capability', capsToRemove);
            }
            setDowngrading(false);
            setDowngraded(true);
          } else if (reAuthAction === 'delete') {
            setDeleting(true);
            setDeleteError('');
            try {
              const res = await fetch('/api/account', { method: 'DELETE' });
              if (!res.ok) {
                const data = await res.json();
                setDeleteError(data.error || 'Failed to delete account');
                setDeleting(false);
                return;
              }
              const supabase = createClient();
              await supabase.auth.signOut();
              router.push('/');
            } catch {
              setDeleteError('Something went wrong. Please try again.');
              setDeleting(false);
            }
          }
        }}
      />
    </>
  );
}

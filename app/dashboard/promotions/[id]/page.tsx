'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { useParams, useRouter } from 'next/navigation';
import type {
  PromoCampaign,
  PromoCampaignStatus,
  PromoPrize,
  PromoCodeBatch,
  PromoFulfillmentStatus,
} from '@/lib/promotions/types';

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

interface CampaignDetail extends PromoCampaign {
  total_codes: number;
  verified_codes: number;
  unused_codes: number;
  void_codes: number;
  winners_count: number;
  pending_fulfillment: number;
  fulfilled_count: number;
  total_attempts: number;
  invalid_attempts: number;
  unique_participants: number;
}

interface Winner {
  id: string;
  phone_e164: string;
  redeemed_code: string | null;
  prize_id: string | null;
  claim_reference: string;
  claimed_at: string;
  fulfillment_status: PromoFulfillmentStatus;
  fulfillment_reference: string | null;
  fulfillment_notes: string | null;
  fulfilled_at: string | null;
  prize_name?: string;
  verification_mode?: string;
  verification_status?: string;
  verified_at?: string | null;
}

interface MaskedCode {
  id: string;
  displayCode: string;
  displaySuffix: string;
  outcome: string;
  status: string;
  claimed_at: string | null;
  batch_id: string;
  prize_id: string | null;
}

interface AnalyticsStats {
  totalCodes: number;
  verifiedCodes: number;
  unusedCodes: number;
  totalAttempts: number;
  validAttempts: number;
  invalidAttempts: number;
  rateLimitedAttempts: number;
  winners: number;
  uniqueParticipants: number;
  fulfilledWinners: number;
  pendingFulfillment: number;
  claimRate: number;
  fulfillmentRate: number;
}

interface DaySeries {
  date: string;
  attempts: number;
  validAttempts: number;
  invalidAttempts: number;
  rateLimitedAttempts: number;
  winners: number;
}

type TabId = 'overview' | 'codes' | 'winners' | 'analytics' | 'settings';

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

const STATUS_LABELS: Record<PromoCampaignStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  active: 'Active',
  paused: 'Paused',
  ended: 'Ended',
  archived: 'Archived',
};

const STATUS_COLORS: Record<PromoCampaignStatus, string> = {
  draft: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
  scheduled: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  active: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  paused: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  ended: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  archived: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500',
};

const FULFILLMENT_COLORS: Record<PromoFulfillmentStatus, string> = {
  pending: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  processing: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  fulfilled: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  cancelled: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-500',
};

function fmt(date: string | null): string {
  if (!date) return '—';
  return new Date(date).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtDate(date: string | null): string {
  if (!date) return '—';
  return new Date(date).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function maskPhone(phone: string): string {
  if (phone.length <= 6) return phone;
  return phone.slice(0, 4) + '••••' + phone.slice(-4);
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                      */
/* ------------------------------------------------------------------ */

function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`mt-2 text-2xl font-bold ${color || 'text-gray-900 dark:text-gray-100'}`}>
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">{sub}</p>}
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex justify-center py-16">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
    </div>
  );
}

function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-2xl bg-white dark:bg-gray-800 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-6 py-4">
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">{title}</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="max-h-[80vh] overflow-y-auto p-6">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Simple bar chart (no external library)                              */
/* ------------------------------------------------------------------ */

function SimpleBarChart({
  series,
  dataKey,
  label,
  color,
}: {
  series: DaySeries[];
  dataKey: keyof DaySeries;
  label: string;
  color: string;
}) {
  if (series.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-gray-200 dark:border-gray-700">
        <p className="text-sm text-gray-400 dark:text-gray-500">No data yet</p>
      </div>
    );
  }

  const values = series.map((d) => Number(d[dataKey]));
  const max = Math.max(...values, 1);

  return (
    <div>
      <p className="mb-3 text-sm font-medium text-gray-700 dark:text-gray-300">{label}</p>
      <div className="flex items-end gap-1 overflow-x-auto pb-2" style={{ height: '120px' }}>
        {series.map((d, i) => {
          const val = Number(d[dataKey]);
          const heightPct = (val / max) * 100;
          return (
            <div
              key={i}
              className="group relative flex flex-col items-center"
              style={{ minWidth: '20px', flex: 1 }}
            >
              <div
                className={`w-full rounded-t-sm ${color} opacity-80 group-hover:opacity-100 transition-opacity`}
                style={{ height: `${Math.max(heightPct, val > 0 ? 4 : 0)}%` }}
                title={`${d.date}: ${val}`}
              />
              {/* Tooltip on hover */}
              <div className="pointer-events-none absolute bottom-full mb-1 hidden group-hover:flex flex-col items-center">
                <div className="rounded bg-gray-900 px-2 py-1 text-xs text-white whitespace-nowrap">
                  {d.date}: {val}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-xs text-gray-400 dark:text-gray-500 mt-1">
        {series.length > 0 && (
          <>
            <span>{series[0].date}</span>
            <span>{series[series.length - 1].date}</span>
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                           */
/* ------------------------------------------------------------------ */

export default function PromotionDetailPage() {
  const business = useBusiness();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Core data
  const [campaign, setCampaign] = useState<CampaignDetail | null>(null);
  const [prizes, setPrizes] = useState<PromoPrize[]>([]);
  const [batches, setBatches] = useState<PromoCodeBatch[]>([]);

  // Codes tab
  const [codes, setCodes] = useState<MaskedCode[]>([]);
  const [codesLoading, setCodesLoading] = useState(false);
  const [codesPage, setCodesPage] = useState(1);
  const [codesTotalPages, setCodesTotalPages] = useState(1);
  const [codesTotal, setCodesTotal] = useState(0);
  const [codesStatusFilter, setCodesStatusFilter] = useState('');
  const [codesBatchFilter, setCodesBatchFilter] = useState('');
  const [codesSearch, setCodesSearch] = useState('');
  const codesSearchRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Winners tab
  const [winners, setWinners] = useState<Winner[]>([]);
  const [winnersLoading, setWinnersLoading] = useState(false);
  const [winnersFilter, setWinnersFilter] = useState('');

  // Analytics tab
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsStats, setAnalyticsStats] = useState<AnalyticsStats | null>(null);
  const [dailySeries, setDailySeries] = useState<DaySeries[]>([]);
  const [suspiciousPhones, setSuspiciousPhones] = useState<{ phone: string; invalidAttempts: number }[]>([]);
  const [rateLimitedCount, setRateLimitedCount] = useState(0);

  // Settings tab
  const [settingsForm, setSettingsForm] = useState<Partial<PromoCampaign>>({});
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [settingsSuccess, setSettingsSuccess] = useState(false);

  // Status transition
  const [statusChanging, setStatusChanging] = useState(false);

  // Generate batch modal
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [generateCount, setGenerateCount] = useState(1000);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState('');
  const [generateSuccess, setGenerateSuccess] = useState('');

  // Import CSV modal
  const [showImportModal, setShowImportModal] = useState(false);
  const [importCsv, setImportCsv] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [importSuccess, setImportSuccess] = useState('');
  const importFileRef = useRef<HTMLInputElement>(null);

  // Fulfillment modal
  const [fulfillmentModalWinner, setFulfillmentModalWinner] = useState<Winner | null>(null);
  const [fulfillmentStatus, setFulfillmentStatus] = useState<PromoFulfillmentStatus>('processing');
  const [fulfillmentRef, setFulfillmentRef] = useState('');
  const [fulfillmentNotes, setFulfillmentNotes] = useState('');
  const [fulfillmentSaving, setFulfillmentSaving] = useState(false);
  const [fulfillmentError, setFulfillmentError] = useState('');
  // Secure pickup verification
  const [pickupOtp, setPickupOtp] = useState('');
  const [pickupSending, setPickupSending] = useState(false);
  const [pickupVerifying, setPickupVerifying] = useState(false);
  const [pickupMessage, setPickupMessage] = useState('');

  /* ---- Fetch campaign detail ---- */

  const fetchCampaign = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/promotions/detail?businessId=${business.id}&campaignId=${id}`,
      );
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to load campaign');
        setLoading(false);
        return;
      }
      const data = await res.json();
      setCampaign(data.campaign);
      setPrizes(data.prizes || []);
      setBatches(data.batches || []);
      // Pre-fill settings form
      setSettingsForm({
        name: data.campaign.name,
        description: data.campaign.description,
        start_at: data.campaign.start_at,
        end_at: data.campaign.end_at,
        timezone: data.campaign.timezone,
        code_entry_mode: data.campaign.code_entry_mode,
        keyword: data.campaign.keyword,
        winner_message: data.campaign.winner_message,
        try_again_message: data.campaign.try_again_message,
        invalid_message: data.campaign.invalid_message,
        already_used_message: data.campaign.already_used_message,
        expired_message: data.campaign.expired_message,
        eligibility_prompt: data.campaign.eligibility_prompt,
        max_attempts_per_phone: data.campaign.max_attempts_per_phone,
        rate_limit_window_minutes: data.campaign.rate_limit_window_minutes,
        rate_limit_max_attempts: data.campaign.rate_limit_max_attempts,
      });
    } catch {
      setError('Network error. Please try again.');
    }
    setLoading(false);
  }, [business.id, id]);

  useEffect(() => {
    fetchCampaign();
  }, [fetchCampaign]);

  /* ---- Fetch codes (paginated) ---- */

  const fetchCodes = useCallback(async (page: number, status: string, batch: string, search: string) => {
    if (!campaign) return;
    setCodesLoading(true);
    try {
      const params = new URLSearchParams({
        businessId: business.id,
        campaignId: id,
        format: 'json',
        page: String(page),
        limit: '20',
      });
      if (status) params.set('status', status);
      if (batch) params.set('batchId', batch);
      if (search) params.set('search', search);
      const res = await fetch(`/api/promotions/export-codes?${params.toString()}`);
      if (!res.ok) return;
      const data = await res.json();
      setCodes(data.codes || []);
      setCodesTotalPages(data.pagination?.totalPages || 1);
      setCodesTotal(data.pagination?.total || 0);
    } catch {
      // silently fail — codes table shows empty
    }
    setCodesLoading(false);
  }, [business.id, id, campaign]);

  useEffect(() => {
    if (activeTab === 'codes' && campaign) {
      fetchCodes(codesPage, codesStatusFilter, codesBatchFilter, codesSearch);
    }
  }, [activeTab, codesPage, codesStatusFilter, codesBatchFilter, campaign]);

  /* ---- Fetch winners ---- */

  const fetchWinners = useCallback(async () => {
    if (!campaign) return;
    setWinnersLoading(true);
    try {
      const res = await fetch(
        `/api/promotions/detail?businessId=${business.id}&campaignId=${id}`,
      );
      if (!res.ok) return;
      const data = await res.json();
      // Build winners list from campaign data — in production this would be a dedicated endpoint
      // For now we re-use the redemptions data embedded in the batch detail
      // The detail API doesn't return redemptions directly, so we fetch them here
      const svcRes = await fetch(
        `/api/promotions/analytics?businessId=${business.id}&campaignId=${id}`,
      );
      // Winners are not returned by analytics; we need a dedicated call.
      // Use the detail endpoint's prize info and call fulfillment data separately.
      // Since there's no dedicated winners endpoint, we'll use a list query via export-codes
      // that filters by outcome=winner. But we actually need redemptions, not codes.
      // As a pragmatic solution, fetch from /api/promotions/detail which aggregates stats,
      // and show a note that individual winner records are available via the Winners tab data.
      // TODO: add /api/promotions/winners endpoint for full redemption list.
      setWinnersLoading(false);
    } catch {
      setWinnersLoading(false);
    }
  }, [business.id, id, campaign]);

  const fetchWinnersFromApi = useCallback(async () => {
    if (!campaign) return;
    setWinnersLoading(true);
    try {
      const params = new URLSearchParams({
        businessId: business.id,
        campaignId: id,
      });
      const res = await fetch(`/api/promotions/winners?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        // Winners API is canonical — prize_name already resolved via JOIN
        setWinners(data.winners || []);
      } else {
        setWinners([]);
      }
    } catch {
      setWinners([]);
    }
    setWinnersLoading(false);
  }, [business.id, id, campaign, prizes]);

  useEffect(() => {
    if (activeTab === 'winners' && campaign) {
      fetchWinnersFromApi();
    }
  }, [activeTab, campaign]);

  /* ---- Fetch analytics ---- */

  const fetchAnalytics = useCallback(async () => {
    if (!campaign) return;
    setAnalyticsLoading(true);
    try {
      const res = await fetch(
        `/api/promotions/analytics?businessId=${business.id}&campaignId=${id}`,
      );
      if (!res.ok) return;
      const data = await res.json();
      setAnalyticsStats(data.stats);
      setDailySeries(data.dailySeries || []);
      setSuspiciousPhones(data.suspiciousActivity?.suspiciousPhones || []);
      setRateLimitedCount(data.suspiciousActivity?.rateLimitedCount || 0);
    } catch {
      // fail silently
    }
    setAnalyticsLoading(false);
  }, [business.id, id, campaign]);

  useEffect(() => {
    if (activeTab === 'analytics' && campaign) {
      fetchAnalytics();
    }
  }, [activeTab, campaign]);

  /* ---- Status change ---- */

  const handleStatusChange = async (newStatus: string) => {
    if (!campaign) return;
    const label = STATUS_LABELS[newStatus as PromoCampaignStatus] || newStatus;
    if (!confirm(`Are you sure you want to set this campaign to "${label}"?`)) return;
    setStatusChanging(true);
    try {
      const res = await fetch('/api/promotions/update', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessId: business.id, campaignId: id, status: newStatus }),
      });
      if (!res.ok) {
        const data = await res.json();
        const errors: string[] = data.validation_errors || [];
        if (errors.length > 0) {
          alert(`Campaign cannot be activated:\n\n${errors.map((e: string) => `• ${e}`).join('\n')}`);
        } else {
          alert(data.error || 'Failed to update status');
        }
      } else {
        await fetchCampaign();
      }
    } catch {
      alert('Network error. Please try again.');
    }
    setStatusChanging(false);
  };

  /* ---- Generate codes ---- */

  const handleGenerate = async () => {
    if (!campaign) return;
    setGenerating(true);
    setGenerateError('');
    setGenerateSuccess('');
    try {
      const res = await fetch('/api/promotions/generate-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId: business.id,
          campaignId: id,
          count: generateCount,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setGenerateError(data.error || 'Generation failed');
      } else {
        setGenerateSuccess(`Generated ${data.generated.toLocaleString()} codes successfully.`);
        await fetchCampaign();
        if (activeTab === 'codes') {
          fetchCodes(1, codesStatusFilter, codesBatchFilter, codesSearch);
          setCodesPage(1);
        }
      }
    } catch {
      setGenerateError('Network error. Please try again.');
    }
    setGenerating(false);
  };

  /* ---- Import CSV ---- */

  const handleImport = async () => {
    if (!importCsv.trim()) return;
    setImporting(true);
    setImportError('');
    setImportSuccess('');
    try {
      const res = await fetch('/api/promotions/import-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId: business.id,
          campaignId: id,
          csvText: importCsv,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setImportError(data.error || 'Import failed');
      } else {
        setImportSuccess(`Imported ${data.imported.toLocaleString()} codes. ${data.duplicates > 0 ? `${data.duplicates} duplicates skipped.` : ''}`);
        await fetchCampaign();
        if (activeTab === 'codes') {
          fetchCodes(1, codesStatusFilter, codesBatchFilter, codesSearch);
          setCodesPage(1);
        }
      }
    } catch {
      setImportError('Network error. Please try again.');
    }
    setImporting(false);
  };

  /* ---- Fulfillment ---- */

  const openFulfillmentModal = (winner: Winner) => {
    setFulfillmentModalWinner(winner);
    setFulfillmentStatus('processing');
    setFulfillmentRef(winner.fulfillment_reference || '');
    setFulfillmentNotes(winner.fulfillment_notes || '');
    setFulfillmentError('');
  };

  const handleFulfillmentSave = async () => {
    if (!fulfillmentModalWinner) return;
    setFulfillmentSaving(true);
    setFulfillmentError('');
    try {
      const res = await fetch('/api/promotions/fulfillment', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId: business.id,
          redemptionId: fulfillmentModalWinner.id,
          fulfillmentStatus: fulfillmentStatus,
          fulfillmentReference: fulfillmentRef || undefined,
          fulfillmentNotes: fulfillmentNotes || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFulfillmentError(data.error || 'Failed to update fulfillment');
      } else {
        setFulfillmentModalWinner(null);
        fetchWinnersFromApi();
        fetchCampaign();
      }
    } catch {
      setFulfillmentError('Network error. Please try again.');
    }
    setFulfillmentSaving(false);
  };

  /* ---- Save settings ---- */

  const handleSettingsSave = async () => {
    if (!campaign) return;
    setSettingsSaving(true);
    setSettingsError('');
    setSettingsSuccess(false);

    // Validate max_wins_per_participant — do NOT parseInt-truncate fractions
    if (settingsForm.max_wins_per_participant !== null && settingsForm.max_wins_per_participant !== undefined) {
      const mw = Number(settingsForm.max_wins_per_participant);
      if (!Number.isFinite(mw) || !Number.isInteger(mw) || mw < 1) {
        setSettingsError('Maximum wins per participant must be a positive integer or left empty for unlimited.');
        setSettingsSaving(false);
        return;
      }
    }

    try {
      const res = await fetch('/api/promotions/update', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId: business.id,
          campaignId: id,
          name: settingsForm.name,
          description: settingsForm.description,
          startAt: settingsForm.start_at,
          endAt: settingsForm.end_at,
          timezone: settingsForm.timezone,
          codeEntryMode: settingsForm.code_entry_mode,
          keyword: settingsForm.keyword,
          winnerMessage: settingsForm.winner_message,
          tryAgainMessage: settingsForm.try_again_message,
          invalidMessage: settingsForm.invalid_message,
          alreadyUsedMessage: settingsForm.already_used_message,
          expiredMessage: settingsForm.expired_message,
          eligibilityPrompt: settingsForm.eligibility_prompt,
          maxAttemptsPerPhone: settingsForm.max_attempts_per_phone,
          rateLimitWindowMinutes: settingsForm.rate_limit_window_minutes,
          rateLimitMaxAttempts: settingsForm.rate_limit_max_attempts,
          maxWinsPerParticipant: settingsForm.max_wins_per_participant,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.error === 'keyword_conflict') {
          setSettingsError(`Keyword conflicts with campaign "${data.conflicting_campaign || 'another campaign'}". Change the keyword or deactivate the other campaign first.`);
        } else if (data.error === 'bare_code_conflict') {
          setSettingsError(`Bare-code mode conflicts with campaign "${data.conflicting_campaign || 'another campaign'}". Only one bare-code campaign can be active at a time.`);
        } else if (data.error === 'integrity_locked') {
          setSettingsError('Routing cannot be changed after codes have been redeemed.');
        } else {
          setSettingsError(data.error || 'Failed to save settings');
        }
      } else {
        setSettingsSuccess(true);
        setCampaign(data.campaign);
      }
    } catch {
      setSettingsError('Network error. Please try again.');
    }
    setSettingsSaving(false);
  };

  /* ---- Export codes CSV ---- */

  const handleExportMaskedCodes = () => {
    if (!campaign) return;
    const url = `/api/promotions/export-codes?businessId=${business.id}&campaignId=${id}`;
    window.open(url, '_blank');
  };

  const [showPrintableExportConfirm, setShowPrintableExportConfirm] = useState(false);

  const handleExportPrintableCodes = () => {
    if (!campaign) return;
    setShowPrintableExportConfirm(true);
  };

  const confirmExportPrintableCodes = () => {
    const url = `/api/promotions/export-codes?businessId=${business.id}&campaignId=${id}&export=full`;
    window.open(url, '_blank');
    setShowPrintableExportConfirm(false);
  };

  /* ---- Codes search with debounce ---- */

  const handleCodesSearch = (val: string) => {
    setCodesSearch(val);
    if (codesSearchRef.current) clearTimeout(codesSearchRef.current);
    codesSearchRef.current = setTimeout(() => {
      setCodesPage(1);
      fetchCodes(1, codesStatusFilter, codesBatchFilter, val);
    }, 400);
  };

  /* ---------------------------------------------------------------- */
  /*  Render                                                            */
  /* ---------------------------------------------------------------- */

  if (loading) {
    return (
      <div>
        {/* Skeleton header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="h-5 w-5 rounded bg-gray-200 dark:bg-gray-700 animate-pulse" />
          <div className="h-6 w-48 rounded bg-gray-200 dark:bg-gray-700 animate-pulse" />
          <div className="h-5 w-16 rounded-full bg-gray-200 dark:bg-gray-700 animate-pulse" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 rounded-xl bg-gray-100 dark:bg-gray-800 animate-pulse" />
          ))}
        </div>
        <Spinner />
      </div>
    );
  }

  if (error || !campaign) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4">
        <p className="text-lg font-semibold text-gray-700 dark:text-gray-300">
          {error || 'Campaign not found'}
        </p>
        <button
          onClick={() => router.push('/dashboard/promotions')}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          Back to Campaigns
        </button>
      </div>
    );
  }

  const currentStatus = campaign.status as PromoCampaignStatus;
  const possibleNextStatuses = (
    {
      draft: ['scheduled', 'active'],
      scheduled: ['active', 'draft', 'paused', 'ended'],
      active: ['paused', 'ended'],
      paused: ['active', 'ended'],
      ended: ['archived'],
      archived: [],
    } as Record<PromoCampaignStatus, PromoCampaignStatus[]>
  )[currentStatus] || [];

  const redemptionRate =
    campaign.total_codes > 0
      ? Math.round((campaign.verified_codes / campaign.total_codes) * 100)
      : 0;

  const tabs: { id: TabId; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'codes', label: `Codes${campaign.total_codes > 0 ? ` (${campaign.total_codes.toLocaleString()})` : ''}` },
    { id: 'winners', label: `Winners${campaign.winners_count > 0 ? ` (${campaign.winners_count})` : ''}` },
    { id: 'analytics', label: 'Analytics' },
    { id: 'settings', label: 'Settings' },
  ];

  return (
    <div>
      {/* ---- Header ---- */}
      <div className="mb-6">
        <button
          onClick={() => router.push('/dashboard/promotions')}
          className="mb-3 flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Campaigns
        </button>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{campaign.name}</h1>
            <span
              className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${STATUS_COLORS[currentStatus]}`}
            >
              {STATUS_LABELS[currentStatus]}
            </span>
            {campaign.integrity_locked && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                Integrity Locked
              </span>
            )}
          </div>

          {/* Status action buttons */}
          {possibleNextStatuses.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {possibleNextStatuses.map((next) => {
                const configs: Record<string, { label: string; cls: string }> = {
                  active: { label: currentStatus === 'paused' ? 'Resume' : 'Activate', cls: 'bg-green-600 text-white hover:bg-green-700' },
                  paused: { label: 'Pause', cls: 'bg-yellow-500 text-white hover:bg-yellow-600' },
                  ended: { label: 'End Campaign', cls: 'border border-red-300 text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20' },
                  archived: { label: 'Archive', cls: 'border border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700/50' },
                  scheduled: { label: 'Schedule', cls: 'bg-blue-600 text-white hover:bg-blue-700' },
                  draft: { label: 'Revert to Draft', cls: 'border border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400' },
                };
                const cfg = configs[next] || { label: next, cls: 'bg-brand text-white' };
                return (
                  <button
                    key={next}
                    onClick={() => handleStatusChange(next)}
                    disabled={statusChanging}
                    className={`rounded-lg px-4 py-2 text-sm font-medium transition disabled:opacity-50 ${cfg.cls}`}
                  >
                    {cfg.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {campaign.description && (
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{campaign.description}</p>
        )}
      </div>

      {/* ---- Tab navigation ---- */}
      <div className="mb-6 border-b border-gray-200 dark:border-gray-700">
        <nav className="-mb-px flex gap-0 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? 'border-brand text-brand'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* ======================================================= */}
      {/* OVERVIEW TAB                                             */}
      {/* ======================================================= */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Campaign dates */}
          <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Campaign Dates</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <div>
                <p className="text-xs text-gray-400 dark:text-gray-500">Start Date</p>
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{fmtDate(campaign.start_at)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400 dark:text-gray-500">End Date</p>
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{fmtDate(campaign.end_at)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400 dark:text-gray-500">Timezone</p>
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{campaign.timezone}</p>
              </div>
            </div>
          </div>

          {/* Summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <StatCard label="Total Codes" value={campaign.total_codes.toLocaleString()} />
            <StatCard
              label="Verified / Claimed"
              value={campaign.verified_codes.toLocaleString()}
              color="text-green-600 dark:text-green-400"
            />
            <StatCard label="Unused" value={campaign.unused_codes.toLocaleString()} />
            <StatCard
              label="Winners"
              value={campaign.winners_count.toLocaleString()}
              color="text-brand"
            />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <StatCard
              label="Fulfilled"
              value={campaign.fulfilled_count.toLocaleString()}
              color="text-green-600 dark:text-green-400"
            />
            <StatCard
              label="Pending Fulfillment"
              value={campaign.pending_fulfillment.toLocaleString()}
              color={campaign.pending_fulfillment > 0 ? 'text-yellow-600 dark:text-yellow-400' : undefined}
            />
            <StatCard
              label="Invalid Attempts"
              value={campaign.invalid_attempts.toLocaleString()}
              color={campaign.invalid_attempts > 10 ? 'text-red-600 dark:text-red-400' : undefined}
            />
            <StatCard label="Unique Participants" value={(campaign.unique_participants ?? 0).toLocaleString()} />
          </div>

          {/* Redemption rate progress bar */}
          {campaign.total_codes > 0 && (
            <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Redemption Rate</h3>
                <span className="text-sm font-bold text-brand">{redemptionRate}%</span>
              </div>
              <div className="h-3 w-full rounded-full bg-gray-100 dark:bg-gray-700">
                <div
                  className="h-3 rounded-full bg-brand transition-all duration-500"
                  style={{ width: `${redemptionRate}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
                {campaign.verified_codes.toLocaleString()} of {campaign.total_codes.toLocaleString()} codes claimed
              </p>
            </div>
          )}

          {/* Prizes */}
          {prizes.length > 0 && (
            <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Prizes</h3>
              <div className="divide-y divide-gray-50 dark:divide-gray-700">
                {prizes.map((prize) => (
                  <div key={prize.id} className="flex items-center justify-between py-3">
                    <div>
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{prize.name}</p>
                      <p className="text-xs text-gray-400 dark:text-gray-500 capitalize">{prize.prize_type}</p>
                      <p className="text-xs text-gray-400 dark:text-gray-500">
                        {(prize as unknown as { verification_mode?: string }).verification_mode === 'secure_pickup' ? 'Secure Pickup' : 'Standard'} verification
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-gray-700 dark:text-gray-300">
                        {prize.allocated_count} / {prize.quantity} allocated
                      </p>
                      {prize.value && (
                        <p className="text-xs text-gray-400 dark:text-gray-500">
                          {prize.currency} {prize.value.toLocaleString()}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ======================================================= */}
      {/* CODES TAB                                                */}
      {/* ======================================================= */}
      {activeTab === 'codes' && (
        <div className="space-y-4">
          {/* Batch list */}
          {batches.length > 0 && (
            <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
                Code Batches ({batches.length})
              </h3>
              <div className="divide-y divide-gray-50 dark:divide-gray-700">
                {batches.map((batch) => (
                  <div
                    key={batch.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2.5"
                  >
                    <div>
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium mr-2 ${
                          batch.status === 'completed'
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : batch.status === 'failed'
                            ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                            : batch.status === 'processing'
                            ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                            : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                        }`}
                      >
                        {batch.status}
                      </span>
                      <span className="text-xs text-gray-500 dark:text-gray-400 capitalize">{batch.source}</span>
                      {batch.filename && (
                        <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">{batch.filename}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
                      <span>{batch.generated_count.toLocaleString()} codes</span>
                      {batch.failed_count > 0 && (
                        <span className="text-red-500">{batch.failed_count} failed</span>
                      )}
                      <span>{fmtDate(batch.created_at)}</span>
                      <button
                        onClick={() => {
                          setCodesBatchFilter(batch.id);
                          setCodesPage(1);
                          fetchCodes(1, codesStatusFilter, batch.id, codesSearch);
                        }}
                        className="text-brand hover:underline"
                      >
                        View
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Actions bar */}
          <div className="flex flex-wrap items-center gap-3">
            {(() => {
              const canModifyCodes =
                (campaign.status === 'draft' || campaign.status === 'scheduled') &&
                !campaign.integrity_locked;
              const inventoryTooltip = canModifyCodes
                ? undefined
                : 'Code inventory can only be modified for draft or scheduled campaigns';
              return (
                <>
                  <span title={inventoryTooltip}>
                    <button
                      onClick={() => {
                        setShowGenerateModal(true);
                        setGenerateError('');
                        setGenerateSuccess('');
                      }}
                      disabled={!canModifyCodes}
                      className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Generate Batch
                    </button>
                  </span>
                  <span title={inventoryTooltip}>
                    <button
                      onClick={() => {
                        setShowImportModal(true);
                        setImportCsv('');
                        setImportError('');
                        setImportSuccess('');
                      }}
                      disabled={!canModifyCodes}
                      className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Import CSV
                    </button>
                  </span>
                </>
              );
            })()}
            <button
              onClick={handleExportMaskedCodes}
              className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
            >
              Export Masked Codes
            </button>
            <button
              onClick={handleExportPrintableCodes}
              className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
            >
              Export Printable Codes
            </button>

            {/* Search */}
            <div className="ml-auto">
              <input
                type="text"
                placeholder="Search by code..."
                value={codesSearch}
                onChange={(e) => handleCodesSearch(e.target.value)}
                className="rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand w-48"
              />
            </div>

            {/* Status filter */}
            <select
              value={codesStatusFilter}
              onChange={(e) => {
                setCodesStatusFilter(e.target.value);
                setCodesPage(1);
                fetchCodes(1, e.target.value, codesBatchFilter, codesSearch);
              }}
              className="rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
            >
              <option value="">All statuses</option>
              <option value="unused">Unused</option>
              <option value="claimed">Claimed</option>
              <option value="void">Void</option>
              <option value="winner">Winners (claimed)</option>
              <option value="try_again">Try Again (claimed)</option>
            </select>

            {codesBatchFilter && (
              <button
                onClick={() => {
                  setCodesBatchFilter('');
                  fetchCodes(codesPage, codesStatusFilter, '', codesSearch);
                }}
                className="text-xs text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
              >
                Clear batch filter
              </button>
            )}
          </div>

          {/* Codes table */}
          {codesLoading ? (
            <Spinner />
          ) : codes.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-200 dark:border-gray-700 p-12 text-center">
              <p className="text-sm text-gray-400 dark:text-gray-500">
                {campaign.total_codes === 0
                  ? 'No codes yet. Generate or import a batch to get started.'
                  : 'No codes match your filters.'}
              </p>
            </div>
          ) : (
            <div>
              <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-x-auto">
                <table className="w-full min-w-[500px] text-sm">
                  <thead className="border-b border-gray-50 dark:border-gray-700">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Code</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Outcome</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Status</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Claimed At</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50 dark:divide-gray-700">
                    {codes.map((code) => (
                      <tr key={code.id} className="hover:bg-gray-50/50 dark:hover:bg-gray-700/20">
                        <td className="px-4 py-3 font-mono text-sm text-gray-700 dark:text-gray-300">
                          {code.displayCode}
                        </td>
                        <td className="px-4 py-3">
                          {code.outcome ? (
                            <span
                              className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                                code.outcome === 'winner'
                                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                                  : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                              }`}
                            >
                              {code.outcome === 'winner' ? 'Winner' : 'Try Again'}
                            </span>
                          ) : (
                            <span className="text-xs text-gray-400 dark:text-gray-500">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                              code.status === 'claimed'
                                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                                : code.status === 'void'
                                ? 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'
                                : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
                            }`}
                          >
                            {code.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                          {code.claimed_at ? fmt(code.claimed_at) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="mt-3 flex items-center justify-between text-sm">
                <p className="text-xs text-gray-400 dark:text-gray-500">
                  {codesTotal.toLocaleString()} codes total
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      const p = Math.max(1, codesPage - 1);
                      setCodesPage(p);
                      fetchCodes(p, codesStatusFilter, codesBatchFilter, codesSearch);
                    }}
                    disabled={codesPage === 1}
                    className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <span className="text-gray-500 dark:text-gray-400">
                    {codesPage} / {codesTotalPages}
                  </span>
                  <button
                    onClick={() => {
                      const p = Math.min(codesTotalPages, codesPage + 1);
                      setCodesPage(p);
                      fetchCodes(p, codesStatusFilter, codesBatchFilter, codesSearch);
                    }}
                    disabled={codesPage === codesTotalPages}
                    className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ======================================================= */}
      {/* WINNERS TAB                                              */}
      {/* ======================================================= */}
      {activeTab === 'winners' && (
        <div className="space-y-4">
          {/* Filter */}
          <div className="flex items-center gap-3">
            <select
              value={winnersFilter}
              onChange={(e) => setWinnersFilter(e.target.value)}
              className="rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
            >
              <option value="">All fulfillment statuses</option>
              <option value="pending">Pending</option>
              <option value="processing">Processing</option>
              <option value="fulfilled">Fulfilled</option>
              <option value="rejected">Rejected</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>

          {winnersLoading ? (
            <Spinner />
          ) : campaign.winners_count === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-200 dark:border-gray-700 p-12 text-center">
              <p className="text-sm text-gray-400 dark:text-gray-500">No winners yet.</p>
            </div>
          ) : winners.length === 0 ? (
            <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 text-center">
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">
                This campaign has {campaign.winners_count} winner{campaign.winners_count !== 1 ? 's' : ''}.
              </p>
              <p className="text-xs text-gray-400 dark:text-gray-500">
                A dedicated winners API endpoint is required to display the full table.
                The winners count is confirmed in the Overview tab.
              </p>
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
                Pending fulfillment: <strong>{campaign.pending_fulfillment}</strong>
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-x-auto">
              <table className="w-full min-w-[850px] text-sm">
                <thead className="border-b border-gray-50 dark:border-gray-700">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Participant</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Redeemed Code</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Prize</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Claim Ref</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Claimed At</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Verification</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Fulfillment</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50 dark:divide-gray-700">
                  {(winnersFilter
                    ? winners.filter((w) => w.fulfillment_status === winnersFilter)
                    : winners
                  ).map((winner) => (
                    <tr key={winner.id} className="hover:bg-gray-50/50 dark:hover:bg-gray-700/20">
                      <td className="px-4 py-3 font-mono text-xs text-gray-700 dark:text-gray-300">
                        {winner.phone_e164}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-700 dark:text-gray-300">
                        {winner.redeemed_code || '—'}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
                        {winner.prize_name || '—'}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">
                        {winner.claim_reference}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                        {fmt(winner.claimed_at)}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {winner.verification_mode === 'secure_pickup' ? (
                          <span className={`inline-flex rounded-full px-2 py-0.5 font-medium ${
                            winner.verification_status === 'verified' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : winner.verification_status === 'locked' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                            : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                          }`}>
                            {winner.verification_status === 'verified' ? 'Pickup verified'
                              : winner.verification_status === 'locked' ? 'Locked'
                              : 'Pickup required'}
                          </span>
                        ) : (
                          <span className="text-gray-400 dark:text-gray-500">Standard</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${FULFILLMENT_COLORS[winner.fulfillment_status]}`}
                        >
                          {winner.fulfillment_status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => openFulfillmentModal(winner)}
                          className="text-xs text-brand hover:underline"
                        >
                          Update
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ======================================================= */}
      {/* ANALYTICS TAB                                            */}
      {/* ======================================================= */}
      {activeTab === 'analytics' && (
        <div className="space-y-6">
          {analyticsLoading ? (
            <Spinner />
          ) : !analyticsStats ? (
            <div className="rounded-xl border border-dashed border-gray-200 dark:border-gray-700 p-12 text-center">
              <p className="text-sm text-gray-400 dark:text-gray-500">No analytics data yet.</p>
            </div>
          ) : (
            <>
              {/* Stats cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <StatCard label="Total Attempts" value={analyticsStats.totalAttempts.toLocaleString()} />
                <StatCard
                  label="Valid Codes"
                  value={analyticsStats.validAttempts.toLocaleString()}
                  color="text-green-600 dark:text-green-400"
                />
                <StatCard
                  label="Invalid Attempts"
                  value={analyticsStats.invalidAttempts.toLocaleString()}
                  color={analyticsStats.invalidAttempts > 10 ? 'text-red-600 dark:text-red-400' : undefined}
                />
                <StatCard label="Unique Participants" value={analyticsStats.uniqueParticipants.toLocaleString()} />
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                <StatCard
                  label="Winners"
                  value={analyticsStats.winners.toLocaleString()}
                  color="text-brand"
                />
                <StatCard
                  label="Claim Rate"
                  value={`${analyticsStats.claimRate}%`}
                  sub="winners / total attempts"
                />
                <StatCard
                  label="Fulfillment Rate"
                  value={`${analyticsStats.fulfillmentRate}%`}
                  sub="fulfilled / winners"
                  color={analyticsStats.fulfillmentRate === 100 ? 'text-green-600 dark:text-green-400' : undefined}
                />
              </div>

              {/* Charts */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
                  <SimpleBarChart
                    series={dailySeries}
                    dataKey="attempts"
                    label="Verification Attempts Over Time"
                    color="bg-blue-400 dark:bg-blue-500"
                  />
                </div>
                <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
                  <SimpleBarChart
                    series={dailySeries}
                    dataKey="winners"
                    label="Winners Over Time"
                    color="bg-green-400 dark:bg-green-500"
                  />
                </div>
              </div>

              {/* Invalid attempts chart */}
              <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
                <SimpleBarChart
                  series={dailySeries}
                  dataKey="invalidAttempts"
                  label="Invalid Attempts Over Time"
                  color="bg-red-400 dark:bg-red-500"
                />
              </div>

              {/* Suspicious activity */}
              <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
                  Suspicious Activity
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                  <div className="rounded-lg bg-yellow-50 dark:bg-yellow-900/20 p-4">
                    <p className="text-xs text-yellow-600 dark:text-yellow-400">Rate-Limited Attempts</p>
                    <p className="mt-1 text-2xl font-bold text-yellow-700 dark:text-yellow-400">
                      {rateLimitedCount.toLocaleString()}
                    </p>
                  </div>
                </div>
                {suspiciousPhones.length === 0 ? (
                  <p className="text-sm text-gray-400 dark:text-gray-500">No suspicious activity detected.</p>
                ) : (
                  <div>
                    <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
                      Phones with 3+ invalid attempts:
                    </p>
                    <div className="space-y-2">
                      {suspiciousPhones.map((entry, i) => (
                        <div
                          key={i}
                          className="flex items-center justify-between rounded-lg bg-red-50 dark:bg-red-900/20 px-4 py-2"
                        >
                          <span className="font-mono text-sm text-red-700 dark:text-red-400">
                            {entry.phone}
                          </span>
                          <span className="text-sm font-medium text-red-600 dark:text-red-400">
                            {entry.invalidAttempts} invalid attempts
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ======================================================= */}
      {/* SETTINGS TAB                                             */}
      {/* ======================================================= */}
      {activeTab === 'settings' && (
        <div className="space-y-6">
          {campaign.integrity_locked && (
            <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-4 flex items-start gap-3">
              <svg className="h-5 w-5 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              <div>
                <p className="text-sm font-medium text-amber-800 dark:text-amber-300">Integrity Lock Active</p>
                <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">
                  This campaign has had redemptions. Fraud-config and eligibility fields are locked to ensure fairness. You can still update campaign messages and dates.
                </p>
              </div>
            </div>
          )}

          <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 space-y-5">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Campaign Info</h3>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Campaign Name</label>
              <input
                type="text"
                value={settingsForm.name || ''}
                onChange={(e) => setSettingsForm((f) => ({ ...f, name: e.target.value }))}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
              <textarea
                value={settingsForm.description || ''}
                onChange={(e) => setSettingsForm((f) => ({ ...f, description: e.target.value }))}
                rows={3}
                className="w-full resize-none rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
              />
            </div>

            {/* Dates — only editable if not integrity locked */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="flex items-center gap-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Start Date
                  {campaign.integrity_locked && (
                    <svg className="h-3.5 w-3.5 text-amber-500" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                    </svg>
                  )}
                </label>
                <input
                  type="datetime-local"
                  value={settingsForm.start_at ? settingsForm.start_at.slice(0, 16) : ''}
                  onChange={(e) => setSettingsForm((f) => ({ ...f, start_at: e.target.value ? new Date(e.target.value).toISOString() : null }))}
                  disabled={campaign.integrity_locked}
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand disabled:opacity-50 disabled:cursor-not-allowed"
                />
              </div>
              <div>
                <label className="flex items-center gap-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  End Date
                  {campaign.integrity_locked && (
                    <svg className="h-3.5 w-3.5 text-amber-500" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                    </svg>
                  )}
                </label>
                <input
                  type="datetime-local"
                  value={settingsForm.end_at ? settingsForm.end_at.slice(0, 16) : ''}
                  onChange={(e) => setSettingsForm((f) => ({ ...f, end_at: e.target.value ? new Date(e.target.value).toISOString() : null }))}
                  disabled={campaign.integrity_locked}
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand disabled:opacity-50 disabled:cursor-not-allowed"
                />
              </div>
            </div>
          </div>

          {/* Campaign Routing */}
          <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 space-y-5">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Campaign Routing</h3>
              {campaign.integrity_locked && (
                <svg className="h-4 w-4 text-amber-500" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                </svg>
              )}
            </div>

            {campaign.integrity_locked && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Routing cannot be changed after codes have been redeemed.
              </p>
            )}

            {!campaign.integrity_locked && (campaign.status === 'active' || campaign.status === 'paused') && (
              <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-3 text-xs text-blue-700 dark:text-blue-400">
                Changing routing takes effect immediately. The old keyword will stop working.
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Entry Mode</label>
              <select
                value={settingsForm.code_entry_mode || campaign.code_entry_mode}
                onChange={(e) => setSettingsForm((f) => ({ ...f, code_entry_mode: e.target.value as PromoCampaign['code_entry_mode'] }))}
                disabled={campaign.integrity_locked}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <option value="keyword">Keyword only</option>
                <option value="bare_code">Bare code only</option>
                <option value="both">Both (keyword + bare code)</option>
              </select>
              <p className="mt-0.5 text-xs text-gray-400">
                {(settingsForm.code_entry_mode || campaign.code_entry_mode) === 'keyword'
                  ? 'Users send: KEYWORD CODE (e.g. PROMO K7PM-4XQ9)'
                  : (settingsForm.code_entry_mode || campaign.code_entry_mode) === 'bare_code'
                    ? 'Users send the code directly (e.g. K7PM-4XQ9)'
                    : 'Users can send KEYWORD CODE or just the code directly'}
              </p>
            </div>

            {(settingsForm.code_entry_mode || campaign.code_entry_mode) !== 'bare_code' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Keyword</label>
                <input
                  type="text"
                  value={settingsForm.keyword ?? campaign.keyword ?? ''}
                  onChange={(e) => setSettingsForm((f) => ({ ...f, keyword: e.target.value.toUpperCase() }))}
                  disabled={campaign.integrity_locked}
                  placeholder="e.g. PROMO"
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand disabled:opacity-50 disabled:cursor-not-allowed uppercase"
                />
                <p className="mt-0.5 text-xs text-gray-400">The trigger word users type before their code.</p>
              </div>
            )}
          </div>

          {/* Messages */}
          <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 space-y-5">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Campaign Messages</h3>
            {(
              [
                { key: 'winner_message', label: 'Winner Message' },
                { key: 'try_again_message', label: 'Try Again Message' },
                { key: 'invalid_message', label: 'Invalid Code Message' },
                { key: 'already_used_message', label: 'Already Used Message' },
                { key: 'expired_message', label: 'Expired Message' },
              ] as { key: keyof typeof settingsForm; label: string }[]
            ).map(({ key, label }) => (
              <div key={key}>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{label}</label>
                <textarea
                  value={(settingsForm[key] as string) || ''}
                  onChange={(e) => setSettingsForm((f) => ({ ...f, [key]: e.target.value }))}
                  rows={2}
                  className="w-full resize-none rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
                />
              </div>
            ))}

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Eligibility Prompt</label>
              <textarea
                value={(settingsForm.eligibility_prompt as string) || ''}
                onChange={(e) => setSettingsForm((f) => ({ ...f, eligibility_prompt: e.target.value }))}
                rows={2}
                placeholder="Optional eligibility question shown to participants..."
                className="w-full resize-none rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
              />
            </div>
          </div>

          {/* Fraud config */}
          <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 space-y-5">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Fraud & Rate Limiting</h3>
              {campaign.integrity_locked && (
                <svg className="h-4 w-4 text-amber-500" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                </svg>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Max Attempts / Phone
                </label>
                <input
                  type="number"
                  min={1}
                  value={settingsForm.max_attempts_per_phone ?? campaign.max_attempts_per_phone}
                  onChange={(e) => setSettingsForm((f) => ({ ...f, max_attempts_per_phone: parseInt(e.target.value, 10) }))}
                  disabled={campaign.integrity_locked}
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand disabled:opacity-50 disabled:cursor-not-allowed"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Rate Limit Window (mins)
                </label>
                <input
                  type="number"
                  min={1}
                  value={settingsForm.rate_limit_window_minutes ?? campaign.rate_limit_window_minutes}
                  onChange={(e) => setSettingsForm((f) => ({ ...f, rate_limit_window_minutes: parseInt(e.target.value, 10) }))}
                  disabled={campaign.integrity_locked}
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand disabled:opacity-50 disabled:cursor-not-allowed"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Rate Limit Max Attempts
                </label>
                <input
                  type="number"
                  min={1}
                  value={settingsForm.rate_limit_max_attempts ?? campaign.rate_limit_max_attempts}
                  onChange={(e) => setSettingsForm((f) => ({ ...f, rate_limit_max_attempts: parseInt(e.target.value, 10) }))}
                  disabled={campaign.integrity_locked}
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand disabled:opacity-50 disabled:cursor-not-allowed"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Max Wins / Participant
                </label>
                <input
                  type="number"
                  min={1}
                  value={settingsForm.max_wins_per_participant ?? campaign.max_wins_per_participant ?? ''}
                  onChange={(e) => setSettingsForm((f) => ({ ...f, max_wins_per_participant: e.target.value === '' ? null : Number(e.target.value) as unknown as number }))}
                  disabled={campaign.integrity_locked}
                  placeholder="Unlimited"
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand disabled:opacity-50 disabled:cursor-not-allowed"
                />
                <p className="mt-0.5 text-xs text-gray-400">Leave empty for unlimited.</p>
              </div>
            </div>
          </div>

          {/* Save button */}
          {settingsError && (
            <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-400">
              {settingsError}
            </div>
          )}
          {settingsSuccess && (
            <div className="rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 p-3 text-sm text-green-700 dark:text-green-400">
              Settings saved successfully.
            </div>
          )}

          <button
            onClick={handleSettingsSave}
            disabled={settingsSaving}
            className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {settingsSaving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      )}

      {/* ======================================================= */}
      {/* MODALS                                                   */}
      {/* ======================================================= */}

      {/* Generate Batch Modal */}
      <Modal
        open={showGenerateModal}
        onClose={() => setShowGenerateModal(false)}
        title="Generate Code Batch"
      >
        <div className="space-y-4">
          <div className="rounded-lg bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 px-3 py-2.5 space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-500 dark:text-gray-400">Code length</span>
              <span className="font-mono font-medium text-gray-900 dark:text-gray-100">
                {campaign.code_length}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-500 dark:text-gray-400">Prefix</span>
              <span className="font-mono font-medium text-gray-900 dark:text-gray-100">
                {campaign.code_prefix || <span className="text-gray-400 dark:text-gray-500 font-normal">None</span>}
              </span>
            </div>
            <p className="text-xs text-gray-400 dark:text-gray-500 pt-0.5">Code length includes prefix.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Number of Codes
            </label>
            <input
              type="number"
              min={1}
              max={50000}
              value={generateCount}
              onChange={(e) => setGenerateCount(parseInt(e.target.value, 10))}
              className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
            />
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">Max 50,000 per batch</p>
          </div>

          {generateError && (
            <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-400">
              {generateError}
            </div>
          )}
          {generateSuccess && (
            <div className="rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 p-3 text-sm text-green-700 dark:text-green-400">
              {generateSuccess}
            </div>
          )}

          <button
            onClick={handleGenerate}
            disabled={generating || !generateCount || generateCount < 1}
            className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {generating ? 'Generating...' : `Generate ${generateCount?.toLocaleString() || 0} Codes`}
          </button>
        </div>
      </Modal>

      {/* Import CSV Modal */}
      <Modal
        open={showImportModal}
        onClose={() => setShowImportModal(false)}
        title="Import Codes from CSV"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Paste CSV data or upload a file. Each row should contain a campaign code (and optionally outcome: winner/try_again).
          </p>

          <div
            className="rounded-xl border-2 border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800/50 p-4 text-center"
            onClick={() => importFileRef.current?.click()}
          >
            <input
              ref={importFileRef}
              type="file"
              accept=".csv,.txt"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => setImportCsv(ev.target?.result as string);
                reader.readAsText(file);
                e.target.value = '';
              }}
            />
            <p className="text-sm text-brand hover:underline cursor-pointer">Choose CSV file</p>
          </div>

          <textarea
            value={importCsv}
            onChange={(e) => setImportCsv(e.target.value)}
            rows={8}
            placeholder={`code,outcome\nK7PM4XQ9N2WF,winner\nABCD1234EFGH,try_again`}
            className="w-full resize-none rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 font-mono text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
          />

          {importError && (
            <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-400">
              {importError}
            </div>
          )}
          {importSuccess && (
            <div className="rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 p-3 text-sm text-green-700 dark:text-green-400">
              {importSuccess}
            </div>
          )}

          <button
            onClick={handleImport}
            disabled={importing || !importCsv.trim()}
            className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {importing ? 'Importing...' : 'Import Codes'}
          </button>
        </div>
      </Modal>

      {/* Printable Export Confirmation Modal */}
      <Modal
        open={showPrintableExportConfirm}
        onClose={() => setShowPrintableExportConfirm(false)}
        title="Export Printable Codes"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            Are you sure you want to export printable codes?
          </p>
          <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 p-3">
            <p className="text-sm text-amber-800 dark:text-amber-300">
              This export contains the actual campaign codes in plaintext.
              These codes are sensitive and should be handled securely.
            </p>
          </div>
          <div className="flex gap-3 justify-end">
            <button
              onClick={() => setShowPrintableExportConfirm(false)}
              className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
            >
              Cancel
            </button>
            <button
              onClick={confirmExportPrintableCodes}
              className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              Export Printable Codes
            </button>
          </div>
        </div>
      </Modal>

      {/* Fulfillment Modal */}
      <Modal
        open={!!fulfillmentModalWinner}
        onClose={() => setFulfillmentModalWinner(null)}
        title="Update Fulfillment"
      >
        {fulfillmentModalWinner && (
          <div className="space-y-4">
            <div className="rounded-lg bg-gray-50 dark:bg-gray-800/50 p-3 text-sm">
              <p className="text-gray-500 dark:text-gray-400">
                Participant: <span className="font-mono text-gray-700 dark:text-gray-300">{fulfillmentModalWinner.phone_e164}</span>
              </p>
              <p className="text-gray-500 dark:text-gray-400">
                Prize: <span className="font-medium text-gray-700 dark:text-gray-300">{fulfillmentModalWinner.prize_name || '—'}</span>
              </p>
              <p className="text-gray-500 dark:text-gray-400">
                Claim Ref: <span className="font-mono text-gray-700 dark:text-gray-300">{fulfillmentModalWinner.claim_reference}</span>
              </p>
              <p className="text-gray-500 dark:text-gray-400">
                Current Status:{' '}
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${FULFILLMENT_COLORS[fulfillmentModalWinner.fulfillment_status]}`}
                >
                  {fulfillmentModalWinner.fulfillment_status}
                </span>
              </p>
              <p className="text-gray-500 dark:text-gray-400">
                Verification:{' '}
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  {fulfillmentModalWinner.verification_mode === 'secure_pickup'
                    ? fulfillmentModalWinner.verification_status === 'verified'
                      ? 'Pickup verified'
                      : fulfillmentModalWinner.verification_status === 'locked'
                        ? 'Verification locked — send new code'
                        : 'Pickup verification required'
                    : 'Standard verified'}
                </span>
              </p>
            </div>

            {/* Secure Pickup Verification Actions */}
            {fulfillmentModalWinner.verification_mode === 'secure_pickup' && fulfillmentModalWinner.verification_status !== 'verified' && (
              <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-3 space-y-3">
                <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
                  Secure pickup verification is required before fulfillment.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={async () => {
                      setPickupSending(true);
                      setPickupMessage('');
                      try {
                        const res = await fetch('/api/promotions/verification/send', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ businessId: business.id, redemptionId: fulfillmentModalWinner.id }),
                        });
                        const data = await res.json();
                        if (res.ok && data.sent) {
                          setPickupMessage('Verification code sent to winner\'s WhatsApp.');
                          // If was locked, issue resets to phone_verified — update modal
                          setFulfillmentModalWinner((prev) => prev?.verification_status === 'locked' ? { ...prev, verification_status: 'phone_verified' } : prev);
                        } else if (data.already_verified) {
                          setPickupMessage('Already verified!');
                          setFulfillmentModalWinner((prev) => prev ? { ...prev, verification_status: 'verified' } : null);
                          fetchWinnersFromApi();
                        } else {
                          setPickupMessage(data.error || 'Failed to send code.');
                        }
                      } catch { setPickupMessage('Network error.'); }
                      setPickupSending(false);
                    }}
                    disabled={pickupSending}
                    className="rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {pickupSending ? 'Sending...' : 'Send Pickup Code'}
                  </button>
                </div>
                <div className="flex gap-2 items-center">
                  <input
                    type="text"
                    value={pickupOtp}
                    onChange={(e) => setPickupOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="6-digit code"
                    maxLength={6}
                    className="w-28 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm font-mono text-center tracking-widest text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
                  />
                  <button
                    onClick={async () => {
                      if (pickupOtp.length !== 6) return;
                      setPickupVerifying(true);
                      setPickupMessage('');
                      try {
                        const res = await fetch('/api/promotions/verification/verify', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ businessId: business.id, redemptionId: fulfillmentModalWinner.id, token: pickupOtp }),
                        });
                        const data = await res.json();
                        if (res.ok && data.verified) {
                          setPickupMessage('Verified successfully!');
                          setPickupOtp('');
                          // Update modal winner state immediately so fulfillment becomes available
                          setFulfillmentModalWinner((prev) => prev ? { ...prev, verification_status: 'verified', verified_at: new Date().toISOString() } : null);
                          fetchWinnersFromApi();
                        } else {
                          setPickupMessage(data.error || 'Verification failed.');
                        }
                      } catch { setPickupMessage('Network error.'); }
                      setPickupVerifying(false);
                    }}
                    disabled={pickupVerifying || pickupOtp.length !== 6}
                    className="rounded-lg bg-green-600 px-3 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {pickupVerifying ? 'Verifying...' : 'Verify Code'}
                  </button>
                </div>
                {pickupMessage && (
                  <p className="text-xs text-gray-600 dark:text-gray-400">{pickupMessage}</p>
                )}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                New Status
              </label>
              <select
                value={fulfillmentStatus}
                onChange={(e) => setFulfillmentStatus(e.target.value as PromoFulfillmentStatus)}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
              >
                {(
                  {
                    pending: ['processing', 'fulfilled', 'rejected', 'cancelled'],
                    processing: ['fulfilled', 'rejected', 'cancelled'],
                    fulfilled: [],
                    rejected: [],
                    cancelled: [],
                  } as Record<PromoFulfillmentStatus, PromoFulfillmentStatus[]>
                )[fulfillmentModalWinner.fulfillment_status].map((s) => (
                  <option key={s} value={s}>
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Fulfillment Reference (optional)
              </label>
              <input
                type="text"
                value={fulfillmentRef}
                onChange={(e) => setFulfillmentRef(e.target.value)}
                placeholder="e.g. transfer ID, tracking number..."
                className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Notes (optional)
              </label>
              <textarea
                value={fulfillmentNotes}
                onChange={(e) => setFulfillmentNotes(e.target.value)}
                rows={3}
                placeholder="Internal notes about this fulfillment..."
                className="w-full resize-none rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
              />
            </div>

            {fulfillmentError && (
              <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-400">
                {fulfillmentError}
              </div>
            )}

            {(
              {
                pending: ['processing', 'fulfilled', 'rejected', 'cancelled'],
                processing: ['fulfilled', 'rejected', 'cancelled'],
                fulfilled: [],
                rejected: [],
                cancelled: [],
              } as Record<PromoFulfillmentStatus, PromoFulfillmentStatus[]>
            )[fulfillmentModalWinner.fulfillment_status].length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-2">
                This fulfillment record is in a terminal state and cannot be changed.
              </p>
            ) : (
              <>
                <button
                  onClick={handleFulfillmentSave}
                  disabled={fulfillmentSaving || (
                    fulfillmentStatus === 'fulfilled' &&
                    fulfillmentModalWinner?.verification_mode === 'secure_pickup' &&
                    fulfillmentModalWinner?.verification_status !== 'verified'
                  )}
                  className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
                >
                  {fulfillmentSaving ? 'Saving...' : 'Update Fulfillment'}
                </button>
                {fulfillmentStatus === 'fulfilled' &&
                  fulfillmentModalWinner?.verification_mode === 'secure_pickup' &&
                  fulfillmentModalWinner?.verification_status !== 'verified' && (
                  <p className="mt-2 text-xs text-amber-600 dark:text-amber-400 text-center">
                    Verify pickup code before fulfillment.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

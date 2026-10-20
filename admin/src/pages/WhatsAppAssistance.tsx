import { useCallback, useEffect, useState } from 'react';
import { adminApiFetch, adminApiGet } from '@/lib/adminApi';
import { useAdminSession } from '@/components/AdminLayout';
import { hasAccess } from '@/lib/permissions';
import { useStepUp } from '@/hooks/useStepUp';
import { StepUpDialog } from '@/components/StepUpDialog';
import { QRCodeSVG } from 'qrcode.react';

interface WhatsAppSetup {
  requested_method: string;
  current_method: string | null;
  business_status: string | null;
  messaging_suspended: boolean;
  country_code: string | null;
  bot_code: string | null;
  channel_ready: boolean;
  whatsapp_link: string | null;
  channel_type: string | null;
  connection_status: string | null;
  owner_connection_required: boolean;
}
interface Onboarding {
  id: string;
  target_email: string;
  business_id: string | null;
  status: string;
  whatsapp_setup?: WhatsAppSetup;
}

export default function WhatsAppAssistance() {
  const [rows, setRows] = useState<Onboarding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingStepUpAction, setPendingStepUpAction] = useState<((stepUpId: string) => Promise<void>) | null>(null);
  const session = useAdminSession();
  const stepUp = useStepUp();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await adminApiGet('/api/admin/onboarding');
      if (!response.ok) throw new Error('Unable to load assisted onboarding status.');
      const body = await response.json();
      if (!Array.isArray(body.onboardings)) throw new Error('Unexpected onboarding response.');
      setRows(body.onboardings);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load setup status.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function sendOwnerInstructions(row: Onboarding) {
    if (!row.business_id || busyId) return;
    setBusyId(row.id);
    setMessage('');
    setError('');
    try {
      const response = await adminApiFetch('/api/admin/onboarding/' + encodeURIComponent(row.id), { action: 'whatsapp_instructions' });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Could not send owner instructions.');
      setMessage('WhatsApp setup instructions sent to the business owner. The owner must authorize through Meta.');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send owner instructions.');
    } finally {
      setBusyId(null);
    }
  }

  async function performEnsureSharedChannel(row: Onboarding, stepUpId?: string) {
    if (!row.business_id) return;
    setBusyId(row.id);
    setMessage('');
    setError('');
    try {
      const response = await adminApiFetch('/api/admin/onboarding/' + encodeURIComponent(row.id), { action: 'ensure_shared_channel', stepUpId });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Shared channel allocation was unavailable.');
      const fallbackNote = result.fallback_used && result.channel_country
        ? ` (regional shared routing via ${result.channel_country})`
        : '';
      setMessage(`Shared channel verified and allocated${fallbackNote}. Confirm activation before sharing the WhatsApp link.`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to allocate shared channel.');
    } finally {
      setBusyId(null);
    }
  }

  function ensureSharedChannel(row: Onboarding) {
    if (!row.business_id || busyId) return;
    const countryCode = String(row.whatsapp_setup?.country_code || '');
    const stepUpParams = {
      operation: 'ensure_shared_channel',
      onboarding_id: String(row.id),
      business_id: String(row.business_id),
      business_country: countryCode,
      fallback_policy: countryCode === 'GH' ? 'GH_TO_NG_SHARED' : 'EXACT_COUNTRY',
      expected_wa_method: 'shared',
    };
    const action = async (stepUpId: string) => {
      await performEnsureSharedChannel(row, stepUpId);
    };
    setPendingStepUpAction(() => action);
    stepUp.execute({
      actionType: 'messaging_config',
      targetId: String(row.id),
      params: stepUpParams,
      description: `Verify MFA to allocate a shared WhatsApp channel for ${row.target_email}`,
      onAuthorized: action,
    }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'MFA preparation failed. Please retry.');
    });
  }

  return <div className="space-y-6">
    <div>
      <h1 className="text-2xl font-bold text-gray-900">WhatsApp Setup Assistance</h1>
      <p className="mt-1 max-w-3xl text-sm text-gray-600">
        Help a business use Waaiio's shared number or connect its own WhatsApp Business Account.
        The business owner must personally grant Meta access and verify the phone number.
        Never request an owner password, one-time code, or access token.
      </p>
    </div>
    <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
      <strong>Shared number:</strong> a country must have a verified allocated active channel before the bot is ready.
      A selected country alone is not proof of availability. <strong>Own number:</strong> send a safe setup handoff;
      the owner completes Meta's authorization in their dashboard. Coexistence requires confirmed eligibility.
    </div>
    <div className="flex items-center gap-3">
      {session?.role && hasAccess('customer-onboarding', session.role) && <a href="/customer-onboarding" className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white">New customer onboarding</a>}
      <button type="button" onClick={() => void refresh()} disabled={loading} className="rounded-lg border px-4 py-2 text-sm font-medium">Refresh status</button>
    </div>
    {message && <p role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{message}</p>}
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    {loading ? <p role="status" className="text-sm text-gray-500">Checking authoritative channel assignments…</p> :
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-gray-600"><tr>
            <th className="p-3">Business owner</th><th className="p-3">Country</th>
            <th className="p-3">Requested method</th><th className="p-3">Current state</th>
            <th className="p-3">Next step</th>
          </tr></thead>
          <tbody>{rows.filter(row => !!row.business_id).map(row => {
            const setup = row.whatsapp_setup;
            const ready = setup?.channel_ready === true;
            return <tr key={row.id} className="border-t border-gray-100">
              <td className="p-3">
                <p className="font-medium text-gray-900">{row.target_email}</p>
                <p className="text-xs text-gray-500">Onboarding: {row.status}</p>
              </td>
              <td className="p-3">{setup?.country_code || '—'}</td>
              <td className="p-3 capitalize">{setup?.requested_method || 'shared'}</td>
              <td className="p-3">
                <p className={ready ? 'font-medium text-green-700' : 'font-medium text-amber-700'}>
                  {ready ? 'Assigned channel active' : 'Channel not confirmed ready'}
                </p>
                <p className="text-xs text-gray-500">Current: {setup?.current_method || '—'}; {setup?.channel_type || 'unassigned'}</p>
                {setup?.bot_code && <p className="text-xs text-gray-500">Bot code: {setup.bot_code}</p>}
                <p className="text-xs text-gray-500">Business: {setup?.business_status || 'pending'}</p>
                {setup?.messaging_suspended && <p className="text-xs font-semibold text-red-700">Messaging suspended — do not share bot link until resolved</p>}
                {setup?.whatsapp_link && <div className="mt-2 flex items-center gap-2">
                  <QRCodeSVG value={setup.whatsapp_link} size={76} aria-label="Verified business WhatsApp QR code" />
                  <a href={setup.whatsapp_link} target="_blank" rel="noopener noreferrer" className="max-w-44 break-all text-xs font-medium text-brand underline">Test active WhatsApp link</a>
                </div>}
              </td>
              <td className="p-3">
                {setup?.owner_connection_required ? <button type="button"
                  disabled={!!busyId || ['cancelled', 'failed'].includes(row.status)}
                  onClick={() => void sendOwnerInstructions(row)}
                  className="rounded-lg border border-brand px-3 py-2 text-xs font-semibold text-brand disabled:opacity-40">
                  {busyId === row.id ? 'Sending…' : 'Send owner WABA setup link'}
                </button> : ready ?
                  <span className="text-xs text-green-700">Channel ready; confirm activation and bot routing</span> :
                  <button type="button" disabled={!!busyId || ['cancelled', 'failed'].includes(row.status)}
                    onClick={() => ensureSharedChannel(row)}
                    className="rounded-lg border border-amber-400 px-3 py-2 text-xs font-semibold text-amber-800 disabled:opacity-40">
                    {busyId === row.id ? 'Checking…' : 'Allocate shared number'}
                  </button>}
              </td>
            </tr>;
          })}</tbody>
        </table>
        {rows.filter(row => !!row.business_id).length === 0 &&
          <p className="p-5 text-sm text-gray-500">No assisted businesses are in the onboarding queue.</p>}
      </div>}
    <StepUpDialog
      open={stepUp.state.phase === 'awaiting-code' || stepUp.state.phase === 'verifying'}
      description={stepUp.state.description}
      error={stepUp.state.error}
      loading={stepUp.state.phase === 'verifying'}
      onSubmit={(code) => {
        if (pendingStepUpAction) {
          void stepUp.submitCode(code, pendingStepUpAction);
        }
      }}
      onCancel={() => {
        stepUp.reset();
        setPendingStepUpAction(null);
      }}
    />
  </div>;
}


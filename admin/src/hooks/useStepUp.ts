/**
 * Admin step-up authorization hook for sensitive operations.
 *
 * SEC-005 Layer 4: Provides a reusable flow for preparing, verifying,
 * and retrying operations that require fresh MFA confirmation.
 *
 * The server decides how to confirm (Owner decision 2026-11-12): an
 * authenticator code, a fresh passkey tap, or — for a passkey session and an
 * action that moves no money — nothing at all. The UI only follows that answer.
 *
 * Usage:
 *   const stepUp = useStepUp();
 *
 *   async function handleApprove() {
 *     const result = await stepUp.execute({
 *       actionType: 'payout_approve',
 *       targetId: payoutId,
 *       params: { transfer_method: 'paystack_transfer' },
 *       description: `Approve payout ${payoutId}`,
 *       onAuthorized: async (stepUpId) => {
 *         // The actual mutation — stepUpId is included in the request body
 *         await fetch('/api/admin/payouts/' + payoutId + '/approve', {
 *           method: 'POST',
 *           body: JSON.stringify({ transfer_method, stepUpId }),
 *         });
 *       },
 *     });
 *   }
 */

import { useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';

interface StepUpOptions {
  actionType: string;
  targetId: string | null;
  params: Record<string, unknown>;
  description: string;
  onAuthorized: (stepUpId: string) => Promise<void>;
}

interface StepUpState {
  phase: 'idle' | 'preparing' | 'awaiting-code' | 'verifying' | 'executing' | 'done' | 'error';
  description: string;
  error: string;
  stepUpId: string;
  challengeId: string;
  factorId: string;
  method: 'totp' | 'passkey';
}

export function useStepUp() {
  const [state, setState] = useState<StepUpState>({
    phase: 'idle',
    description: '',
    error: '',
    stepUpId: '',
    challengeId: '',
    factorId: '',
    method: 'totp',
  });

  const apiUrl = import.meta.env.VITE_API_URL || '';

  const getToken = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token;
  }, []);

  const execute = useCallback(async (options: StepUpOptions) => {
    const { actionType, targetId, params, description, onAuthorized } = options;

    setState(s => ({ ...s, phase: 'preparing', description, error: '' }));

    try {
      const token = await getToken();
      if (!token) throw new Error('No active session');

      // Step 1: Prepare the step-up authorization
      const prepareRes = await fetch(`${apiUrl}/api/admin/step-up/prepare`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ actionType, targetId, params }),
      });

      if (!prepareRes.ok) {
        const err = await prepareRes.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to prepare step-up');
      }

      const { stepUpId, factorId, challengeId, method, notRequired } = await prepareRes.json();

      if (notRequired === true) {
        // The mutation route re-checks this server-side.
        setState(s => ({ ...s, phase: 'executing', stepUpId: '', method: 'passkey' }));
        await onAuthorized('');
        setState(s => ({ ...s, phase: 'done' }));
        return { stepUpId: '', factorId: '', challengeId: '' };
      }

      setState(s => ({
        ...s,
        phase: 'awaiting-code',
        stepUpId,
        factorId,
        challengeId,
        method: method === 'passkey' ? 'passkey' : 'totp',
      }));

      // Return a promise that resolves when the user submits the code
      // The UI will call submitCode() which continues the flow
      return { stepUpId, factorId, challengeId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Step-up preparation failed';
      setState(s => ({ ...s, phase: 'error', error: msg }));
      throw err;
    }
  }, [apiUrl, getToken]);

  /** Passkey path: tap through Supabase Auth, then send the refreshed token. */
  const confirmWithPasskey = useCallback(async (onAuthorized: (stepUpId: string) => Promise<void>) => {
    const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors();
    const passkey = factors?.all?.find(f => f.factor_type === 'webauthn' && f.status === 'verified');
    if (factorsError || !passkey) throw new Error('No passkey found on this account. Use your authenticator code instead.');

    const { error: tapError } = await supabase.auth.mfa.webauthn.authenticate({ factorId: passkey.id });
    if (tapError) {
      setState(s => ({ ...s, phase: 'awaiting-code', error: 'Passkey was not confirmed. Try again.' }));
      return;
    }

    const token = await getToken();
    if (!token) throw new Error('No active session');
    const verifyRes = await fetch(`${apiUrl}/api/admin/step-up/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ stepUpId: state.stepUpId, method: 'passkey' }),
    });
    if (!verifyRes.ok) {
      const err = await verifyRes.json().catch(() => ({}));
      const restart = err.code === 'STEP_UP_RESTART_REQUIRED';
      setState(s => ({ ...s, phase: 'awaiting-code',
        stepUpId: restart ? '' : s.stepUpId,
        error: restart ? 'Verification failed. Cancel and restart this operation.' : err.error || 'Verification failed',
      }));
      return;
    }

    setState(s => ({ ...s, phase: 'executing' }));
    await onAuthorized(state.stepUpId);
    setState(s => ({ ...s, phase: 'done' }));
  }, [state.stepUpId, apiUrl, getToken]);

  const submitCode = useCallback(async (
    code: string,
    onAuthorized: (stepUpId: string) => Promise<void>,
  ) => {
    if (state.phase !== 'awaiting-code' || !state.stepUpId) return;

    setState(s => ({ ...s, phase: 'verifying', error: '' }));

    if (state.method === 'passkey') {
      try {
        await confirmWithPasskey(onAuthorized);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Operation failed';
        setState(s => ({ ...s, phase: 'error', error: msg }));
      }
      return;
    }

    try {
      const token = await getToken();
      if (!token) throw new Error('No active session');

      // Step 2: Verify the TOTP code
      const verifyRes = await fetch(`${apiUrl}/api/admin/step-up/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ stepUpId: state.stepUpId, code }),
      });

      if (!verifyRes.ok) {
        const err = await verifyRes.json().catch(() => ({}));
        // Keep the error visible so Cancel remains available. A bound attempt
        // cannot be retried: clear its ID until the user prepares again.
        const restart = err.code === 'STEP_UP_RESTART_REQUIRED';
        setState(s => ({ ...s, phase: 'awaiting-code',
          stepUpId: restart ? '' : s.stepUpId,
          error: restart ? 'Verification failed. Cancel and restart this operation with a fresh code.' : err.error || 'Verification failed',
        }));
        return;
      }

      // GoTrue MFA verify rotates access and refresh tokens. Persist the new
      // session before the next authenticated request, or auto-refresh may fail.
      const payload = await verifyRes.json();
      if (!payload?.session?.access_token || !payload?.session?.refresh_token) {
        throw new Error('MFA verification did not return a refreshed session');
      }
      const { error: sessionError } = await supabase.auth.setSession({
        access_token: payload.session.access_token,
        refresh_token: payload.session.refresh_token,
      });
      if (sessionError) throw new Error('Unable to update session after MFA verification');

      // Step 3: Execute the authorized operation
      setState(s => ({ ...s, phase: 'executing' }));
      await onAuthorized(state.stepUpId);
      setState(s => ({ ...s, phase: 'done' }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Operation failed';
      setState(s => ({ ...s, phase: 'error', error: msg }));
    }
  }, [state.phase, state.stepUpId, state.method, apiUrl, getToken, confirmWithPasskey]);

  const reset = useCallback(() => {
    setState({
      phase: 'idle',
      description: '',
      error: '',
      stepUpId: '',
      challengeId: '',
      factorId: '',
      method: 'totp',
    });
  }, []);

  return {
    state,
    execute,
    submitCode,
    reset,
    isActive: state.phase !== 'idle' && state.phase !== 'done',
  };
}

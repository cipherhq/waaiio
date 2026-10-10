/**
 * Admin step-up authorization hook for sensitive operations.
 *
 * SEC-005 Layer 4: Provides a reusable flow for preparing, verifying,
 * and retrying operations that require fresh MFA confirmation.
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
}

export function useStepUp() {
  const [state, setState] = useState<StepUpState>({
    phase: 'idle',
    description: '',
    error: '',
    stepUpId: '',
    challengeId: '',
    factorId: '',
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

      const { stepUpId, factorId, challengeId } = await prepareRes.json();

      setState(s => ({
        ...s,
        phase: 'awaiting-code',
        stepUpId,
        factorId,
        challengeId,
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

  const submitCode = useCallback(async (
    code: string,
    onAuthorized: (stepUpId: string) => Promise<void>,
  ) => {
    if (state.phase !== 'awaiting-code' || !state.stepUpId) return;

    setState(s => ({ ...s, phase: 'verifying', error: '' }));

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
        // Stay in awaiting-code so user can retry
        setState(s => ({ ...s, phase: 'awaiting-code', error: err.error || 'Verification failed' }));
        return;
      }

      // Step 3: Execute the authorized operation
      setState(s => ({ ...s, phase: 'executing' }));
      await onAuthorized(state.stepUpId);
      setState(s => ({ ...s, phase: 'done' }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Operation failed';
      setState(s => ({ ...s, phase: 'error', error: msg }));
    }
  }, [state.phase, state.stepUpId, apiUrl, getToken]);

  const reset = useCallback(() => {
    setState({
      phase: 'idle',
      description: '',
      error: '',
      stepUpId: '',
      challengeId: '',
      factorId: '',
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

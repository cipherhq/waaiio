import type { VerificationLimitResult } from '@/lib/payouts/verification-limit';

export interface AutoPayoutFlag {
  type: string;
  message: string;
  severity: string;
  adjustment_ids?: string[];
}

export interface AutoPayoutDecisionInput {
  canAutoApprove: boolean;
  limitCheck: VerificationLimitResult;
  holdReasons: string[];
}

export interface AutoPayoutDecisionResult {
  /** The payout status to use for the initial insert (or promotion target). */
  status: 'approved' | 'pending' | 'held';
  /** Structured flags for the no-adjustments insert path. */
  flags: Array<string | AutoPayoutFlag>;
  /** Structured flags for the with-adjustments insert path (hold_reason + verification_limit_exceeded). */
  structuredFlags: AutoPayoutFlag[];
  /** Whether the business exceeded its verification-tier limit. */
  overLimit: boolean;
}

/**
 * Pure decision function: given auto-approval eligibility, verification limit
 * result, and hold reasons, compute the payout status and flags for insert.
 *
 * Used by both the with-adjustments and no-adjustments insert paths in
 * the auto-payout cron.
 */
export function decideAutoPayoutOutcome(input: AutoPayoutDecisionInput): AutoPayoutDecisionResult {
  const { canAutoApprove, limitCheck, holdReasons } = input;
  const overLimit = !limitCheck.allowed;

  // Over-limit payouts become 'held', never 'approved'
  const status: 'approved' | 'pending' | 'held' = overLimit
    ? 'held'
    : (canAutoApprove ? 'approved' : 'pending');

  // Build hold reasons including limit exceeded
  const allReasons = [...holdReasons];
  if (overLimit) {
    allReasons.push(limitCheck.reason || 'Verification limit exceeded');
  }

  // Structured flags for the adjustment path
  const structuredFlags: AutoPayoutFlag[] =
    allReasons.map(r => ({ type: 'hold_reason', message: r, severity: 'info' }));
  if (overLimit) {
    structuredFlags.push({
      type: 'verification_limit_exceeded',
      message: limitCheck.reason || 'Monthly limit exceeded',
      severity: 'critical',
    });
  }

  // Flags for the no-adjustments path (plain strings + structured limit flag)
  const flags: Array<string | AutoPayoutFlag> = allReasons.map(r => r);
  if (overLimit) {
    flags.push({
      type: 'verification_limit_exceeded',
      message: limitCheck.reason || 'Monthly limit exceeded',
      severity: 'critical',
    });
  }

  return { status, flags, structuredFlags, overLimit };
}

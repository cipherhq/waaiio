/**
 * Admin passkey policy (Owner decision 2026-11-12).
 *
 * Passkeys are Supabase native WebAuthn MFA factors: an admin signs in with a
 * password and then taps a passkey instead of typing an authenticator code.
 *
 * - A passkey counts only after the admin approves it with an authenticator
 *   code (admin_passkey_approvals). If any verified passkey on the account is
 *   unapproved, passkey privileges are off and the code is required as before.
 * - For 12 hours after the latest passkey tap in this session, financial
 *   actions that move no money skip step-up (PASSKEY_WAIVABLE_ACTIONS).
 * - Every other step-up action needs a fresh passkey tap (or a code).
 *
 * All inputs come from the verified access token and the server-validated
 * user record (requirePlatformAdmin). Nothing here trusts client claims.
 */

import { createHash } from 'crypto';
import type { PlatformAdmin } from './admin-auth';
import type { StepUpAction } from './admin-step-up';

export const PASSKEY_AMR_METHOD = 'mfa/webauthn';
export const PASSKEY_SESSION_WINDOW_SECONDS = 12 * 60 * 60;
/** Tolerated clock skew between Supabase Auth and this server. */
const CLOCK_SKEW_SECONDS = 60;

/**
 * Financial actions that do not move money out. Money-out actions (payout
 * approval, settlement confirmation, force-settle, refunds, reseller mark-paid)
 * and changes to where money goes (provider config, fee bank, fee rates) are
 * deliberately absent and always require step-up.
 */
export const PASSKEY_WAIVABLE_ACTIONS: ReadonlySet<StepUpAction> = new Set<StepUpAction>([
  'payout_generate',
  'payout_reject',
  'reseller_payout_approve',
  'reseller_payout_reject',
  'reseller_payout_generate',
]);

/** Approving or removing a passkey always needs an authenticator code. */
export const TOTP_ONLY_ACTIONS: ReadonlySet<StepUpAction> = new Set<StepUpAction>([
  'passkey_approve',
  'passkey_remove',
]);

/** Latest passkey verification time (Unix seconds) in this session, if any. */
export function latestPasskeyVerification(admin: PlatformAdmin): number | null {
  let latest: number | null = null;
  for (const entry of admin.amr ?? []) {
    if (entry?.method !== PASSKEY_AMR_METHOD || typeof entry.timestamp !== 'number') continue;
    if (latest === null || entry.timestamp > latest) latest = entry.timestamp;
  }
  return latest;
}

export function verifiedPasskeyFactorIds(admin: PlatformAdmin): string[] {
  return (admin.factors ?? [])
    .filter(f => f.factor_type === 'webauthn' && f.status === 'verified')
    .map(f => f.id);
}

/**
 * True when the account has at least one verified passkey and every verified
 * passkey was approved with an authenticator code. Fails closed on read errors.
 */
export async function hasOnlyApprovedPasskeys(admin: PlatformAdmin): Promise<boolean> {
  const ids = verifiedPasskeyFactorIds(admin);
  if (ids.length === 0) return false;
  const { createServiceClient } = await import('@/lib/supabase/service');
  const { data, error } = await createServiceClient()
    .from('admin_passkey_approvals')
    .select('factor_id')
    .eq('admin_user_id', admin.userId)
    .in('factor_id', ids);
  if (error || !Array.isArray(data)) return false;
  const approved = new Set(data.map((r: { factor_id: string }) => r.factor_id));
  return ids.every(id => approved.has(id));
}

export interface PasskeySessionStatus {
  /** The session verified a passkey and every passkey on the account is approved. */
  trusted: boolean;
  /** Latest passkey verification in this session (Unix seconds). */
  verifiedAt: number | null;
  /** trusted, and the latest passkey tap is within the 12-hour window. */
  withinWindow: boolean;
}

export async function passkeySessionStatus(admin: PlatformAdmin, nowMs = Date.now()): Promise<PasskeySessionStatus> {
  const verifiedAt = latestPasskeyVerification(admin);
  if (verifiedAt === null) return { trusted: false, verifiedAt: null, withinWindow: false };
  const trusted = await hasOnlyApprovedPasskeys(admin);
  const now = Math.floor(nowMs / 1000);
  const withinWindow = trusted
    && verifiedAt <= now + CLOCK_SKEW_SECONDS
    && verifiedAt >= now - PASSKEY_SESSION_WINDOW_SECONDS;
  return { trusted, verifiedAt, withinWindow };
}

/**
 * Deterministic challenge id for a passkey-verified step-up. The unique index
 * on admin_step_up_authorizations.challenge_id (M538) means one passkey tap
 * can verify only one step-up.
 */
export function passkeyChallengeId(sessionId: string, verifiedAt: number): string {
  const h = createHash('sha256').update(`passkey-step-up:${sessionId}:${verifiedAt}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function isFreshPasskeyTap(verifiedAt: number | null, grantCreatedAt: string, nowMs = Date.now()): boolean {
  if (verifiedAt === null) return false;
  const grantSecond = Math.floor(Date.parse(grantCreatedAt) / 1000);
  if (!Number.isFinite(grantSecond)) return false;
  // Strictly after the grant's second: a tap from before the operation was
  // prepared (for example the sign-in tap) never confirms it.
  return verifiedAt > grantSecond && verifiedAt <= Math.floor(nowMs / 1000) + CLOCK_SKEW_SECONDS;
}

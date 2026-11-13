/**
 * Admin passkey policy (Owner decision 2026-11-12).
 *
 * Passkeys are Supabase native WebAuthn MFA factors: an admin signs in with a
 * password and then taps a passkey instead of typing an authenticator code.
 *
 * - A passkey counts only after the admin approves it with an authenticator
 *   code (admin_passkey_approvals). If any verified passkey on the account is
 *   unapproved, passkey privileges are off and the code is required as before.
 * - A session is trusted only when Supabase Auth's own session record says its
 *   latest MFA verification was an approved passkey (auth.sessions.factor_id,
 *   read through admin_session_mfa_state, M538), the session is still aal2,
 *   and that passkey tap happened after the passkey was approved. The amr
 *   claim alone does not say which factor was used.
 * - For 12 hours after sign-in (the session's start), financial actions that
 *   move no money skip step-up (PASSKEY_WAIVABLE_ACTIONS). Later taps do not
 *   extend the window.
 * - Every other step-up action needs a fresh passkey tap (or a code).
 *
 * All inputs come from the verified access token, the server-validated user
 * record (requirePlatformAdmin) and Supabase Auth's session table. Nothing
 * here trusts client claims. Every read error fails closed.
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
 * Approval time (ms) of each verified passkey, or null when the account has no
 * verified passkey, any verified passkey is unapproved, or the read fails.
 */
async function approvedPasskeys(admin: PlatformAdmin): Promise<Map<string, number> | null> {
  const ids = verifiedPasskeyFactorIds(admin);
  if (ids.length === 0) return null;
  const { createServiceClient } = await import('@/lib/supabase/service');
  const { data, error } = await createServiceClient()
    .from('admin_passkey_approvals')
    .select('factor_id, approved_at')
    .eq('admin_user_id', admin.userId)
    .in('factor_id', ids);
  if (error || !Array.isArray(data)) return null;
  const approved = new Map<string, number>();
  for (const r of data as Array<{ factor_id: string; approved_at: string }>) {
    const at = Date.parse(r.approved_at);
    if (Number.isFinite(at)) approved.set(r.factor_id, at);
  }
  return ids.every(id => approved.has(id)) ? approved : null;
}

interface SessionMfaState { aal: string | null; factorId: string | null; createdAtMs: number | null }

/** Supabase Auth's record of this session (auth.sessions). Null on any error. */
async function sessionMfaState(admin: PlatformAdmin): Promise<SessionMfaState | null> {
  if (!admin.sessionId) return null;
  const { createServiceClient } = await import('@/lib/supabase/service');
  try {
    const { data, error } = await createServiceClient()
      .rpc('admin_session_mfa_state', { p_session_id: admin.sessionId })
      .maybeSingle();
    if (error || !data) return null;
    const row = data as { session_aal: string | null; session_factor_id: string | null; session_created_at: string | null };
    const created = row.session_created_at ? Date.parse(row.session_created_at) : NaN;
    return { aal: row.session_aal, factorId: row.session_factor_id, createdAtMs: Number.isFinite(created) ? created : null };
  } catch {
    return null;
  }
}

export interface PasskeySessionStatus {
  /**
   * The session's latest MFA verification was an approved passkey, tapped
   * after its approval, and every passkey on the account is approved.
   */
  trusted: boolean;
  /** Latest passkey verification in this session (Unix seconds). */
  verifiedAt: number | null;
  /** trusted, and the session started no more than 12 hours ago. */
  withinWindow: boolean;
}

export async function passkeySessionStatus(admin: PlatformAdmin, nowMs = Date.now()): Promise<PasskeySessionStatus> {
  const untrusted = (verifiedAt: number | null): PasskeySessionStatus => ({ trusted: false, verifiedAt, withinWindow: false });
  const verifiedAt = latestPasskeyVerification(admin);
  const now = Math.floor(nowMs / 1000);
  if (verifiedAt === null || verifiedAt > now + CLOCK_SKEW_SECONDS) return untrusted(verifiedAt);

  const approvals = await approvedPasskeys(admin);
  if (!approvals) return untrusted(verifiedAt);
  const session = await sessionMfaState(admin);
  if (!session || session.aal !== 'aal2' || !session.factorId) return untrusted(verifiedAt);
  const approvedAt = approvals.get(session.factorId);
  if (approvedAt === undefined || verifiedAt <= Math.floor(approvedAt / 1000)) return untrusted(verifiedAt);

  const withinWindow = session.createdAtMs !== null
    && nowMs - session.createdAtMs <= PASSKEY_SESSION_WINDOW_SECONDS * 1000;
  return { trusted: true, verifiedAt, withinWindow };
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

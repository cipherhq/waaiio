import { createServiceClient } from '@/lib/supabase/service';
import { createSecurityEvent } from './create-security-event';
import { logger } from '@/lib/logger';

/**
 * Hash a string using SHA-256 (for storage).
 */
async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

interface BindSessionParams {
  userId: string;
  sessionId: string;
  ip: string;
  userAgent: string;
  country?: string;
}

/**
 * Record a login session and check for suspicious activity.
 * Called after successful authentication (email login or OTP verify).
 */
export async function bindSession(params: BindSessionParams): Promise<void> {
  const { userId, sessionId, ip, userAgent, country } = params;

  try {
    const supabase = createServiceClient();
    const uaHash = await sha256(userAgent);

    // 1. Insert or update session record
    await supabase
      .from('security_sessions')
      .upsert({
        session_id: sessionId,
        user_id: userId,
        ip_address: ip,
        user_agent_hash: uaHash,
        country: country || null,
        last_seen_at: new Date().toISOString(),
        is_active: true,
      }, { onConflict: 'session_id' });

    // 2. Update last_login_at on profile
    await supabase
      .from('profiles')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', userId);

    // 3. Check if this IP+UA is new for this user (suspicious login)
    const { data: previousSessions } = await supabase
      .from('security_sessions')
      .select('ip_address, user_agent_hash')
      .eq('user_id', userId)
      .eq('is_active', true)
      .neq('session_id', sessionId)
      .limit(20);

    const knownIPs = new Set(previousSessions?.map(s => s.ip_address) || []);
    const knownUAs = new Set(previousSessions?.map(s => s.user_agent_hash) || []);

    // If user has previous sessions and this IP+UA combo is new, flag it
    if (previousSessions && previousSessions.length > 0 && !knownIPs.has(ip) && !knownUAs.has(uaHash)) {
      // Look up user's business for the alert
      const businessId = await getUserBusinessId(supabase, userId);

      await createSecurityEvent({
        userId,
        businessId: businessId || undefined,
        eventType: 'security.suspicious_login',
        severity: 'warning',
        ip,
        userAgent,
        metadata: { country, session_id: sessionId },
      });
    }

    // 4. Check for concurrent sessions from different IPs
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: activeSessions } = await supabase
      .from('security_sessions')
      .select('ip_address, session_id')
      .eq('user_id', userId)
      .eq('is_active', true)
      .gte('last_seen_at', thirtyMinAgo);

    if (activeSessions && activeSessions.length >= 2) {
      const uniqueIPs = new Set(activeSessions.map(s => s.ip_address));
      if (uniqueIPs.size >= 2) {
        const businessId = await getUserBusinessId(supabase, userId);

        await createSecurityEvent({
          userId,
          businessId: businessId || undefined,
          eventType: 'security.concurrent_sessions',
          severity: 'critical',
          ip,
          userAgent,
          metadata: {
            active_sessions: activeSessions.length,
            unique_ips: Array.from(uniqueIPs),
            country,
          },
        });
      }
    }
  } catch (err) {
    // Non-blocking — don't fail the login
    logger.error('[SECURITY] Session bind error:', err);
  }
}

/**
 * Update last_seen_at for a session (debounced by caller).
 */
export async function touchSession(sessionId: string, ip: string): Promise<void> {
  try {
    const supabase = createServiceClient();
    await supabase
      .from('security_sessions')
      .update({ last_seen_at: new Date().toISOString(), ip_address: ip })
      .eq('session_id', sessionId)
      .eq('is_active', true);
  } catch {
    // Silent — non-critical
  }
}

/**
 * Revoke a session (on logout or forced by admin/security).
 */
export async function revokeSession(sessionId: string, reason: string): Promise<void> {
  try {
    const supabase = createServiceClient();
    await supabase
      .from('security_sessions')
      .update({ is_active: false, revoked_at: new Date().toISOString(), revoke_reason: reason })
      .eq('session_id', sessionId);
  } catch {
    // Silent
  }
}

async function getUserBusinessId(supabase: ReturnType<typeof createServiceClient>, userId: string): Promise<string | null> {
  const { data } = await supabase
    .from('businesses')
    .select('id')
    .eq('owner_id', userId)
    .limit(1)
    .maybeSingle();
  return data?.id || null;
}

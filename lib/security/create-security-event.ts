import { createServiceClient } from '@/lib/supabase/service';
import { createAlert } from '@/lib/alerts/create-alert';
import { logger } from '@/lib/logger';

interface SecurityEventInput {
  userId?: string;
  businessId?: string;
  eventType: string;
  severity: 'info' | 'warning' | 'critical';
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Log a security event and create an admin-visible alert if business is known.
 * Non-blocking — errors are logged but don't propagate.
 */
export async function createSecurityEvent(input: SecurityEventInput): Promise<void> {
  try {
    const supabase = createServiceClient();

    // Insert detailed event
    await supabase.from('security_events').insert({
      user_id: input.userId || null,
      business_id: input.businessId || null,
      event_type: input.eventType,
      severity: input.severity,
      ip_address: input.ip || null,
      user_agent: input.userAgent?.slice(0, 500) || null,
      metadata: input.metadata || {},
    });

    // Create admin-visible alert if we know the business
    if (input.businessId) {
      const titles: Record<string, string> = {
        'security.suspicious_login': 'Login from new device or location',
        'security.concurrent_sessions': 'Multiple active sessions detected',
        'security.brute_force': 'Account locked — too many failed attempts',
        'security.token_reuse': 'Possible session hijacking detected',
      };

      await createAlert(supabase, {
        businessId: input.businessId,
        type: input.eventType,
        severity: input.severity,
        title: titles[input.eventType] || 'Security event',
        message: buildAlertMessage(input),
        metadata: { ...input.metadata, ip: input.ip, user_id: input.userId },
      });
    }
  } catch (err) {
    logger.error('[SECURITY] Failed to create security event:', err);
  }
}

function buildAlertMessage(input: SecurityEventInput): string {
  const ip = input.ip || 'unknown IP';
  switch (input.eventType) {
    case 'security.suspicious_login':
      return `A login was detected from a new device or IP address (${ip}). If this wasn't you, change your password immediately.`;
    case 'security.concurrent_sessions':
      return `Multiple active sessions detected from different locations. This could indicate unauthorized access. Review active sessions.`;
    case 'security.brute_force':
      return `Account temporarily locked after multiple failed login attempts from ${ip}. This may indicate a brute-force attack.`;
    case 'security.token_reuse':
      return `A previously used session token was reused from ${ip}. All sessions have been revoked as a precaution.`;
    default:
      return `Security event: ${input.eventType} from ${ip}`;
  }
}

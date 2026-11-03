/**
 * Shared resolver for /m/ permanent merchant link routes.
 *
 * Consolidates business+channel lookup, readiness validation, rate limiting,
 * query-param rejection, and no-store error rendering used by all three
 * route handlers (base, action, campaign).
 */
import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import {
  isAssignedWhatsAppChannelReady,
  buildVerifiedWhatsAppLink,
  type ReadinessBusiness,
  type ReadinessChannel,
} from '@/lib/onboarding/whatsapp-readiness';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';

export const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUUID(id: string): boolean {
  return UUID_RE.test(id);
}

/** Return 429 with no-store if rate-limited, else null. */
export async function rateLimit(request: NextRequest): Promise<NextResponse | null> {
  const key = getRateLimitKey(request, 'merchant-link');
  const blocked = await rateLimitResponseAsync(key, 30, 60_000);
  if (!blocked) return null;
  // Re-wrap with no-store + text/html so browsers don't cache the 429
  return errorResponse(429, 'Too Many Requests', 'Please wait a moment before trying again.');
}

/** Reject requests carrying ANY query parameters — permanent links are opaque. */
export function rejectQueryParams(request: NextRequest): NextResponse | null {
  const url = new URL(request.url);
  if (url.search && url.search !== '?') {
    return errorResponse(400, 'Invalid Request', 'This link does not accept parameters.');
  }
  return null;
}

/** Resolved business + channel ready for wa.me redirect. */
export interface ResolvedChannel {
  business: {
    id: string;
    country_code: string | null;
    status: string;
    messaging_suspended: boolean | null;
    bot_code: string | null;
  };
  channel: {
    channel_type: string | null;
    is_active: boolean;
    connection_status: string | null;
    country_code: string | null;
    business_id: string | null;
    phone_number: string | null;
  };
  /** Verified wa.me link from buildVerifiedWhatsAppLink (base route only). */
  verifiedLink: string | null;
  /** Cleaned phone digits for action/campaign routes that build custom prefill. */
  digits: string;
}

/**
 * Resolve business + channel or return an error NextResponse.
 * Checks: UUID format, business exists & active, messaging not suspended,
 * explicit channel assignment (no arbitrary fallback), channel readiness.
 */
export async function resolveBusinessChannel(
  businessId: string,
): Promise<ResolvedChannel | NextResponse> {
  if (!businessId || !isValidUUID(businessId)) {
    return errorResponse(400, 'Invalid Link', 'This link is not valid.');
  }

  const service = createServiceClient();

  // Minimal projection — no tokens or decryption
  const { data: biz, error: bizErr } = await service
    .from('businesses')
    .select('id, country_code, status, messaging_suspended, bot_code, assigned_channel_id, whatsapp_channel_id')
    .eq('id', businessId)
    .maybeSingle();

  if (bizErr) return errorResponse(500, 'Service Error', 'Unable to load business information. Please try again later.');
  if (!biz) return errorResponse(404, 'Business Not Found', 'This business link is no longer active.');
  if (biz.status !== 'active') return errorResponse(503, 'Business Unavailable', 'This business is not currently active.');
  if (biz.messaging_suspended === true) return errorResponse(503, 'Messaging Unavailable', 'Messaging is temporarily unavailable for this business.');

  // Explicit channel assignment — no arbitrary fallback
  const channelId = biz.assigned_channel_id || biz.whatsapp_channel_id;
  if (!channelId) return errorResponse(503, 'WhatsApp Unavailable', 'This business has not connected WhatsApp yet.');

  const { data: ch, error: chErr } = await service
    .from('whatsapp_channels')
    .select('id, channel_type, is_active, connection_status, country_code, business_id, phone_number')
    .eq('id', channelId)
    .maybeSingle();

  if (chErr) return errorResponse(500, 'Service Error', 'Unable to load WhatsApp channel. Please try again later.');
  if (!ch) return errorResponse(503, 'WhatsApp Unavailable', 'The assigned WhatsApp channel is no longer available.');

  const rb: ReadinessBusiness = { id: biz.id, country_code: biz.country_code };
  const rc: ReadinessChannel = {
    channel_type: ch.channel_type,
    is_active: ch.is_active,
    connection_status: ch.connection_status,
    country_code: ch.country_code,
    business_id: ch.business_id,
  };

  if (!isAssignedWhatsAppChannelReady(rb, rc)) {
    return errorResponse(503, 'WhatsApp Unavailable', 'This business\'s WhatsApp connection is currently unavailable.');
  }

  const digits = String(ch.phone_number || '').replace(/[^0-9]/g, '');
  if (!/^[1-9]\d{6,14}$/.test(digits)) {
    return errorResponse(503, 'WhatsApp Unavailable', 'Invalid phone number for this business.');
  }

  const verifiedLink = buildVerifiedWhatsAppLink(
    { ...rb, bot_code: biz.bot_code, status: biz.status, messaging_suspended: biz.messaging_suspended },
    { ...rc, phone_number: ch.phone_number },
  );

  return {
    business: { id: biz.id, country_code: biz.country_code, status: biz.status, messaging_suspended: biz.messaging_suspended, bot_code: biz.bot_code },
    channel: ch,
    verifiedLink,
    digits,
  };
}

/** 302 redirect with no-store. */
export function temporaryRedirect(url: string): NextResponse {
  return NextResponse.redirect(url, { status: 302, headers: NO_STORE });
}

/** HTML error page with no-store. */
export function errorResponse(status: number, title: string, message: string): NextResponse {
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${esc(title)} - Waaiio</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.c{background:#fff;border-radius:16px;padding:48px 40px;max-width:400px;text-align:center;box-shadow:0 25px 50px -12px rgba(0,0,0,.25)}h1{color:#1F2937;font-size:24px;font-weight:600;margin-bottom:12px}p{color:#6B7280;font-size:16px;line-height:1.5}.f{margin-top:32px;padding-top:24px;border-top:1px solid #E5E7EB}.f a{color:#6C2BD9;text-decoration:none;font-size:14px}.f a:hover{text-decoration:underline}</style></head><body><div class="c"><h1>${esc(title)}</h1><p>${esc(message)}</p><div class="f"><a href="https://www.waaiio.com">Visit Waaiio</a></div></div></body></html>`;
  return new NextResponse(html, { status, headers: { 'Content-Type': 'text/html', ...NO_STORE } });
}

function esc(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

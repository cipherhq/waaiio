/**
 * Permanent merchant action link — /m/{businessId}/{action}
 *
 * Existing prefill semantics (bot-code-detection.ts parseDeepLink):
 *   shared   → wa.me/{digits}?text={bot_code}:{capability}
 *   dedicated → wa.me/{digits}?text=Hi
 *   attendance → /checkin/{businessId}  (web page, not WhatsApp)
 *   generic  → same as base route (shared: bot_code, dedicated: plain wa.me)
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  rateLimit,
  rejectQueryParams,
  resolveBusinessChannel,
  isValidUUID,
  errorResponse,
  temporaryRedirect,
} from '../../resolve';
import { ACTION_CAPABILITY_MAP, canonicalPublicOrigin } from '@/lib/url';

const VALID_ACTIONS = new Set([...Object.keys(ACTION_CAPABILITY_MAP), 'attendance']);

interface RouteContext {
  params: Promise<{ businessId: string; action: string }>;
}

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const limited = await rateLimit(request);
  if (limited) return limited;

  const { businessId, action } = await context.params;

  const normalizedAction = action?.toLowerCase();
  if (!normalizedAction || !VALID_ACTIONS.has(normalizedAction)) {
    return errorResponse(400, 'Invalid Action', 'This action is not recognized.');
  }

  // Attendance: validate UUID + reject query params, then redirect to web checkin
  if (normalizedAction === 'attendance') {
    if (!businessId || !isValidUUID(businessId)) {
      return errorResponse(400, 'Invalid Link', 'This link is not valid.');
    }
    const rejected = rejectQueryParams(request);
    if (rejected) return rejected;
    const origin = canonicalPublicOrigin();
    return temporaryRedirect(`${origin}/checkin/${businessId}`);
  }

  const rejected = rejectQueryParams(request);
  if (rejected) return rejected;

  const result = await resolveBusinessChannel(businessId);
  if (result instanceof NextResponse) return result;

  const capability = ACTION_CAPABILITY_MAP[normalizedAction];

  if (result.channel.channel_type === 'shared') {
    // Shared: bot_code:capability (existing deep-link format) or plain bot_code for generic
    const botCode = String(result.business.bot_code || '').trim();
    if (!botCode) {
      return errorResponse(503, 'WhatsApp Unavailable', 'This business\'s routing code is not configured.');
    }
    const prefill = capability ? `${botCode}:${capability}` : botCode;
    return temporaryRedirect(`https://wa.me/${result.digits}?text=${encodeURIComponent(prefill)}`);
  }

  // Dedicated: ?text=Hi for action routes (existing QR semantics)
  if (capability) {
    return temporaryRedirect(`https://wa.me/${result.digits}?text=${encodeURIComponent('Hi')}`);
  }

  // Generic dedicated: plain wa.me (same as base route verifiedLink)
  if (!result.verifiedLink) {
    return errorResponse(503, 'WhatsApp Unavailable', 'Unable to generate a WhatsApp link for this business.');
  }
  return temporaryRedirect(result.verifiedLink);
}

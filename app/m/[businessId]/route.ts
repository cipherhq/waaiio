/**
 * Permanent merchant WhatsApp link — /m/{businessId}
 *
 * Resolves via buildVerifiedWhatsAppLink (preserves existing dedicated "Hi"
 * and shared bot_code semantics). 302 redirect, no-store, rate-limited.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  rateLimit,
  rejectQueryParams,
  resolveBusinessChannel,
  errorResponse,
  temporaryRedirect,
} from '../resolve';

interface RouteContext {
  params: Promise<{ businessId: string }>;
}

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const limited = await rateLimit(request);
  if (limited) return limited;

  const rejected = rejectQueryParams(request);
  if (rejected) return rejected;

  const { businessId } = await context.params;
  const result = await resolveBusinessChannel(businessId);
  if (result instanceof NextResponse) return result;

  // buildVerifiedWhatsAppLink already applies: dedicated → wa.me/{digits},
  // shared → wa.me/{digits}?text={bot_code}. No invented capability commands.
  if (!result.verifiedLink) {
    return errorResponse(503, 'WhatsApp Unavailable', 'Unable to generate a WhatsApp link for this business.');
  }

  return temporaryRedirect(result.verifiedLink);
}

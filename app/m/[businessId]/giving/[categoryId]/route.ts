/**
 * Permanent giving-category link — /m/{businessId}/giving/{categoryId}
 *
 * Redirects to the business's WhatsApp with "{bot_code}:giving:{ref}" prefilled
 * (lib/giving-category-link.ts). The bot opens giving in that category; an
 * unknown, inactive or deleted category falls back to the giving menu there, so
 * this route does not look the category up. Both shared and dedicated numbers
 * use the same prefill. Hidden businesses stay reachable (#1083).
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  rateLimit,
  rejectQueryParams,
  resolveBusinessChannel,
  isValidUUID,
  errorResponse,
  temporaryRedirect,
} from '../../../resolve';
import { buildGivingCategoryPrefill } from '@/lib/giving-category-link';

interface RouteContext {
  params: Promise<{ businessId: string; categoryId: string }>;
}

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const limited = await rateLimit(request);
  if (limited) return limited;

  const rejected = rejectQueryParams(request);
  if (rejected) return rejected;

  const { businessId, categoryId } = await context.params;

  if (!categoryId || !isValidUUID(categoryId)) {
    return errorResponse(400, 'Invalid Link', 'This giving link is not valid.');
  }

  const result = await resolveBusinessChannel(businessId);
  if (result instanceof NextResponse) return result;

  const prefill = buildGivingCategoryPrefill(String(result.business.bot_code || ''), categoryId);
  if (!prefill) {
    return errorResponse(503, 'WhatsApp Unavailable', 'This business\'s routing code is not configured.');
  }

  return temporaryRedirect(`https://wa.me/${result.digits}?text=${encodeURIComponent(prefill)}`);
}

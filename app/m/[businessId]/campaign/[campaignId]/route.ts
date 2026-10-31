/**
 * Permanent merchant campaign link — /m/{businessId}/campaign/{campaignId}
 *
 * Resolves a keyword campaign, validates ownership/active/date, and redirects
 * with the campaign keyword prefilled — same as the original getWaLink(keyword).
 *
 * Both shared and dedicated channels prefill with the keyword. Shared channels
 * do NOT prepend bot_code here because the existing keyword handler in the bot
 * matches the keyword text directly after business routing.
 *
 * No bot parser changes.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import {
  rateLimit,
  rejectQueryParams,
  resolveBusinessChannel,
  isValidUUID,
  errorResponse,
  temporaryRedirect,
} from '../../../resolve';

interface RouteContext {
  params: Promise<{ businessId: string; campaignId: string }>;
}

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const limited = await rateLimit(request);
  if (limited) return limited;

  const rejected = rejectQueryParams(request);
  if (rejected) return rejected;

  const { businessId, campaignId } = await context.params;

  if (!campaignId || !isValidUUID(campaignId)) {
    return errorResponse(400, 'Invalid Campaign', 'This campaign link is not valid.');
  }

  const result = await resolveBusinessChannel(businessId);
  if (result instanceof NextResponse) return result;

  // Load campaign — must be owned by business, active, and within date range
  const service = createServiceClient();
  const { data: campaign, error: campErr } = await service
    .from('keyword_campaigns')
    .select('id, keyword, is_active, starts_at, ends_at')
    .eq('id', campaignId)
    .eq('business_id', businessId)
    .maybeSingle();

  if (campErr) return errorResponse(500, 'Service Error', 'Unable to load campaign information. Please try again later.');
  if (!campaign) return errorResponse(404, 'Campaign Not Found', 'This campaign is no longer available.');
  if (!campaign.is_active) return errorResponse(503, 'Campaign Inactive', 'This campaign has been paused.');

  // Safe timestamp comparison — parsed, not ISO string comparison
  const nowMs = Date.now();
  if (campaign.starts_at) {
    const startsMs = Date.parse(campaign.starts_at);
    if (Number.isNaN(startsMs)) return errorResponse(503, 'Campaign Unavailable', 'Campaign dates are invalid.');
    if (nowMs < startsMs) return errorResponse(503, 'Campaign Not Started', 'This campaign has not started yet.');
  }
  if (campaign.ends_at) {
    const endsMs = Date.parse(campaign.ends_at);
    if (Number.isNaN(endsMs)) return errorResponse(503, 'Campaign Unavailable', 'Campaign dates are invalid.');
    if (nowMs > endsMs) return errorResponse(503, 'Campaign Ended', 'This campaign has ended.');
  }

  // Validate keyword is non-empty
  const keyword = (campaign.keyword || '').trim();
  if (!keyword) return errorResponse(503, 'Campaign Unavailable', 'This campaign has no keyword configured.');

  // Prefill with keyword for both shared and dedicated — matches original getWaLink(keyword)
  return temporaryRedirect(`https://wa.me/${result.digits}?text=${encodeURIComponent(keyword)}`);
}

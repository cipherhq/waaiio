import { NextResponse, type NextRequest } from 'next/server';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { authenticateRequest } from '@/lib/api-auth';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'reports-send'), 10, 60_000);
    if (rateLimit) return rateLimit;

    const body = await request.json();
    const { reportIds } = body;
    if (!reportIds || !Array.isArray(reportIds) || reportIds.length === 0) {
      return NextResponse.json({ error: 'reportIds required' }, { status: 400 });
    }
    if (!body.businessId) {
      return NextResponse.json({ error: 'businessId required' }, { status: 400 });
    }

    // Single authentication: cookie-based session + business ownership verification.
    // No bearer Authorization header required — dashboard uses cookie auth.
    const auth = await authenticateRequest(request, {
      body,
      requireBusinessOwnership: true,
    });
    if (auth instanceof NextResponse) return auth;

    const { businessId, service: supabase } = auth;
    const resolver = new ChannelResolver(supabase);
    const results: { id: string; status: string }[] = [];

    for (const reportId of reportIds) {
      try {
        // Fetch report scoped to the authenticated business
        const { data: report, error: fetchError } = await supabase
          .from('customer_reports')
          .select('*, businesses(id, name)')
          .eq('id', reportId)
          .eq('business_id', businessId!)
          .single();

        if (fetchError || !report) {
          results.push({ id: reportId, status: 'not_found' });
          continue;
        }

        // Generate unique access token for secure viewing
        const accessToken = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
        const secureLink = `${appUrl}/doc/${accessToken}`;

        // Persist token BEFORE sending the link — must succeed for the link to be valid
        // Persist token and VERIFY the row was actually updated before sending
        const { data: persisted, error: tokenError } = await supabase
          .from('customer_reports')
          .update({ access_token: accessToken })
          .eq('id', reportId)
          .eq('business_id', businessId!)
          .select('id')
          .maybeSingle();

        if (tokenError || !persisted) {
          logger.error('[DOCUMENTS] Token persistence failed — not sending link', { op: 'reports-send' });
          results.push({ id: reportId, status: 'failed' });
          continue;
        }

        // Resolve channel for the business
        const resolved = await resolver.resolveByBusinessId(report.business_id);
        if (!resolved) {
          logger.error('[DOCUMENTS] No channel for business:', report.business_id);
          await supabase.from('customer_reports').update({ status: 'failed' }).eq('id', reportId);
          results.push({ id: reportId, status: 'failed' });
          continue;
        }

        const businessName = (report.businesses as { name: string })?.name || 'Business';
        const phone = report.customer_phone.startsWith('+')
          ? report.customer_phone.slice(1)
          : report.customer_phone;

        // Send secure link via WhatsApp (not the raw PDF URL)
        await resolved.sender.sendText({
          to: phone,
          text: [
            `📄 *${report.title}*`,
            `from *${businessName}*`,
            '',
            `View your document securely:`,
            secureLink,
            '',
            `You'll need the last 4 digits of your phone number to open it.`,
          ].join('\n'),
        });

        // Update report status
        await supabase
          .from('customer_reports')
          .update({
            status: 'sent',
            sent_at: new Date().toISOString(),
          })
          .eq('id', reportId);

        results.push({ id: reportId, status: 'sent' });
      } catch (err) {
        logger.error('[REPORTS] Send error for', reportId, err);
        await supabase.from('customer_reports').update({ status: 'failed' }).eq('id', reportId);
        results.push({ id: reportId, status: 'failed' });
      }
    }

    return NextResponse.json({ results });
  } catch (error) {
    logger.error('[REPORTS] Send error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

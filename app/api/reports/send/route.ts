import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { authenticateRequest } from '@/lib/api-auth';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = rateLimitResponse(getRateLimitKey(request, 'reports-send'), 10, 60_000);
    if (rateLimit) return rateLimit;

    const body = await request.json();
    const auth = await authenticateRequest(request, { body });
    if (auth instanceof NextResponse) return auth;

    const { reportIds, businessId } = body;
    if (!reportIds || !Array.isArray(reportIds) || reportIds.length === 0) {
      return NextResponse.json({ error: 'reportIds required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Verify business ownership
    if (businessId) {
      const { data: { user } } = await supabase.auth.getUser(request.headers.get('Authorization')?.replace('Bearer ', '') || '');
      if (user) {
        const { data: biz } = await supabase.from('businesses').select('id').eq('id', businessId).eq('owner_id', user.id).maybeSingle();
        if (!biz) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
      }
    }
    const resolver = new ChannelResolver(supabase);
    const results: { id: string; status: string }[] = [];

    for (const reportId of reportIds) {
      try {
        // Fetch report
        const { data: report } = await supabase
          .from('customer_reports')
          .select('*, businesses(id, name)')
          .eq('id', reportId)
          .single();

        if (!report) {
          results.push({ id: reportId, status: 'not_found' });
          continue;
        }

        // Verify report belongs to the specified business
        if (businessId && report.business_id !== businessId) {
          results.push({ id: reportId, status: 'not_authorized' });
          continue;
        }

        // Generate signed URL for the PDF (valid for 1 hour)
        const { data: signedUrlData, error: signError } = await supabase.storage
          .from('customer-reports')
          .createSignedUrl(report.file_path, 3600);

        if (signError || !signedUrlData?.signedUrl) {
          logger.error('[REPORTS] Signed URL error:', signError);
          await supabase.from('customer_reports').update({ status: 'failed' }).eq('id', reportId);
          results.push({ id: reportId, status: 'failed' });
          continue;
        }

        // Resolve channel for the business
        const resolved = await resolver.resolveByBusinessId(report.business_id);
        if (!resolved) {
          logger.error('[REPORTS] No channel for business:', report.business_id);
          await supabase.from('customer_reports').update({ status: 'failed' }).eq('id', reportId);
          results.push({ id: reportId, status: 'failed' });
          continue;
        }

        const businessName = (report.businesses as { name: string })?.name || 'Business';
        const phone = report.customer_phone.startsWith('+')
          ? report.customer_phone.slice(1)
          : report.customer_phone;

        // Send document via WhatsApp
        await resolved.sender.sendDocument({
          to: phone,
          documentUrl: signedUrlData.signedUrl,
          filename: `${report.title}.pdf`,
          caption: `${report.title} from ${businessName}`,
        });

        // Update report status
        await supabase
          .from('customer_reports')
          .update({
            status: 'sent',
            sent_at: new Date().toISOString(),
            file_url: signedUrlData.signedUrl,
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

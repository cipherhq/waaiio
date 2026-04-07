import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';

export async function POST(request: NextRequest) {
  try {
    const { reportIds } = await request.json();
    if (!reportIds || !Array.isArray(reportIds) || reportIds.length === 0) {
      return NextResponse.json({ error: 'reportIds required' }, { status: 400 });
    }

    const supabase = createServiceClient();
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

        // Generate signed URL for the PDF (valid for 1 hour)
        const { data: signedUrlData, error: signError } = await supabase.storage
          .from('customer-reports')
          .createSignedUrl(report.file_path, 3600);

        if (signError || !signedUrlData?.signedUrl) {
          console.error('[REPORTS] Signed URL error:', signError);
          await supabase.from('customer_reports').update({ status: 'failed' }).eq('id', reportId);
          results.push({ id: reportId, status: 'failed' });
          continue;
        }

        // Resolve channel for the business
        const resolved = await resolver.resolveByBusinessId(report.business_id);
        if (!resolved) {
          console.error('[REPORTS] No channel for business:', report.business_id);
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
        console.error('[REPORTS] Send error for', reportId, err);
        await supabase.from('customer_reports').update({ status: 'failed' }).eq('id', reportId);
        results.push({ id: reportId, status: 'failed' });
      }
    }

    return NextResponse.json({ results });
  } catch (error) {
    console.error('[REPORTS] Send error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

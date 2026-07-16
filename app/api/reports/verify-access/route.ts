import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    // Strict rate limit to prevent brute force (5 attempts per minute per IP)
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'doc-verify'), 5, 60_000);
    if (rateLimit) return rateLimit;

    const { token, lastFourDigits } = await request.json();

    if (!token || !lastFourDigits || lastFourDigits.length !== 4) {
      return NextResponse.json({ error: 'Please enter 4 digits' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Find document by access token
    const { data: report } = await supabase
      .from('customer_reports')
      .select('id, title, file_path, customer_phone, business_id, status, access_count')
      .eq('access_token', token)
      .single();

    if (!report) {
      return NextResponse.json({ error: 'Document not found or link has expired' }, { status: 404 });
    }

    // Verify last 4 digits of phone number
    const phone = report.customer_phone.replace(/\D/g, ''); // strip non-digits
    const phoneLast4 = phone.slice(-4);

    if (lastFourDigits !== phoneLast4) {
      return NextResponse.json({ error: 'Incorrect digits. Please try again.' }, { status: 403 });
    }

    // Generate short-lived signed URL (15 minutes)
    const { data: signedUrlData, error: signError } = await supabase.storage
      .from('customer-reports')
      .createSignedUrl(report.file_path, 900); // 15 minutes

    if (signError || !signedUrlData?.signedUrl) {
      logger.error('[DOCUMENTS] Signed URL error:', signError);
      return NextResponse.json({ error: 'Failed to generate document link' }, { status: 500 });
    }

    // Get business name
    const { data: biz } = await supabase
      .from('businesses')
      .select('name')
      .eq('id', report.business_id)
      .single();

    // Track access count
    await supabase
      .from('customer_reports')
      .update({ access_count: (report.access_count || 0) + 1 })
      .eq('id', report.id);

    return NextResponse.json({
      url: signedUrlData.signedUrl,
      title: report.title,
      businessName: biz?.name || 'Business',
    });
  } catch (error) {
    logger.error('[DOCUMENTS] Verify access error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

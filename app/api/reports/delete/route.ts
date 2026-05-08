import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { reportId, businessId } = await request.json();
    if (!reportId || !businessId) {
      return NextResponse.json({ error: 'reportId and businessId required' }, { status: 400 });
    }

    // Verify business ownership
    const { data: biz } = await supabase
      .from('businesses')
      .select('id')
      .eq('id', businessId)
      .eq('owner_id', user.id)
      .single();

    if (!biz) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    // Get report to find file path
    const { data: report } = await supabase
      .from('customer_reports')
      .select('id, file_path')
      .eq('id', reportId)
      .eq('business_id', businessId)
      .single();

    if (!report) return NextResponse.json({ error: 'Document not found' }, { status: 404 });

    // Delete from storage
    if (report.file_path) {
      await supabase.storage.from('customer-reports').remove([report.file_path]);
    }

    // Delete DB record
    await supabase.from('customer_reports').delete().eq('id', reportId);

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[DOCUMENTS] Delete error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

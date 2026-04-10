import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const title = formData.get('title') as string;
    const customerPhone = formData.get('customerPhone') as string;
    const customerName = formData.get('customerName') as string;
    const businessId = formData.get('businessId') as string;

    if (!file || !title || !customerPhone || !businessId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Verify business ownership
    const { data: biz } = await supabase
      .from('businesses')
      .select('id')
      .eq('id', businessId)
      .eq('owner_id', user.id)
      .single();

    if (!biz) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }

    // Upload file to Supabase Storage
    const fileId = crypto.randomUUID();
    const filePath = `${businessId}/${fileId}.pdf`;
    const arrayBuffer = await file.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);

    const { error: uploadError } = await supabase.storage
      .from('customer-reports')
      .upload(filePath, buffer, {
        contentType: 'application/pdf',
        upsert: false,
      });

    if (uploadError) {
      logger.error('[REPORTS] Upload error:', uploadError);
      return NextResponse.json({ error: 'Failed to upload file' }, { status: 500 });
    }

    // Create report record
    const { data: report, error: insertError } = await supabase
      .from('customer_reports')
      .insert({
        business_id: businessId,
        customer_phone: customerPhone,
        customer_name: customerName || null,
        title,
        file_path: filePath,
        status: 'pending',
      })
      .select('id')
      .single();

    if (insertError) {
      logger.error('[REPORTS] Insert error:', insertError);
      return NextResponse.json({ error: 'Failed to create report record' }, { status: 500 });
    }

    return NextResponse.json({ id: report.id });
  } catch (error) {
    logger.error('[REPORTS] Upload error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

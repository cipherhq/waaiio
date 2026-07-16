import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

// Storage quotas per tier (in bytes)
const STORAGE_QUOTAS: Record<string, number> = {
  free: 50 * 1024 * 1024,       // 50 MB
  growth: 500 * 1024 * 1024,    // 500 MB
  business: 2 * 1024 * 1024 * 1024, // 2 GB
};

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB per file

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'doc-upload'), 20, 60_000);
    if (rateLimit) return rateLimit;

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

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'File too large. Maximum size is 10MB.' }, { status: 413 });
    }

    // Validate file type (check magic bytes for PDF: %PDF)
    const headerBytes = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    const header = String.fromCharCode(...headerBytes);
    if (!header.startsWith('%PDF')) {
      return NextResponse.json({ error: 'Only PDF files are allowed.' }, { status: 400 });
    }

    // Verify business ownership and get tier
    const { data: biz } = await supabase
      .from('businesses')
      .select('id, subscription_tier')
      .eq('id', businessId)
      .eq('owner_id', user.id)
      .single();

    if (!biz) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }

    // Check storage quota
    const serviceClient = createServiceClient();
    const { data: usageData } = await serviceClient
      .from('customer_reports')
      .select('file_size')
      .eq('business_id', businessId);

    const currentUsage = (usageData || []).reduce((sum, r) => sum + (r.file_size || 0), 0);
    const quota = STORAGE_QUOTAS[biz.subscription_tier || 'free'] || STORAGE_QUOTAS.free;

    if (currentUsage + file.size > quota) {
      const usedMB = Math.round(currentUsage / (1024 * 1024));
      const quotaMB = Math.round(quota / (1024 * 1024));
      return NextResponse.json({
        error: `Storage limit reached (${usedMB}MB of ${quotaMB}MB used). Delete old documents or upgrade your plan.`,
      }, { status: 413 });
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
      logger.error('[DOCUMENTS] Upload error:', uploadError);
      return NextResponse.json({ error: 'Failed to upload file' }, { status: 500 });
    }

    // Create document record with file size
    const { data: report, error: insertError } = await supabase
      .from('customer_reports')
      .insert({
        business_id: businessId,
        customer_phone: customerPhone,
        customer_name: customerName || null,
        title,
        file_path: filePath,
        file_size: file.size,
        status: 'pending',
      })
      .select('id')
      .single();

    if (insertError) {
      logger.error('[DOCUMENTS] Insert error:', insertError);
      // Clean up uploaded file
      await supabase.storage.from('customer-reports').remove([filePath]);
      return NextResponse.json({ error: 'Failed to create document record' }, { status: 500 });
    }

    return NextResponse.json({ id: report.id });
  } catch (error) {
    logger.error('[DOCUMENTS] Upload error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';

export async function POST(request: NextRequest) {
  const limit = rateLimitResponse(getRateLimitKey(request, 'upload-products'), 15, 60_000);
  if (limit) return limit;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  const businessId = formData.get('business_id') as string | null;

  if (!file || !businessId) {
    return NextResponse.json(
      { error: 'Missing required fields: file, business_id' },
      { status: 400 },
    );
  }

  // Verify user owns the business
  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', businessId)
    .eq('owner_id', user.id)
    .maybeSingle();

  if (!biz) {
    return NextResponse.json({ error: 'Business not found or unauthorized' }, { status: 403 });
  }

  // Validate file type (include common MIME variants)
  const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/x-png', 'image/webp', 'image/gif', 'image/svg+xml', 'image/heic', 'image/heif'];
  if (!allowed.includes(file.type)) {
    return NextResponse.json({ error: `File type "${file.type}" not supported. Use JPEG, PNG, WebP, GIF, SVG, or HEIC.` }, { status: 400 });
  }

  // Validate file size (5MB max)
  if (file.size > 5 * 1024 * 1024) {
    return NextResponse.json({ error: 'Image must be under 5MB' }, { status: 400 });
  }

  // Sanitize filename: strip path separators, limit to safe chars, truncate
  const safeName = file.name
    .replace(/[\/\\\.\.]+/g, '_')
    .replace(/[^a-zA-Z0-9.\-_]/g, '_')
    .slice(0, 100) || 'file';
  const ext = safeName.split('.').pop() || 'jpg';
  // Path must start with business_id — storage RLS checks (foldername(name))[1] = business_id
  const path = `${businessId}/products/${Date.now()}.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  // Use service client for storage upload (bypasses storage RLS — ownership already verified above)
  const serviceClient = createServiceClient();
  const { error: uploadError } = await serviceClient.storage
    .from('business-documents')
    .upload(path, buffer, {
      contentType: file.type,
      upsert: false,
    });

  if (uploadError) {
    console.error('[PRODUCT-UPLOAD] Storage error:', uploadError.message);
    return NextResponse.json({ error: 'Upload failed. Please try again.' }, { status: 500 });
  }

  const { data: urlData } = serviceClient.storage
    .from('business-documents')
    .getPublicUrl(path);

  return NextResponse.json({ success: true, url: urlData.publicUrl });
}

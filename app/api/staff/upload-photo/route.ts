import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';

export async function POST(request: NextRequest) {
  const limit = rateLimitResponse(getRateLimitKey(request, 'upload-staff'), 15, 60_000);
  if (limit) return limit;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  const businessId = formData.get('businessId') as string | null;
  const staffId = formData.get('staffId') as string | null;

  if (!file || !businessId || !staffId) {
    return NextResponse.json(
      { error: 'Missing required fields: file, businessId, staffId' },
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

  // Validate file type
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!allowed.includes(file.type)) {
    return NextResponse.json({ error: 'Only JPEG, PNG, WebP, and GIF images are allowed' }, { status: 400 });
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
  const path = `staff-photos/${businessId}/${Date.now()}.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const { error: uploadError } = await supabase.storage
    .from('business-documents')
    .upload(path, buffer, {
      contentType: file.type,
      upsert: false,
    });

  if (uploadError) {
    console.error('[STAFF-UPLOAD] Storage error:', uploadError.message);
    return NextResponse.json({ error: 'Upload failed. Please try again.' }, { status: 500 });
  }

  const { data: urlData } = supabase.storage
    .from('business-documents')
    .getPublicUrl(path);

  // Update staff record with photo URL
  const serviceClient = createServiceClient();
  const { error: updateError } = await serviceClient
    .from('business_staff')
    .update({ photo_url: urlData.publicUrl })
    .eq('id', staffId)
    .eq('business_id', businessId);

  if (updateError) {
    return NextResponse.json({ error: 'Failed to update staff photo' }, { status: 500 });
  }

  return NextResponse.json({ success: true, url: urlData.publicUrl });
}

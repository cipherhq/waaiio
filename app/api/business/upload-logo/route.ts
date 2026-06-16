import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { validateFileSignature } from '@/lib/security/validate-file';

export async function POST(request: NextRequest) {
  const limit = rateLimitResponse(getRateLimitKey(request, 'upload-logo'), 10, 60_000);
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

  // Validate file type
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.type)) {
    return NextResponse.json({ error: 'Only JPEG, PNG, and WebP images are allowed' }, { status: 400 });
  }

  // Validate file size (2MB max)
  if (file.size > 2 * 1024 * 1024) {
    return NextResponse.json({ error: 'Image must be under 2MB' }, { status: 400 });
  }

  // Validate magic bytes — reject files whose content doesn't match claimed type
  const buffer = Buffer.from(await file.arrayBuffer());
  const detected = validateFileSignature(buffer, file.type);
  if (!detected) {
    return NextResponse.json({ error: 'File content does not match its type. Upload rejected.' }, { status: 400 });
  }

  // Sanitize filename: strip path separators, limit to safe chars, truncate
  const safeName = file.name
    .replace(/[\/\\\.\.]+/g, '_')
    .replace(/[^a-zA-Z0-9.\-_]/g, '_')
    .slice(0, 100) || 'file';
  const ext = safeName.split('.').pop() || 'jpg';
  const path = `logos/${businessId}/${Date.now()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from('business-documents')
    .upload(path, buffer, {
      contentType: file.type,
      upsert: false,
    });

  if (uploadError) {
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }

  const { data: urlData } = supabase.storage
    .from('business-documents')
    .getPublicUrl(path);

  // Update business logo_url
  const { error: updateError } = await supabase
    .from('businesses')
    .update({ logo_url: urlData.publicUrl })
    .eq('id', businessId);

  if (updateError) {
    return NextResponse.json({ error: 'Failed to update logo' }, { status: 500 });
  }

  return NextResponse.json({ success: true, url: urlData.publicUrl });
}

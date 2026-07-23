import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { validateFileSignature } from '@/lib/security/validate-file';
import { sanitizeImage } from '@/lib/security/sanitize-image';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';

export async function POST(request: NextRequest) {
  const limit = await rateLimitResponseAsync(getRateLimitKey(request, 'upload-services'), 15, 60_000);
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
  const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/x-png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];
  if (!allowed.includes(file.type)) {
    return NextResponse.json({ error: `File type "${file.type}" not supported. Use JPEG, PNG, WebP, GIF, or HEIC.` }, { status: 400 });
  }

  // Validate file size (5MB max)
  if (file.size > 5 * 1024 * 1024) {
    return NextResponse.json({ error: 'Image must be under 5MB' }, { status: 400 });
  }

  // Validate magic bytes — reject files that don't match their claimed type
  const buffer = Buffer.from(await file.arrayBuffer());
  const detected = validateFileSignature(buffer, file.type);
  if (!detected) {
    return NextResponse.json({ error: 'File content does not match its type. Upload rejected.' }, { status: 400 });
  }

  // Re-encode through Sharp — strips metadata/payloads, validates it's a real image
  let cleanBuffer: Buffer;
  let cleanContentType: string;
  let cleanExt: string;
  try {
    const sanitized = await sanitizeImage(buffer);
    cleanBuffer = sanitized.buffer;
    cleanContentType = sanitized.contentType;
    cleanExt = sanitized.format === 'png' ? 'png' : sanitized.format === 'webp' ? 'webp' : 'jpg';
  } catch {
    return NextResponse.json({ error: 'File is not a valid image. Upload rejected.' }, { status: 400 });
  }

  const path = `${businessId}/services/${Date.now()}.${cleanExt}`;

  const { error: uploadError } = await supabase.storage
    .from('business-documents')
    .upload(path, cleanBuffer, {
      contentType: cleanContentType,
      upsert: false,
    });

  if (uploadError) {
    logger.withContext({ op: 'service-upload.storage', ...safeLogErrorContext(uploadError) }).error('[SERVICE-UPLOAD] Upload error');
    return NextResponse.json({ error: 'Upload failed. Please try again.' }, { status: 500 });
  }

  const { data: urlData } = supabase.storage
    .from('business-documents')
    .getPublicUrl(path);

  return NextResponse.json({ success: true, url: urlData.publicUrl });
}

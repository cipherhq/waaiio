import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { validateFileSignature } from '@/lib/security/validate-file';
import { sanitizeImage } from '@/lib/security/sanitize-image';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';

export async function POST(request: NextRequest) {
  const limit = await rateLimitResponseAsync(getRateLimitKey(request, 'upload-verification'), 10, 60_000);
  if (limit) return limit;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  const businessId = formData.get('business_id') as string | null;
  const docType = formData.get('type') as string | null;

  if (!file || !businessId || !docType) {
    return NextResponse.json(
      { error: 'Missing required fields: file, business_id, type' },
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

  // Sanitize filename: strip path separators, limit to safe chars, truncate
  const safeName = file.name
    .replace(/[\/\\\.\.]+/g, '_')
    .replace(/[^a-zA-Z0-9.\-_]/g, '_')
    .slice(0, 100) || 'file';

  // Validate file type
  const ext = safeName.split('.').pop()?.toLowerCase() || '';
  const allowedExts = ['pdf', 'jpg', 'jpeg', 'png', 'webp'];
  if (!allowedExts.includes(ext)) {
    return NextResponse.json({ error: 'Invalid file type. Allowed: PDF, JPG, PNG, WebP' }, { status: 400 });
  }

  const allowedMimes = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
  if (!allowedMimes.includes(file.type)) {
    return NextResponse.json({ error: 'Invalid file type' }, { status: 400 });
  }

  // File size limit (10MB)
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: 'File too large. Maximum 10MB' }, { status: 400 });
  }

  // Validate magic bytes — reject files whose content doesn't match claimed type
  const buffer = Buffer.from(await file.arrayBuffer());
  const detected = validateFileSignature(buffer, file.type);
  if (!detected) {
    return NextResponse.json({ error: 'File content does not match its type. Upload rejected.' }, { status: 400 });
  }

  // Re-encode images through Sharp — strips metadata/payloads, validates it's a real image
  // PDFs pass through unchanged (only images are sanitized)
  let uploadBuffer: Buffer = buffer;
  let uploadContentType: string = file.type;
  let uploadExt: string = ext;
  if (file.type !== 'application/pdf') {
    try {
      const sanitized = await sanitizeImage(buffer);
      uploadBuffer = sanitized.buffer;
      uploadContentType = sanitized.contentType;
      uploadExt = sanitized.format === 'png' ? 'png' : sanitized.format === 'webp' ? 'webp' : 'jpg';
    } catch {
      return NextResponse.json({ error: 'File is not a valid image. Upload rejected.' }, { status: 400 });
    }
  }

  // Upload to Supabase Storage
  const path = `verification/${businessId}/${docType}-${Date.now()}.${uploadExt}`;

  const { error: uploadError } = await supabase.storage
    .from('business-documents')
    .upload(path, uploadBuffer, {
      contentType: uploadContentType,
      upsert: false,
    });

  if (uploadError) {
    logger.withContext({ op: 'verification-upload.storage', ...safeLogErrorContext(uploadError) }).error('[VERIFICATION-UPLOAD] Storage error');
    return NextResponse.json({ error: 'Upload failed. Please try again.' }, { status: 500 });
  }

  const { data: urlData } = supabase.storage
    .from('business-documents')
    .getPublicUrl(path);

  // Create document record
  const { data: doc, error: insertError } = await supabase
    .from('business_documents')
    .insert({
      business_id: businessId,
      type: docType,
      file_url: urlData.publicUrl,
      file_name: safeName,
      status: 'pending',
    })
    .select('id')
    .single();

  if (insertError) {
    return NextResponse.json({ error: 'Failed to save document record' }, { status: 500 });
  }

  return NextResponse.json({ success: true, document_id: doc.id, file_url: urlData.publicUrl });
}

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';

export async function POST(request: NextRequest) {
  const limit = rateLimitResponse(getRateLimitKey(request, 'upload-audio'), 20, 60_000);
  if (limit) return limit;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  const businessId = formData.get('businessId') as string | null;

  if (!file || !businessId) {
    return NextResponse.json(
      { error: 'Missing required fields: file, businessId' },
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

  // Validate MIME type
  const allowed = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg'];
  if (!allowed.includes(file.type)) {
    return NextResponse.json({ error: 'Only WebM, OGG, MP4, and MPEG audio files are allowed' }, { status: 400 });
  }

  // Validate file size (16MB max)
  if (file.size > 16 * 1024 * 1024) {
    return NextResponse.json({ error: 'Audio must be under 16MB' }, { status: 400 });
  }

  // Sanitize filename: strip path separators, limit to safe chars, truncate
  const safeName = file.name
    .replace(/[\/\\\.\.]+/g, '_')
    .replace(/[^a-zA-Z0-9.\-_]/g, '_')
    .slice(0, 100) || 'file';
  const ext = file.type.includes('webm') ? 'webm' : file.type.includes('ogg') ? 'ogg' : file.type.includes('mp4') ? 'mp4' : 'mp3';
  const path = `chat-audio/${businessId}/${Date.now()}-${safeName}.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const { error: uploadError } = await supabase.storage
    .from('business-documents')
    .upload(path, buffer, {
      contentType: file.type,
      upsert: false,
    });

  if (uploadError) {
    console.error('[AUDIO-UPLOAD] Storage error:', uploadError.message);
    return NextResponse.json({ error: 'Upload failed. Please try again.' }, { status: 500 });
  }

  const { data: urlData } = supabase.storage
    .from('business-documents')
    .getPublicUrl(path);

  return NextResponse.json({ success: true, url: urlData.publicUrl });
}

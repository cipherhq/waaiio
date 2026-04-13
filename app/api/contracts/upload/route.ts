import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST(request: NextRequest) {
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
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  const allowedExts = ['pdf', 'jpg', 'jpeg', 'png'];
  if (!allowedExts.includes(ext)) {
    return NextResponse.json({ error: 'Invalid file type. Allowed: PDF, JPG, PNG' }, { status: 400 });
  }

  const allowedMimes = ['application/pdf', 'image/jpeg', 'image/png'];
  if (!allowedMimes.includes(file.type)) {
    return NextResponse.json({ error: 'Invalid file type' }, { status: 400 });
  }

  // File size limit (10MB)
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: 'File too large. Maximum 10MB' }, { status: 400 });
  }

  // Upload to Supabase Storage
  const path = `${businessId}/uploads/${Date.now()}-${file.name}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const { error: uploadError } = await supabase.storage
    .from('contracts')
    .upload(path, buffer, {
      contentType: file.type,
      upsert: false,
    });

  if (uploadError) {
    return NextResponse.json({ error: 'Upload failed: ' + uploadError.message }, { status: 500 });
  }

  return NextResponse.json({ file_url: path, file_name: file.name });
}

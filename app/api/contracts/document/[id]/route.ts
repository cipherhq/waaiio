import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();

  // Fetch contract
  const { data: contract, error } = await supabase
    .from('contracts')
    .select('id, business_id, template_url, token')
    .eq('id', id)
    .single();

  if (error || !contract || !contract.template_url) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 });
  }

  // Auth: either business owner or signer with valid token
  const signerToken = request.nextUrl.searchParams.get('token');
  const { data: { user } } = await supabase.auth.getUser();

  let authorized = false;

  if (user) {
    const { data: biz } = await supabase
      .from('businesses')
      .select('id')
      .eq('id', contract.business_id)
      .eq('owner_id', user.id)
      .maybeSingle();
    if (biz) authorized = true;
  }

  if (!authorized && signerToken && signerToken === contract.token) {
    authorized = true;
  }

  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  // Download from storage
  const { data: fileData, error: downloadError } = await supabase.storage
    .from('contracts')
    .download(contract.template_url);

  if (downloadError || !fileData) {
    return NextResponse.json({ error: 'Failed to download document' }, { status: 500 });
  }

  // Determine content type from file extension
  const ext = contract.template_url.split('.').pop()?.toLowerCase() || '';
  const contentTypes: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
  };
  const contentType = contentTypes[ext] || 'application/octet-stream';

  // Extract filename
  const fileName = contract.template_url.split('/').pop() || 'document';

  const buffer = Buffer.from(await fileData.arrayBuffer());

  return new NextResponse(buffer, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="${fileName}"`,
      'Cache-Control': 'private, max-age=3600',
    },
  });
}

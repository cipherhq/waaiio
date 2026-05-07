import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const signerToken = searchParams.get('token');

    const service = createServiceClient();

    // Fetch contract (service client to bypass RLS for unauthenticated signers)
    const { data: contract, error } = await service
      .from('contracts')
      .select('id, business_id, title, signed_url, status, token')
      .eq('id', id)
      .single();

    if (error || !contract) {
      return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
    }

    if (contract.status !== 'signed' || !contract.signed_url) {
      return NextResponse.json({ error: 'No signed PDF available' }, { status: 404 });
    }

    // Auth: either the business owner or the signer (via token)
    let authorized = false;

    if (signerToken && contract.token === signerToken) {
      authorized = true;
    }

    // Also check multi-signer tokens
    if (!authorized && signerToken) {
      const { data: signer } = await service
        .from('contract_signers')
        .select('id')
        .eq('contract_id', contract.id)
        .eq('token', signerToken)
        .maybeSingle();
      if (signer) authorized = true;
    }

    if (!authorized) {
      try {
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const { data: biz } = await service
            .from('businesses')
            .select('id')
            .eq('id', contract.business_id)
            .eq('owner_id', user.id)
            .maybeSingle();
          if (biz) authorized = true;
        }
      } catch {
        // No session available
      }
    }

    if (!authorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check if signed_url is a PDF path
    if (!contract.signed_url.endsWith('.pdf')) {
      return NextResponse.json({ error: 'No signed PDF available for this contract' }, { status: 404 });
    }

    // Download from storage
    const { data: file, error: downloadError } = await service.storage
      .from('contracts')
      .download(contract.signed_url);

    if (downloadError || !file) {
      console.error('Failed to download PDF:', downloadError);
      return NextResponse.json({ error: 'Failed to download PDF' }, { status: 500 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const filename = `${contract.title.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-')}-signed.pdf`;
    const viewInline = searchParams.get('view') === 'true';

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `${viewInline ? 'inline' : 'attachment'}; filename="${filename}"`,
        'Content-Length': String(buffer.length),
      },
    });
  } catch (err) {
    console.error('contracts/pdf error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

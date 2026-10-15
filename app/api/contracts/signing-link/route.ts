import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * GET /api/contracts/signing-link?signer_id=<uuid>
 *
 * Returns the signing URL for a contract_signers row.  The signing token is
 * fetched server-side via the service client so it never lands in the browser
 * as part of a column-level SELECT response.
 *
 * Access control: the requesting user must own the business that owns the
 * contract the signer belongs to.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const signerId = request.nextUrl.searchParams.get('signer_id');
  if (!signerId) {
    return NextResponse.json({ error: 'signer_id is required' }, { status: 400 });
  }

  const service = createServiceClient();

  // Fetch signer token server-side — never exposed via column-level SELECT
  const { data: signer } = await service
    .from('contract_signers')
    .select('id, token, contract_id')
    .eq('id', signerId)
    .single();

  if (!signer) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Verify the requesting user owns the business that owns the contract
  const { data: contract } = await service
    .from('contracts')
    .select('business_id')
    .eq('id', signer.contract_id)
    .single();

  if (!contract) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', contract.business_id)
    .eq('owner_id', user.id)
    .maybeSingle();

  if (!biz) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  return NextResponse.json({ url: `/sign/${signer.token}` });
}

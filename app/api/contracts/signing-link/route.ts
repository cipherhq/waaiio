import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';

/**
 * GET /api/contracts/signing-link?signer_id=<uuid>
 *
 * Returns the signing URL for a contract_signers row.  The signing token is
 * fetched server-side via the service client so it never lands in the browser
 * as part of a column-level SELECT response.
 *
 * Access control: the requesting user must own the business that owns the
 * contract the signer belongs to.
 *
 * Security: signer_id is validated as a canonical UUID before any DB query to
 * prevent injection via service-role query parameters.  Cache-Control: no-store
 * on all responses to prevent signing-URL leakage via shared caches.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store',
  'Pragma': 'no-cache',
};

function noCache(res: NextResponse): NextResponse {
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('Pragma', 'no-cache');
  return res;
}

export async function GET(request: NextRequest) {
  // Rate-limit: 30 requests per minute per IP/user key
  const rl = await rateLimitResponseAsync(
    getRateLimitKey(request, 'contract-signing-link'),
    30,
    60_000,
  );
  if (rl) return rl;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return noCache(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
  }

  const signerId = request.nextUrl.searchParams.get('signer_id');
  if (!signerId) {
    return noCache(NextResponse.json({ error: 'signer_id is required' }, { status: 400 }));
  }

  // Validate canonical UUID format before any service-role query
  if (!UUID_RE.test(signerId)) {
    return noCache(NextResponse.json({ error: 'signer_id must be a valid UUID' }, { status: 400 }));
  }

  const service = createServiceClient();

  // Fetch signer token server-side — never exposed via column-level SELECT
  const { data: signer } = await service
    .from('contract_signers')
    .select('id, token, contract_id')
    .eq('id', signerId)
    .single();

  if (!signer) {
    return noCache(NextResponse.json({ error: 'Not found' }, { status: 404 }));
  }

  // Verify the requesting user owns the business that owns the contract
  const { data: contract } = await service
    .from('contracts')
    .select('business_id')
    .eq('id', signer.contract_id)
    .single();

  if (!contract) {
    return noCache(NextResponse.json({ error: 'Not found' }, { status: 404 }));
  }

  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', contract.business_id)
    .eq('owner_id', user.id)
    .maybeSingle();

  if (!biz) {
    // Return 404 (not 403) so callers cannot probe whether a signer ID exists
    // by observing the difference between "not found" and "not your contract".
    return noCache(NextResponse.json({ error: 'Not found' }, { status: 404 }));
  }

  return noCache(NextResponse.json({ url: `/sign/${signer.token}` }));
}

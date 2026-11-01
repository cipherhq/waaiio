import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { verifyMerchantStepUp, MerchantStepUpError } from '@/lib/merchant-step-up';

/**
 * POST /api/settings/whatsapp-channel/step-up/verify
 *
 * Verifies a merchant MFA step-up with a TOTP code.
 * Returns refreshed session tokens.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { stepUpId, code } = body;

  if (!stepUpId || !code) {
    return NextResponse.json({ error: 'Missing stepUpId or code' }, { status: 400 });
  }

  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) return NextResponse.json({ error: 'No active session' }, { status: 401 });

  const { createServiceClient } = await import('@/lib/supabase/service');
  const service = createServiceClient();
  const { data: claimsData } = await service.auth.getClaims(token);
  const claims = claimsData?.claims as Record<string, unknown> | undefined;
  const sessionId = claims?.session_id as string | undefined;
  const claimsSub = claims?.sub as string | undefined;
  if (!sessionId) return NextResponse.json({ error: 'Cannot determine session' }, { status: 401 });
  if (claimsSub !== user.id) {
    return NextResponse.json({ error: 'Token identity mismatch' }, { status: 401 });
  }

  try {
    const result = await verifyMerchantStepUp(
      user.id,
      sessionId,
      token,
      stepUpId,
      code,
    );

    return NextResponse.json({
      success: true,
      session: {
        access_token: result.access_token,
        refresh_token: result.refresh_token,
      },
    });
  } catch (err) {
    if (err instanceof MerchantStepUpError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 });
  }
}

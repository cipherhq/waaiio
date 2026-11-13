import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { verifyPasskeyStepUp, verifyStepUp, StepUpError } from '@/lib/admin-step-up';
import { adminCorsHeaders } from '@/lib/admin-cors';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: adminCorsHeaders(request.headers.get('origin')) });
}

export async function POST(request: NextRequest) {
  const cors = adminCorsHeaders(request.headers.get('origin'));
  try {
    const admin = await requirePlatformAdmin(request);
    if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: cors });

    const body = await request.json();
    const { stepUpId, code, method } = body;

    // Passkey: the browser has just tapped the passkey through Supabase Auth;
    // this request carries the refreshed token. No session is returned.
    if (method === 'passkey') {
      if (!stepUpId || typeof stepUpId !== 'string') {
        return NextResponse.json({ error: 'stepUpId required' }, { status: 400, headers: cors });
      }
      await verifyPasskeyStepUp(admin, stepUpId);
      return NextResponse.json({ verified: true }, { headers: { ...cors, 'Cache-Control': 'no-store' } });
    }

    if (!stepUpId || !code || typeof code !== 'string' || code.length !== 6) {
      return NextResponse.json({ error: 'stepUpId and 6-digit code required' }, { status: 400, headers: cors });
    }

    const session = await verifyStepUp(admin, stepUpId, code);
    return NextResponse.json({ verified: true, session }, {
      headers: { ...cors, 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    if (err instanceof StepUpError) {
      return NextResponse.json({ error: err.message, ...(err.restartRequired ? { code: 'STEP_UP_RESTART_REQUIRED' } : {}) }, { status: 400, headers: cors });
    }
    return NextResponse.json({ error: 'Verification failed' }, { status: 500, headers: cors });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { verifyStepUp, StepUpError } from '@/lib/admin-step-up';
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
    const { stepUpId, code } = body;

    if (!stepUpId || !code || typeof code !== 'string' || code.length !== 6) {
      return NextResponse.json({ error: 'stepUpId and 6-digit code required' }, { status: 400, headers: cors });
    }

    await verifyStepUp(admin, stepUpId, code);
    return NextResponse.json({ verified: true }, { headers: cors });
  } catch (err) {
    if (err instanceof StepUpError) {
      return NextResponse.json({ error: err.message }, { status: 400, headers: cors });
    }
    return NextResponse.json({ error: 'Verification failed' }, { status: 500, headers: cors });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/api-auth';
import { checkRateLimitAsync } from '@/lib/rate-limit';
import { EnrollmentError, failure, issueInvitation, mutationBody, uuid } from '@/lib/merchant-notifications/enrollment';
export async function POST(request: NextRequest) {
  try {
    const body = await mutationBody(request);
    uuid(body.business_id);
    const id = uuid(body.id);
    const auth = await authenticateRequest(request,{requireBusinessOwnership:true,businessIdKey:'business_id',body});
    if (auth instanceof NextResponse) return auth;
    if (!(await checkRateLimitAsync(`merchant-invite:${auth.user.id}`,20,3600000)).allowed) throw new EnrollmentError('Too many invitations. Please try again later.',429);
    return NextResponse.json(await issueInvitation(auth.service,auth.businessId!,id),{headers:{'Cache-Control':'no-store'}});
  } catch(error) { return failure(error); }
}

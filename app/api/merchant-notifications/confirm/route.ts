import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { checkRateLimitAsync } from '@/lib/rate-limit';
import { EnrollmentError, failure, hashInvitation, mutationBody, requireEnabled, validToken } from '@/lib/merchant-notifications/enrollment';
export async function POST(request: NextRequest) {
  try {
    const body = await mutationBody(request);
    requireEnabled();
    if (body.accept !== true || !validToken(body.token)) throw new EnrollmentError('Explicit confirmation and a valid invitation are required.');
    const hash = hashInvitation(body.token);
    if (!(await checkRateLimitAsync(`merchant-confirm:${hash}`,10,60000)).allowed) throw new EnrollmentError('Please try again later.',429);
    const {data,error} = await createServiceClient().rpc('consume_merchant_notification_invitation',{p_token_hash:hash,p_channel:'email',p_address:null,p_channel_id:null});
    if (error) throw error;
    if (!data?.verified) throw new EnrollmentError('This invitation is invalid or expired. Request a new invitation.');
    return NextResponse.json({verified:true},{headers:{'Cache-Control':'no-store'}});
  } catch(error) { return failure(error); }
}

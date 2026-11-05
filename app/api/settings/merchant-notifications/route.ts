import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/api-auth';
import { isMerchantNotificationsEnabled } from '@/lib/merchant-notifications/types';
import { EnrollmentError, failure, missingSchema, mutationBody, normalizeAddress, RECIPIENT_FIELDS, requireEnabled, sharedChannel, uuid, validateEvents, validateLabel } from '@/lib/merchant-notifications/enrollment';

export async function GET(request: NextRequest) {
  try {
    uuid(request.nextUrl.searchParams.get('business_id'));
    const auth = await authenticateRequest(request,{requireBusinessOwnership:true,businessIdKey:'business_id'});
    if (auth instanceof NextResponse) return auth;
    const {data,error} = await auth.service.from('merchant_notification_recipients').select(RECIPIENT_FIELDS).eq('business_id',auth.businessId!).is('revoked_at',null).order('created_at');
    const enabled = isMerchantNotificationsEnabled();
    if (error && !(missingSchema(error) && !enabled)) throw error;
    return NextResponse.json({enabled,recipients:data || [],readiness:{whatsapp:enabled && !!await sharedChannel(auth.service,auth.businessId!),email:enabled && !!process.env.RESEND_API_KEY}},{headers:{'Cache-Control':'no-store'}});
  } catch(error) { return failure(error); }
}
async function mutate(request: NextRequest, method: 'POST'|'PATCH'|'DELETE') {
  try {
    const body = await mutationBody(request);
    uuid(body.business_id);
    const auth = await authenticateRequest(request,{requireBusinessOwnership:true,businessIdKey:'business_id',body});
    if (auth instanceof NextResponse) return auth;
    const businessId = auth.businessId!;
    if (method === 'POST') {
      requireEnabled();
      const address = normalizeAddress(body.channel,body.address);
      const {data,error} = await auth.service.rpc('create_merchant_notification_recipient',{p_business_id:businessId,p_label:validateLabel(body.label),p_channel:body.channel,p_address:address,p_events:validateEvents(body.events)});
      if (error) throw error;
      if (!data?.created) throw new EnrollmentError('Recipient already exists or the 20-recipient limit was reached.',409);
      return NextResponse.json({recipient:data.recipient},{status:201});
    }
    const id = uuid(body.id);
    let update: Record<string,unknown>;
    if (method === 'DELETE') update = {enabled:false,verified_at:null,consent_version:null,revoked_at:new Date().toISOString()};
    else {
      if ('address' in body || 'channel' in body) throw new EnrollmentError('Remove and add a recipient to change their destination.');
      if (!isMerchantNotificationsEnabled() && body.enabled !== false) requireEnabled();
      update = {};
      if ('enabled' in body) {
        if (typeof body.enabled !== 'boolean') throw new EnrollmentError('Invalid enabled value.');
        update.enabled = body.enabled;
      }
      if ('events' in body) update.events = validateEvents(body.events);
      if ('label' in body) update.label = validateLabel(body.label);
      if (!Object.keys(update).length) throw new EnrollmentError('No settings supplied.');
    }
    const {data,error} = await auth.service.from('merchant_notification_recipients').update(update).eq('id',id).eq('business_id',businessId).is('revoked_at',null).select(RECIPIENT_FIELDS).maybeSingle();
    if (error) throw error;
    if (!data) throw new EnrollmentError('Recipient not found.',404);
    return NextResponse.json(method === 'DELETE' ? {revoked:true} : {recipient:data});
  } catch(error) { return failure(error); }
}
export const POST = (request: NextRequest) => mutate(request,'POST');
export const PATCH = (request: NextRequest) => mutate(request,'PATCH');
export const DELETE = (request: NextRequest) => mutate(request,'DELETE');

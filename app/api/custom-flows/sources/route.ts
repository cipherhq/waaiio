import { NextResponse, type NextRequest } from 'next/server';
import { authorize, fail } from '@/lib/custom-flow-builder/server';
import { businessData } from '@/lib/bot/custom-flow/sources';
import { formatCurrencyCode } from '@/lib/constants';

export async function GET(request: NextRequest) {
  const params=request.nextUrl.searchParams;
  const auth=await authorize(params.get('businessId'));
  if(auth instanceof NextResponse)return auth;
  const kind=params.get('kind'), search=(params.get('q') ?? '').slice(0,80).replace(/[\\%_]/g,'\\$&');
  if(!['product','service','ticket_type'].includes(kind ?? ''))return fail('invalid_source',400);
  const query=kind==='product'
    ? auth.db.from('products').select('id,name,price').eq('business_id',auth.businessId).eq('is_active',true).eq('has_variants',false).is('deleted_at',null)
    : kind==='service'
      ? auth.db.from('services').select('id,name,price').eq('business_id',auth.businessId).eq('is_active',true).eq('price_is_variable',false).neq('service_type','giving').is('deleted_at',null)
      : auth.db.from('event_ticket_types').select('id,name,price,event_id,events!inner(business_id,status)').eq('events.business_id',auth.businessId).eq('events.status','published').eq('is_active',true);
  const {data,error}=await query.ilike('name',`%${search}%`).order('name').limit(100);
  if(error)return fail('read_failed',500);
  try {
    const settings=await businessData(auth.db,auth.businessId,[]);
    if(!/^[A-Z]{3}$/.test(settings.currency))return fail('missing_business_settings',422);
    const records=(data ?? []).filter(row=>Number.isFinite(Number(row.price)) && Number(row.price)>=0).map(row=>({
      name:row.name,price:formatCurrencyCode(Number(row.price),settings.currency),
      source:{version:1,kind,id:row.id,...(kind==='ticket_type' ? {event_id:(row as unknown as {event_id:string}).event_id} : {})},
    }));
    return NextResponse.json({records},{headers:{'Cache-Control':'no-store'}});
  }catch{return fail('read_failed',500);}
}

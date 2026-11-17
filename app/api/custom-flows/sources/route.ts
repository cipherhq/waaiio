import { NextResponse, type NextRequest } from 'next/server';
import { authorize, fail } from '@/lib/custom-flow-builder/server';
import { businessData } from '@/lib/bot/custom-flow/sources';
import { formatCurrencyCode } from '@/lib/constants';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isEventAvailable, todayUtc } from '@/lib/bot/custom-flow/handoff';

export async function GET(request: NextRequest) {
  const params=request.nextUrl.searchParams;
  const auth=await authorize(params.get('businessId'));
  if(auth instanceof NextResponse)return auth;
  const kind=params.get('kind'), search=(params.get('q') ?? '').slice(0,80).replace(/[\\%_]/g,'\\$&');
  if(kind==='event'||kind==='giving'||kind==='payment')return handoffRecords(auth.db,auth.businessId,kind,search);
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

/**
 * Records a "Use what you already have" step can start with (#1086): this
 * business's upcoming published events, or its active giving / payment
 * options. Read with the merchant's own RLS client and always scoped by
 * business_id; publish and runtime re-check each choice.
 */
async function handoffRecords(db: SupabaseClient, businessId: string, kind: 'event' | 'giving' | 'payment', search: string) {
  const now=new Date();
  const query=kind==='event'
    ? db.from('events').select('id,name,date,time,status,total_tickets,tickets_sold').eq('business_id',businessId).eq('status','published').gte('date',todayUtc(now)).order('date')
    : db.from('services').select('id,name').eq('business_id',businessId).eq('is_active',true).is('deleted_at',null)[kind==='giving'?'eq':'neq']('service_type','giving').order('name');
  const {data,error}=await query.ilike('name',`%${search}%`).limit(100);
  if(error)return fail('read_failed',500);
  // Same rule as publish and runtime: no sold-out or already-started events.
  const usable=kind==='event' ? (data ?? []).filter(row=>isEventAvailable(row as Record<string,unknown>,now)) : (data ?? []);
  const records=usable.map(row=>({id:row.id as string,name:row.name as string,...(kind==='event' ? {detail:(row as {date?:string}).date ?? ''} : {})}));
  return NextResponse.json({records},{headers:{'Cache-Control':'no-store'}});
}

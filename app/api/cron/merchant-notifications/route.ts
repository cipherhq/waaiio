import { NextResponse, type NextRequest } from 'next/server';
import { verifyCronAuth } from '@/lib/cron-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { dispatchMerchantNotifications } from '@/lib/merchant-notifications/delivery';
export const maxDuration = 60;
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;
  try {
    return NextResponse.json(await dispatchMerchantNotifications(createServiceClient()));
  } catch {
    return NextResponse.json({error:'Merchant notification dispatch could not complete'}, {status:503});
  }
}

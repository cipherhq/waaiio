import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { estimateSmsCampaign } from '@/lib/sms/campaign';
import { logger } from '@/lib/logger';

/**
 * SMS campaign estimate shown before sending (#1131): pages, Unicode, price
 * per page and total, charged from messaging credit. Sends nothing.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });

    const body = await request.json().catch(() => null) as { business_id?: unknown; message?: unknown; phones?: unknown } | null;
    const businessId = typeof body?.business_id === 'string' ? body.business_id : '';
    const message = typeof body?.message === 'string' ? body.message : '';
    const phones = Array.isArray(body?.phones) ? body.phones.filter((p): p is string => typeof p === 'string').slice(0, 500) : [];
    if (!businessId || message.length > 5000) {
      return NextResponse.json({ message: 'Missing business_id or message too long' }, { status: 400 });
    }

    const service = createServiceClient();
    const guard = await requireCapability(supabase, service, {
      businessId, userId: user.id, capability: 'broadcast', action: 'create_new',
    });
    if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

    const { data: business } = await service.from('businesses').select('country_code').eq('id', businessId).single();
    const estimate = await estimateSmsCampaign(service, { businessCountry: business?.country_code ?? null, phones, message });
    return NextResponse.json({ estimate });
  } catch (error) {
    logger.error('SMS estimate error:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ message: 'Something went wrong' }, { status: 500 });
  }
}

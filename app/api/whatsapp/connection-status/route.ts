import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * GET /api/whatsapp/connection-status?business_id=...
 *
 * Safe projection of candidate + active channel status.
 * No secrets (tokens, PINs) are returned. (H5)
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const businessId = request.nextUrl.searchParams.get('business_id');
  if (!businessId) return NextResponse.json({ error: 'Missing business_id' }, { status: 400 });

  // Verify ownership
  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', businessId)
    .eq('owner_id', user.id)
    .single();
  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

  const service = createServiceClient();

  // Active dedicated channel (authoritative)
  const { data: activeChannel } = await service
    .from('whatsapp_channels')
    .select('id, phone_number, display_name, connection_status, connection_method')
    .eq('business_id', businessId)
    .eq('channel_type', 'dedicated')
    .eq('is_active', true)
    .maybeSingle();

  // Open or recently-failed candidate (informational only)
  const { data: candidate } = await service
    .from('whatsapp_channel_candidates')
    .select('id, phone_number, display_name, status, failure_reason, updated_at')
    .eq('business_id', businessId)
    .in('status', ['pending', 'validating', 'ready', 'failed'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({
    active_channel: activeChannel ? {
      id: activeChannel.id,
      phone_number: activeChannel.phone_number,
      display_name: activeChannel.display_name,
      connection_status: activeChannel.connection_status,
      connection_method: activeChannel.connection_method,
    } : null,
    candidate: candidate ? {
      id: candidate.id,
      phone_number_display: candidate.phone_number?.replace(/(\+\d{1,3})\d+(\d{4})/, '$1****$2') || null,
      status: candidate.status,
      failure_reason: candidate.failure_reason,
      updated_at: candidate.updated_at,
    } : null,
  });
}

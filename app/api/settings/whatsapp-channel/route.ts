import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * GET /api/settings/whatsapp-channel?business_id=...
 * Returns the WhatsApp channel info for a business.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });

  const businessId = request.nextUrl.searchParams.get('business_id');
  if (!businessId) return NextResponse.json({ message: 'Missing business_id' }, { status: 400 });

  // Verify ownership
  const { data: business } = await supabase
    .from('businesses')
    .select('id, owner_id, wa_method')
    .eq('id', businessId)
    .single();

  if (!business || business.owner_id !== user.id) {
    return NextResponse.json({ message: 'Not found' }, { status: 404 });
  }

  // Get channel info
  const service = createServiceClient();
  const { data: channel } = await service
    .from('whatsapp_channels')
    .select('id, phone_number, channel_type, provider, connection_method, connection_status, display_name, is_active')
    .eq('business_id', businessId)
    .eq('channel_type', 'dedicated')
    .eq('is_active', true)
    .maybeSingle();

  return NextResponse.json({
    wa_method: business.wa_method || 'shared',
    channel: channel || null,
  });
}

/**
 * DELETE /api/settings/whatsapp-channel?business_id=...
 * Disconnects the dedicated WhatsApp channel and reverts to shared.
 */
export async function DELETE(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });

  const businessId = request.nextUrl.searchParams.get('business_id');
  if (!businessId) return NextResponse.json({ message: 'Missing business_id' }, { status: 400 });

  // Verify ownership
  const { data: business } = await supabase
    .from('businesses')
    .select('id, owner_id')
    .eq('id', businessId)
    .single();

  if (!business || business.owner_id !== user.id) {
    return NextResponse.json({ message: 'Not found' }, { status: 404 });
  }

  const service = createServiceClient();

  // Deactivate the dedicated channel
  await service
    .from('whatsapp_channels')
    .update({ is_active: false, connection_status: 'disconnected' })
    .eq('business_id', businessId)
    .eq('channel_type', 'dedicated');

  // Revert business to shared
  await service
    .from('businesses')
    .update({ wa_method: 'shared', whatsapp_channel_id: null })
    .eq('id', businessId);

  return NextResponse.json({ message: 'Disconnected' });
}

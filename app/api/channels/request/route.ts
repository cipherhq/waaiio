import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * POST /api/channels/request
 * Business owner requests a dedicated WhatsApp number.
 * This creates a pending request that an admin provisions via Meta Cloud API,
 * then inserts the whatsapp_channels row and links it to the business.
 *
 * Body: { business_id: string, phone_number?: string, notes?: string }
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }

    const { business_id, phone_number, notes } = await request.json();

    if (!business_id) {
      return NextResponse.json({ message: 'Missing business_id' }, { status: 400 });
    }

    // Verify ownership
    const { data: business } = await supabase
      .from('businesses')
      .select('id, owner_id, name, country_code')
      .eq('id', business_id)
      .single();

    if (!business || business.owner_id !== user.id) {
      return NextResponse.json({ message: 'Business not found or not owned by you' }, { status: 403 });
    }

    // Check if business already has a dedicated channel
    const service = createServiceClient();
    const { data: existingChannel } = await service
      .from('whatsapp_channels')
      .select('id')
      .eq('business_id', business_id)
      .eq('channel_type', 'dedicated')
      .eq('is_active', true)
      .maybeSingle();

    if (existingChannel) {
      return NextResponse.json({
        message: 'Your business already has a dedicated WhatsApp number',
        channel_id: existingChannel.id,
      });
    }

    // Create a notification/request for admin to provision
    // In production, this would create a support ticket or admin task
    await service.from('notifications').insert({
      business_id,
      type: 'channel_request',
      channel: 'system',
      body: JSON.stringify({
        business_name: business.name,
        country_code: business.country_code || 'NG',
        requested_phone: phone_number || null,
        notes: notes || null,
        user_id: user.id,
      }),
    });

    return NextResponse.json({
      message: 'Your dedicated number request has been submitted. Our team will set it up and notify you.',
      status: 'pending',
    });
  } catch (error) {
    return NextResponse.json(
      { message: 'Something went wrong' },
      { status: 500 },
    );
  }
}

import { NextResponse, type NextRequest } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

const META_APP_SECRET = process.env.META_APP_SECRET || '';

function verifyMetaSignature(rawBody: string, signature: string): boolean {
  if (!META_APP_SECRET || !signature) return false;
  const expected = createHmac('sha256', META_APP_SECRET).update(rawBody).digest('hex');
  const sig = signature.replace('sha256=', '');
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch { return false; }
}

/**
 * POST /api/whatsapp/flow-data
 *
 * WhatsApp Flows data_exchange endpoint.
 * Called by Meta when a user opens a dynamic flow.
 * Returns business-specific services, available times, etc.
 *
 * Meta sends: { flow_token, action, screen, data }
 * We return: { screen, data } with dynamic options
 */
export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();

    // Verify Meta signature
    if (!META_APP_SECRET) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }
    const signature = request.headers.get('x-hub-signature-256') || '';
    if (!verifyMetaSignature(rawBody, signature)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    const body = JSON.parse(rawBody);
    const { flow_token, action, screen, data } = body;

    logger.debug('[FLOW-DATA] Request:', { flow_token, action, screen });

    // flow_token format: "business_id:customer_phone"
    const [businessId] = (flow_token || '').split(':');

    if (!businessId) {
      return NextResponse.json({
        screen: 'SERVICE_SELECT',
        data: { services: [{ id: 'default', title: 'General Appointment' }] },
      });
    }

    const supabase = createServiceClient();

    if (action === 'data_exchange' || action === 'INIT') {
      // Fetch business services
      const { data: services } = await supabase
        .from('services')
        .select('id, name, price, duration_minutes')
        .eq('business_id', businessId)
        .eq('is_active', true)
        .order('name');

      const { data: business } = await supabase
        .from('businesses')
        .select('name, country_code, operating_hours')
        .eq('id', businessId)
        .single();

      // Build time slots from operating hours
      const timeSlots = generateTimeSlots(business?.operating_hours);

      // Format services for Flow dropdown
      const serviceOptions = (services || []).map(s => ({
        id: s.id,
        title: `${s.name}${s.price ? ` — ${s.price}` : ''}`,
      }));

      if (serviceOptions.length === 0) {
        serviceOptions.push({ id: 'default', title: 'General Appointment' });
      }

      return NextResponse.json({
        screen: 'SERVICE_SELECT',
        data: {
          services: serviceOptions,
          time_slots: timeSlots,
          business_name: business?.name || 'Business',
        },
      });
    }

    // Default response
    return NextResponse.json({
      screen: screen || 'SERVICE_SELECT',
      data: {},
    });
  } catch (error) {
    logger.error('[FLOW-DATA] Error:', error);
    return NextResponse.json({
      screen: 'SERVICE_SELECT',
      data: { services: [{ id: 'default', title: 'General Appointment' }] },
    });
  }
}

function generateTimeSlots(operatingHours: Record<string, any> | null): Array<{ id: string; title: string }> {
  // Default time slots if no operating hours set
  const defaults = [
    { id: '09:00', title: '9:00 AM' },
    { id: '10:00', title: '10:00 AM' },
    { id: '11:00', title: '11:00 AM' },
    { id: '12:00', title: '12:00 PM' },
    { id: '13:00', title: '1:00 PM' },
    { id: '14:00', title: '2:00 PM' },
    { id: '15:00', title: '3:00 PM' },
    { id: '16:00', title: '4:00 PM' },
    { id: '17:00', title: '5:00 PM' },
  ];

  if (!operatingHours) return defaults;

  // Get today's operating hours
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const today = days[new Date().getDay()];
  const todayHours = operatingHours[today];

  if (!todayHours || !todayHours.open) return defaults;

  const startHour = parseInt(todayHours.start?.split(':')[0] || '9');
  const endHour = parseInt(todayHours.end?.split(':')[0] || '17');
  const slots: Array<{ id: string; title: string }> = [];

  for (let h = startHour; h < endHour; h++) {
    const hour24 = `${h.toString().padStart(2, '0')}:00`;
    const hour12 = h > 12 ? `${h - 12}:00 PM` : h === 12 ? '12:00 PM' : `${h}:00 AM`;
    slots.push({ id: hour24, title: hour12 });
  }

  return slots.length > 0 ? slots : defaults;
}

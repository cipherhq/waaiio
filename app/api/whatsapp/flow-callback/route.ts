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
 * POST /api/whatsapp/flow-callback
 *
 * Receives data from completed WhatsApp Flows.
 * When a customer fills out a native Flow (booking form, order form),
 * Meta sends the collected data here.
 *
 * This endpoint processes the data and creates the booking/order
 * directly, bypassing the multi-step bot flow.
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
    const { flow_token, action, data, screen } = body as {
      flow_token: string;
      action: string; // 'complete' | 'data_exchange'
      data: Record<string, unknown>;
      screen: string;
    };

    logger.debug('[FLOW-CALLBACK] Received:', { action, screen, flow_token: flow_token?.slice(0, 10) });

    // Data exchange — Flow is requesting dynamic data (e.g., available time slots)
    if (action === 'data_exchange') {
      return handleDataExchange(screen, data);
    }

    // Flow completed — process the submission
    if (action === 'complete' || !action) {
      return handleFlowComplete(flow_token, data);
    }

    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    logger.error('[FLOW-CALLBACK] Error:', (error as Error).message);
    return NextResponse.json({ status: 'ok' });
  }
}

/**
 * Handle data exchange requests from WhatsApp Flows.
 * Flows can request dynamic data like available services, time slots, etc.
 */
async function handleDataExchange(screen: string, data: Record<string, unknown>) {
  const supabase = createServiceClient();
  const businessId = data.business_id as string;

  if (!businessId) {
    return NextResponse.json({ screen: 'error', data: { message: 'Missing business ID' } });
  }

  // Service list for booking flow
  if (screen === 'select_service') {
    const { data: services } = await supabase
      .from('services')
      .select('id, name, price, duration_minutes')
      .eq('business_id', businessId)
      .eq('is_active', true)
      .order('sort_order');

    return NextResponse.json({
      screen: 'select_service',
      data: {
        services: (services || []).map(s => ({
          id: s.id,
          title: s.name,
          description: s.price > 0 ? `${s.price} • ${s.duration_minutes}min` : `${s.duration_minutes}min`,
        })),
      },
    });
  }

  // Available time slots for a date
  if (screen === 'select_time') {
    const date = data.date as string;
    const serviceId = data.service_id as string;

    // Get business hours for the selected day
    const { data: biz } = await supabase
      .from('businesses')
      .select('operating_hours')
      .eq('id', businessId)
      .single();

    const dayName = new Date(date + 'T12:00').toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const hours = (biz?.operating_hours as Record<string, { open?: string; close?: string; closed?: boolean }>)?.[dayName];

    if (!hours || hours.closed) {
      return NextResponse.json({
        screen: 'select_time',
        data: { slots: [], message: 'Closed on this day' },
      });
    }

    // Generate 30-min slots
    const slots: Array<{ id: string; title: string }> = [];
    const [openH, openM] = (hours.open || '09:00').split(':').map(Number);
    const [closeH, closeM] = (hours.close || '17:00').split(':').map(Number);
    const startMin = openH * 60 + openM;
    const endMin = closeH * 60 + closeM;

    for (let m = startMin; m < endMin; m += 30) {
      const h = Math.floor(m / 60);
      const min = m % 60;
      const time = `${h.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`;
      const label = new Date(`2000-01-01T${time}`).toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: true,
      });
      slots.push({ id: time, title: label });
    }

    return NextResponse.json({
      screen: 'select_time',
      data: { slots },
    });
  }

  return NextResponse.json({ screen, data: {} });
}

/**
 * Handle flow completion — create the booking/order from the submitted data.
 */
async function handleFlowComplete(flowToken: string, data: Record<string, unknown>) {
  const supabase = createServiceClient();

  const flowType = data.flow_type as string;
  const businessId = data.business_id as string;
  const customerPhone = data.customer_phone as string;

  if (!businessId || !customerPhone) {
    logger.error('[FLOW-CALLBACK] Missing business_id or customer_phone');
    return NextResponse.json({ status: 'ok' });
  }

  if (flowType === 'booking') {
    const serviceId = data.service_id as string;
    const date = data.date as string;
    const time = data.time as string;
    const partySize = (data.party_size as number) || 1;
    const name = (data.customer_name as string) || '';

    // Get service details
    const { data: service } = await supabase
      .from('services')
      .select('name, price, duration_minutes, deposit_amount')
      .eq('id', serviceId)
      .single();

    if (!service) {
      logger.error('[FLOW-CALLBACK] Service not found:', serviceId);
      return NextResponse.json({ status: 'ok' });
    }

    // Generate reference code
    const refCode = `${businessId.slice(0, 4).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;

    const depositAmount = service.deposit_amount || 0;

    // Create booking
    const { error } = await supabase.from('bookings').insert({
      business_id: businessId,
      service_id: serviceId,
      date,
      time,
      party_size: partySize,
      guest_name: name,
      guest_phone: customerPhone,
      reference_code: refCode,
      deposit_amount: depositAmount,
      deposit_status: depositAmount > 0 ? 'pending' : 'none',
      status: depositAmount > 0 ? 'pending' : 'confirmed',
      total_amount: service.price * partySize,
      flow_type: 'scheduling',
      channel: 'whatsapp_flow',
    });

    if (error) {
      logger.error('[FLOW-CALLBACK] Booking insert error:', error);
    } else {
      logger.debug('[FLOW-CALLBACK] Booking created via Flow:', refCode);
    }
  }

  return NextResponse.json({ status: 'ok' });
}

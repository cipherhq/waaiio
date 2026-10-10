import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { generateFlowToken } from '@/lib/whatsapp-forms/flow-token';

/**
 * POST /api/forms/native-flow/send
 *
 * Owner-scoped endpoint to send a published WhatsApp native Flow to a recipient.
 *
 * GATE: This phase does NOT actually send the WhatsApp message.
 * It constructs the payload and returns it for verification.
 * Real sending requires separate provider authorization.
 *
 * Body: { businessId: string, formId: string, recipientPhone: string }
 */
export async function POST(request: NextRequest) {
  // ── Auth ──
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── Parse body ──
  let body: { businessId?: string; formId?: string; recipientPhone?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const { businessId, formId, recipientPhone } = body;

  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!businessId || !formId || !uuid.test(businessId) || !uuid.test(formId)) {
    return NextResponse.json({ error: 'Valid businessId and formId are required.' }, { status: 400 });
  }

  // Basic E.164 phone validation
  if (!recipientPhone || typeof recipientPhone !== 'string' || !/^\+?[1-9]\d{6,14}$/.test(recipientPhone)) {
    return NextResponse.json({ error: 'Valid recipientPhone in E.164 format is required.' }, { status: 400 });
  }

  // ── Verify business ownership ──
  const { data: business, error: ownershipError } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', businessId)
    .eq('owner_id', user.id)
    .maybeSingle();

  if (ownershipError) {
    return NextResponse.json({ error: 'Ownership check unavailable.' }, { status: 503 });
  }
  if (!business) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // ── Load form and verify status ──
  const { data: form, error: formError } = await supabase
    .from('forms')
    .select('id, business_id, title, meta_flow_id, meta_flow_status, native_flow_json, is_active')
    .eq('id', formId)
    .eq('business_id', businessId)
    .maybeSingle();

  if (formError) {
    return NextResponse.json({ error: 'Form lookup unavailable.' }, { status: 503 });
  }
  if (!form) {
    return NextResponse.json({ error: 'Form not found.' }, { status: 404 });
  }
  if (!form.is_active) {
    return NextResponse.json({ error: 'Form is inactive.' }, { status: 422 });
  }
  if (form.meta_flow_status !== 'published') {
    return NextResponse.json(
      { error: `Form must be published before sending. Current status: ${form.meta_flow_status ?? 'draft'}` },
      { status: 422 },
    );
  }
  if (!form.meta_flow_id) {
    return NextResponse.json({ error: 'Form has no Meta Flow asset ID.' }, { status: 422 });
  }

  // ── Generate signed flow token ──
  let flowToken: { token: string; expiresAt: number };
  try {
    flowToken = generateFlowToken(formId, recipientPhone, businessId);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Token generation failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // ── Construct WhatsApp interactive Flow message payload ──
  const whatsappPayload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipientPhone,
    type: 'interactive',
    interactive: {
      type: 'flow',
      header: {
        type: 'text',
        text: form.title,
      },
      body: {
        text: `Please fill out the form: ${form.title}`,
      },
      footer: {
        text: 'Powered by Waaiio',
      },
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_token: flowToken.token,
          flow_id: form.meta_flow_id,
          flow_cta: 'Open Form',
          mode: 'published',
          flow_action: 'navigate',
          flow_action_payload: {
            screen: 'FORM',
          },
        },
      },
    },
  };

  // ── GATE: Do NOT send. Return the constructed payload for verification. ──
  return NextResponse.json(
    {
      queued: false,
      reason: 'provider_send_not_authorized',
      payload: whatsappPayload,
      tokenExpiresAt: flowToken.expiresAt,
      notice: 'This payload would be sent to the Meta Cloud API. Actual sending requires separate provider authorization.',
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { compileNativeFormFlow, NativeFlowValidationError } from '@/lib/whatsapp-forms/native-flow';
import { encodeFlowToken } from '@/lib/whatsapp-forms/submission-handler';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

/**
 * POST /api/forms/native-flow/send
 *
 * Send a native WhatsApp Flow to a customer's phone number.
 * Requires the form to already have a published Meta Flow asset (flow_id in settings).
 * Owner-only — verifies business ownership before sending.
 *
 * Body: { formId, businessId, phone }
 */
export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'form-flow-send'), 20, 60_000);
    if (rateLimit) return rateLimit;

    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { formId, businessId, phone } = body;

    if (!formId || !businessId || !phone) {
      return NextResponse.json({ error: 'formId, businessId, and phone are required' }, { status: 400 });
    }

    // UUID validation
    const uuidRe = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    if (!uuidRe.test(formId) || !uuidRe.test(businessId)) {
      return NextResponse.json({ error: 'Invalid formId or businessId' }, { status: 400 });
    }

    // Verify ownership
    const { data: biz } = await supabase
      .from('businesses')
      .select('id, name')
      .eq('id', businessId)
      .eq('owner_id', user.id)
      .single();
    if (!biz) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Load form
    const serviceClient = createServiceClient();
    const { data: form, error: formError } = await serviceClient
      .from('forms')
      .select('id, business_id, title, description, fields, is_active, settings')
      .eq('id', formId)
      .eq('business_id', businessId)
      .single();

    if (formError || !form) {
      return NextResponse.json({ error: 'Form not found' }, { status: 404 });
    }

    if (!form.is_active) {
      return NextResponse.json({ error: 'Form is inactive' }, { status: 400 });
    }

    // Check for a published Meta Flow ID in settings
    const settings = form.settings as Record<string, unknown> | null;
    const metaFlowId = settings?.meta_flow_id as string | undefined;

    if (!metaFlowId) {
      return NextResponse.json({
        error: 'This form does not have a published WhatsApp Flow. Use the web form link or publish the Flow first.',
      }, { status: 422 });
    }

    // Validate form can compile (catches field issues before sending)
    try {
      compileNativeFormFlow(form);
    } catch (e) {
      if (e instanceof NativeFlowValidationError) {
        return NextResponse.json({ error: e.message }, { status: 422 });
      }
      throw e;
    }

    // Resolve WhatsApp channel
    const resolver = new ChannelResolver(serviceClient);
    const resolved = await resolver.resolveByBusinessId(businessId);

    if (!resolved?.sender?.sendFlow) {
      return NextResponse.json({ error: 'No WhatsApp channel configured' }, { status: 400 });
    }

    const toPhone = phone.startsWith('+') ? phone.slice(1) : phone;
    const normalizedPhone = phone.startsWith('+') ? phone : `+${phone}`;

    // Generate a flow token that carries form + business identity back on nfm_reply
    const flowToken = encodeFlowToken(form.id, businessId);

    // Create a pending response record to track the send
    await serviceClient.from('form_responses').insert({
      form_id: form.id,
      business_id: businessId,
      customer_phone: normalizedPhone,
      status: 'sent',
      channel: 'whatsapp_flow',
      answers: {},
      metadata: { flow_token: flowToken },
    });

    // Send the native WhatsApp Flow
    await resolved.sender.sendFlow({
      to: toPhone,
      bodyText: `${form.title}${form.description ? '\n' + form.description : ''}`,
      flowId: metaFlowId,
      flowCta: 'Fill Form',
      screen: 'FORM',
      flowToken,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[NATIVE-FLOW-SEND] Error:', error);
    return NextResponse.json({ error: 'Failed to send form' }, { status: 500 });
  }
}

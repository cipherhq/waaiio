import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { MetaCloudService } from '@/lib/channels/meta-cloud';
import { CAPABILITIES } from '@/lib/capabilities/types';
import { PROMO_TEMPLATE_CONTRACTS } from '@/lib/promotions/template-contracts';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';

const VALID_CAPABILITY_IDS = new Set<string>(CAPABILITIES.map(c => c.id));

/**
 * POST /api/whatsapp/templates/provision
 *
 * Auto-provisions required WhatsApp message templates on a business's WABA
 * when they enable capabilities that need them (e.g. WhatsApp Sign).
 *
 * Body: { business_id: string, capability: string }
 */

const SIGN_TEMPLATE_NAME = process.env.WHATSAPP_CONTRACT_TEMPLATE || 'document_signature_request';

interface TemplateDef {
  name: string;
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
  language: string;
  components: Array<{
    type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';
    format?: string;
    text?: string;
    buttons?: Array<{ type: string; text: string; url?: string }>;
    example?: { body_text?: string[][] };
  }>;
}

// Maps capability → required Meta WhatsApp message templates.
// These are submitted to Meta for approval and used for proactive outreach
// (outside the 24h conversation window).
const REQUIRED_TEMPLATES: Record<string, TemplateDef[]> = {
  whatsapp_sign: [
    {
      name: SIGN_TEMPLATE_NAME,
      category: 'UTILITY',
      language: 'en_US',
      components: [
        { type: 'HEADER', format: 'TEXT', text: 'Document Signing Request' },
        {
          type: 'BODY',
          text: 'Hi {{1}}, {{2}} has sent you a document to review and sign.\n\nDocument: {{3}}\n\nPlease tap the button below to review and sign.',
          example: { body_text: [['John', 'Acme Corp', 'Service Agreement']] },
        },
        { type: 'FOOTER', text: 'Powered by Waaiio' },
        {
          type: 'BUTTONS',
          buttons: [{ type: 'URL', text: 'Review & Sign', url: 'https://waaiio.com/sign/{{1}}' }],
        },
      ],
    },
  ],

  reminders: [
    {
      name: 'booking_reminder',
      category: 'UTILITY',
      language: 'en_US',
      components: [
        { type: 'HEADER', format: 'TEXT', text: 'Appointment Reminder' },
        {
          type: 'BODY',
          text: 'Hi {{1}}, this is a reminder for your upcoming appointment at {{2}}.\n\n📅 {{3}}\n🕐 {{4}}\n🔑 Ref: {{5}}\n\nSee you there!',
          example: { body_text: [['Sarah', 'Glow Spa', 'April 25, 2026', '2:00 PM', 'BK-1234']] },
        },
        { type: 'FOOTER', text: 'Powered by Waaiio' },
      ],
    },
  ],

  scheduling: [
    {
      name: 'booking_confirmation',
      category: 'UTILITY',
      language: 'en_US',
      components: [
        { type: 'HEADER', format: 'TEXT', text: 'Booking Confirmed' },
        {
          type: 'BODY',
          text: 'Hi {{1}}, your booking at {{2}} has been confirmed!\n\n📅 {{3}}\n🕐 {{4}}\n📦 {{5}}\n🔑 Ref: {{6}}\n\nThank you!',
          example: { body_text: [['James', 'Fresh Cuts', 'April 24, 2026', '10:00 AM', 'Haircut', 'BK-5678']] },
        },
        { type: 'FOOTER', text: 'Powered by Waaiio' },
      ],
    },
  ],

  ordering: [
    {
      name: 'order_status_update',
      category: 'UTILITY',
      language: 'en_US',
      components: [
        { type: 'HEADER', format: 'TEXT', text: 'Order Update' },
        {
          type: 'BODY',
          text: 'Hi {{1}}, here is an update on your order at {{2}}.\n\nYour order status has been updated to: *{{3}}*\n\nOrder reference: {{4}}\nOrder total: {{5}}\n\nThank you for your business! If you have any questions, please reply to this message.',
          example: { body_text: [['Amina', 'FoodHub', 'Ready for Pickup', 'ORD-9012', '₦5,500']] },
        },
        { type: 'FOOTER', text: 'Powered by Waaiio' },
      ],
    },
  ],

  invoice: [
    {
      name: 'invoice_payment_request',
      category: 'UTILITY',
      language: 'en_US',
      components: [
        { type: 'HEADER', format: 'TEXT', text: 'Invoice from {{1}}' },
        {
          type: 'BODY',
          text: 'Hi {{1}}, you have a new invoice from {{2}}.\n\n🧾 Invoice: {{3}}\n💰 Amount: {{4}}\n📅 Due: {{5}}\n\nTap below to pay now.',
          example: { body_text: [['David', 'ProConsult Ltd', 'INV-0045', '$250.00', 'April 30, 2026']] },
        },
        { type: 'FOOTER', text: 'Powered by Waaiio' },
        {
          type: 'BUTTONS',
          buttons: [{ type: 'URL', text: 'Pay Now', url: 'https://waaiio.com/invoice/{{1}}' }],
        },
      ],
    },
  ],

  feedback: [
    {
      name: 'feedback_request',
      category: 'MARKETING',
      language: 'en_US',
      components: [
        { type: 'HEADER', format: 'TEXT', text: 'How was your experience?' },
        {
          type: 'BODY',
          text: 'Hi {{1}}, thank you for visiting {{2}}! We\'d love to hear your feedback.\n\nTap below to leave a quick review — it only takes a moment.',
          example: { body_text: [['Kemi', 'Bella Nails']] },
        },
        { type: 'FOOTER', text: 'Powered by Waaiio' },
        {
          type: 'BUTTONS',
          buttons: [{ type: 'URL', text: 'Leave Review', url: 'https://waaiio.com/review/{{1}}' }],
        },
      ],
    },
  ],

  broadcast: [
    {
      name: 'business_update',
      category: 'UTILITY',
      language: 'en_US',
      components: [
        {
          type: 'BODY',
          text: 'Hello! Here is an update from *{{1}}*:\n\n{{2}}\n\nReply to this message if you have any questions.',
          example: { body_text: [['Citadel of Grace', 'We have updated our opening hours. We are now open Monday to Saturday, 9am to 7pm. Thank you for your continued support!']] },
        },
        { type: 'FOOTER', text: 'Powered by Waaiio' },
      ],
    },
    {
      name: 'business_reminder',
      category: 'UTILITY',
      language: 'en_US',
      components: [
        {
          type: 'BODY',
          text: 'Hello! Here is a reminder from *{{1}}*:\n\n{{2}}\n\nWe look forward to seeing you. Reply if you need any help.',
          example: { body_text: [['Citadel of Grace', 'Don\'t forget — our special Sunday service starts at 8am this week. See you there!']] },
        },
        { type: 'FOOTER', text: 'Powered by Waaiio' },
      ],
    },
    {
      name: 'business_event',
      category: 'UTILITY',
      language: 'en_US',
      components: [
        {
          type: 'BODY',
          text: 'Hello! Here is an upcoming event from *{{1}}*:\n\n{{2}}\n\nWe hope to see you there. Reply for more details or to RSVP.',
          example: { body_text: [['Citadel of Grace', 'Bible Study this Friday at 6pm in the Main Hall. All are welcome. Light refreshments will be served.']] },
        },
        { type: 'FOOTER', text: 'Powered by Waaiio' },
      ],
    },
    {
      name: 'business_promotion',
      category: 'MARKETING',
      language: 'en_US',
      components: [
        {
          type: 'BODY',
          text: 'Hi there! *{{1}}* has a special message for you:\n\n{{2}}\n\nDon\'t miss out — reply to learn more or take action today!',
          example: { body_text: [['Fresh Cuts Barbershop', '20% off all haircuts this weekend! Walk-ins welcome. Book now on WhatsApp.']] },
        },
        { type: 'FOOTER', text: 'Powered by Waaiio' },
      ],
    },
  ],

  // Promotions Secure Pickup — verification OTP delivery
  promo_verification: [
    {
      name: 'promo_pickup_verification',
      category: 'UTILITY',
      language: 'en_US',
      components: [
        {
          type: 'BODY',
          text: 'Your {{1}} pickup verification code is {{2}}.\nIt expires in {{3}} minutes.\nOnly share this code with staff when collecting your prize.',
          example: { body_text: [['Prize', '123456', '10']] },
        },
      ],
    },
    PROMO_TEMPLATE_CONTRACTS.promo_pickup_verification_v2,
    PROMO_TEMPLATE_CONTRACTS.promo_winner_status_v1,
    PROMO_TEMPLATE_CONTRACTS.promo_fulfillment_status_v1,
  ],
};

/** Template statuses that indicate readiness for use. */
const READY_STATUSES = new Set(['APPROVED']);
/** Template statuses that should NOT be recreated (waiting for Meta review). */
const PENDING_STATUSES = new Set(['PENDING']);

export async function POST(request: NextRequest) {
  try {
    // 1. Authenticate
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }

    // 2. Parse and validate request
    let body: { business_id?: unknown; capability?: unknown };
    try { body = await request.json(); } catch {
      return NextResponse.json({ message: 'Invalid request body' }, { status: 400 });
    }

    const { business_id, capability } = body;

    if (!business_id || typeof business_id !== 'string') {
      return NextResponse.json({ message: 'Missing or invalid business_id' }, { status: 400 });
    }
    if (!capability || typeof capability !== 'string') {
      return NextResponse.json({ message: 'Missing or invalid capability' }, { status: 400 });
    }

    // 3. Validate business_id format (UUID)
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(business_id)) {
      return NextResponse.json({ message: 'Invalid business_id format' }, { status: 400 });
    }

    // 4. Validate capability against canonical registry
    if (!VALID_CAPABILITY_IDS.has(capability)) {
      return NextResponse.json({ message: 'Unknown capability' }, { status: 400 });
    }

    // 5. Check if this capability has templates to provision (valid cap, just no templates)
    const templateDefs = REQUIRED_TEMPLATES[capability];
    if (!templateDefs?.length) {
      return NextResponse.json({ message: 'No template provisioning needed', provisioned: false });
    }

    // 5. Verify business ownership using authenticated context (RLS-aware)
    // This is the SECURITY BOUNDARY — must occur BEFORE any service-role operation.
    const { data: business, error: bizError } = await supabase
      .from('businesses')
      .select('id, status')
      .eq('id', business_id)
      .eq('owner_id', user.id)
      .maybeSingle();

    if (bizError) {
      // Fail closed on authorization lookup error
      logger.error('[PROVISION] Business authorization lookup failed:', bizError.message);
      return NextResponse.json({ message: 'Authorization check failed' }, { status: 500 });
    }

    if (!business) {
      // User is authenticated but NOT authorized for this business
      logger.warn(`[PROVISION] Denied: user=${user.id} business=${business_id} reason=not_owner`);
      return NextResponse.json({ message: 'Forbidden' }, { status: 403 });
    }

    // 6. Validate business status
    if (business.status === 'suspended') {
      return NextResponse.json({ message: 'Business is suspended' }, { status: 403 });
    }

    // ─── AUTHORIZATION PASSED ───
    // Only AFTER proving ownership may we use service-role for privileged channel data.

    const service = createServiceClient();
    const { data: channel, error: channelError } = await service
      .from('whatsapp_channels')
      .select('waba_id, meta_access_token, provider')
      .eq('business_id', business_id)
      .eq('provider', 'meta_cloud')
      .eq('is_active', true)
      .single();

    // Distinguish: no rows found (legitimate) vs database error (fail closed)
    if (channelError && channelError.code !== 'PGRST116') {
      logger.error('[PROVISION] Channel lookup error:', channelError.message);
      return NextResponse.json({ message: 'Failed to look up channel' }, { status: 500 });
    }

    if (!channel?.waba_id || !channel?.meta_access_token) {
      // No dedicated channel — they'll use the shared WABA which already has the template
      return NextResponse.json({
        message: 'Business uses shared channel, no provisioning needed',
        provisioned: false,
        shared: true,
      });
    }

    const meta = new MetaCloudService({
      accessToken: channel.meta_access_token,
      phoneNumberId: '',
      wabaId: channel.waba_id,
    });

    // Fetch existing templates once — track status for readiness awareness
    const existing = await meta.getTemplates();
    const existingMap = new Map<string, string>();
    for (const t of (existing.data || [])) {
      existingMap.set(`${t.name}:${t.language}`, t.status || 'UNKNOWN');
    }

    const results: Array<{ name: string; status: string; action: string }> = [];

    for (const templateDef of templateDefs) {
      const key = `${templateDef.name}:${templateDef.language}`;
      const existingStatus = existingMap.get(key);

      if (existingStatus) {
        if (READY_STATUSES.has(existingStatus) || PENDING_STATUSES.has(existingStatus)) {
          // APPROVED or PENDING — do not recreate
          results.push({ name: templateDef.name, status: existingStatus, action: 'skipped' });
          continue;
        }
        // REJECTED / PAUSED / DISABLED / unknown — report status, do not auto-delete
        // Destructive recreation requires explicit operator action, not incidental side-effect
        results.push({ name: templateDef.name, status: existingStatus, action: 'needs_attention' });
        continue;
      }

      try {
        const result = await meta.createTemplate({
          name: templateDef.name,
          language: templateDef.language,
          category: templateDef.category,
          components: templateDef.components as any,
          allow_category_change: true,
        });

        // Log success without exposing tokens
        logger.info(`[PROVISION] Created template "${templateDef.name}" on WABA ${channel.waba_id} for business ${business_id}, status=${result.status}`);
        results.push({ name: templateDef.name, status: result.status, action: 'created' });
      } catch (err) {
        // Log error safely — never include meta_access_token or raw provider response
        logger.withContext({ op: 'provision.create-template', ...safeLogErrorContext(err) }).error(`[PROVISION] Failed to create "${templateDef.name}" for business ${business_id}`);
        results.push({ name: templateDef.name, status: 'error', action: 'creation_failed' });
      }
    }

    const created = results.filter(r => r.action === 'created').length;

    return NextResponse.json({
      message: `Provisioned ${created}/${templateDefs.length} templates`,
      provisioned: created > 0,
      results,
    });
  } catch (error) {
    logger.withContext({ op: 'provision', ...safeLogErrorContext(error) }).error('[PROVISION] Error');
    return NextResponse.json(
      { message: 'Internal server error' },
      { status: 500 },
    );
  }
}

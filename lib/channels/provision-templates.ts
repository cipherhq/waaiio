import { logger } from '@/lib/logger';

const API_VERSION = process.env.META_GRAPH_API_VERSION || 'v22.0';

/**
 * Provision all required WhatsApp message templates on a business's WABA.
 * Called after Embedded Signup when a business creates their own WABA.
 * Templates go through Meta's approval process (usually instant for utility templates).
 */

interface TemplateDefinition {
  name: string;
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
  language: string;
  components: Array<{
    type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';
    format?: string;
    text?: string;
    example?: { body_text?: string[][] };
    buttons?: Array<{ type: string; text: string; url?: string }>;
  }>;
}

const WAAIIO_TEMPLATES: TemplateDefinition[] = [
  {
    name: 'booking_confirmation',
    category: 'UTILITY',
    language: 'en_US',
    components: [
      { type: 'BODY', text: 'Confirmed with {{1}}!\n\n{{2}}\n\nThank you for choosing us!', example: { body_text: [['Runway Salon', 'Haircut on Monday, Jan 5 at 2:00 PM. Ref: WA-BK-1234']] } },
    ],
  },
  {
    name: 'booking_reminder',
    category: 'UTILITY',
    language: 'en_US',
    components: [
      { type: 'BODY', text: 'Reminder: You have an upcoming visit with {{1}}.\n\n{{2}}\n\nSee you soon!', example: { body_text: [['Runway Salon', 'Haircut tomorrow at 2:00 PM']] } },
    ],
  },
  {
    name: 'order_status_update',
    category: 'UTILITY',
    language: 'en_US',
    components: [
      { type: 'BODY', text: 'Order update: Your order {{1}} is now {{2}}.', example: { body_text: [['WA-OR-5678', 'shipped']] } },
    ],
  },
  {
    name: 'invoice_payment_request',
    category: 'UTILITY',
    language: 'en_US',
    components: [
      { type: 'BODY', text: 'Invoice from {{1}}\n\nRef: {{2}}\nAmount: {{3}}\n\nPlease complete your payment.', example: { body_text: [['Citadel of Grace', 'INV-001', '$500.00']] } },
    ],
  },
  {
    name: 'document_signature_request',
    category: 'UTILITY',
    language: 'en_US',
    components: [
      { type: 'BODY', text: '{{1}} has sent you a document to sign.\n\nDocument: {{2}}\n\n{{3}}', example: { body_text: [['Citadel of Grace', 'Service Agreement', 'https://waaiio.com/sign/abc123']] } },
    ],
  },
  {
    name: 'event_invitation',
    category: 'UTILITY',
    language: 'en_US',
    components: [
      { type: 'BODY', text: "You're invited! 🎉\n\n{{1}}\n📅 {{2}}\n📍 {{3}}\n\nRSVP here: {{4}}", example: { body_text: [['Boys Hang Out', 'July 31, 2026 at 11:00 AM', 'The Citadel', 'https://waaiio.com/rsvp/abc123']] } },
    ],
  },
  {
    name: 'feedback_request',
    category: 'MARKETING',
    language: 'en_US',
    components: [
      { type: 'BODY', text: '{{1}} would like your feedback!\n\n{{2}}\n\nTap below to respond.', example: { body_text: [['Runway Salon', 'How was your recent visit?']] } },
    ],
  },
];

/**
 * Create all Waaiio templates on a business's WABA.
 * Skips templates that already exist. Non-blocking — failures are logged but don't block signup.
 */
export async function provisionTemplates(
  wabaId: string,
  accessToken: string,
): Promise<{ created: number; skipped: number; failed: number }> {
  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const template of WAAIIO_TEMPLATES) {
    try {
      // Check if template already exists
      const checkRes = await fetch(
        `https://graph.facebook.com/${API_VERSION}/${wabaId}/message_templates?name=${template.name}&fields=name,status`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const checkData = await checkRes.json();

      if (checkData.data?.length > 0) {
        skipped++;
        continue;
      }

      // Create template
      const createRes = await fetch(
        `https://graph.facebook.com/${API_VERSION}/${wabaId}/message_templates`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(template),
        }
      );

      const createData = await createRes.json();

      if (createRes.ok) {
        created++;
        logger.debug(`[TEMPLATES] Created ${template.name} on WABA ${wabaId}: ${createData.status}`);
      } else {
        failed++;
        logger.error(`[TEMPLATES] Failed to create ${template.name}:`, createData.error?.message);
      }
    } catch (err) {
      failed++;
      logger.error(`[TEMPLATES] Error creating ${template.name}:`, (err as Error).message);
    }
  }

  logger.debug(`[TEMPLATES] Provisioned on WABA ${wabaId}: ${created} created, ${skipped} skipped, ${failed} failed`);
  return { created, skipped, failed };
}

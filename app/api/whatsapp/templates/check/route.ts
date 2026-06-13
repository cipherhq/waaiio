import { NextResponse, type NextRequest } from 'next/server';
import { MetaCloudService } from '@/lib/channels/meta-cloud';
import { verifyCronAuth } from '@/lib/cron-auth';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

/**
 * GET /api/whatsapp/templates/check
 *
 * Diagnostic: checks if waaiio_event_invite template exists and is approved
 * on the shared WABA. If missing or rejected, auto-creates it as MARKETING.
 *
 * Protected by admin session, cron auth, or internal token.
 *
 * Query params:
 *   ?fix=true  — auto-create if missing, delete+recreate if wrong category
 *   ?token=xxx — internal API token auth
 */
export async function GET(request: NextRequest) {
  // Auth: internal token OR cron auth OR admin session
  const internalToken = request.nextUrl.searchParams.get('token');
  const validInternalToken = process.env.INTERNAL_API_TOKEN;
  const hasInternalAuth = internalToken && validInternalToken && internalToken === validInternalToken;

  if (!hasInternalAuth) {
    const cronAuth = verifyCronAuth(request);
    if (cronAuth) {
      const supabase = await createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return cronAuth;
      const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
      const PLATFORM_OWNERS = ['19d95ac8-0f39-4c59-b0ca-18bf9dfba501', '51b56d99-8998-46a9-aebc-2afd47f698bd'];
      if (!profile || (profile.role !== 'admin' && !PLATFORM_OWNERS.includes(user.id))) {
        return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
      }
    }
  }

  const wabaId = process.env.META_CLOUD_WABA_ID;
  const accessToken = process.env.META_CLOUD_ACCESS_TOKEN;

  if (!wabaId || !accessToken) {
    return NextResponse.json({ error: 'META_CLOUD_WABA_ID or META_CLOUD_ACCESS_TOKEN not set' }, { status: 500 });
  }

  const shouldFix = request.nextUrl.searchParams.get('fix') === 'true';

  const meta = new MetaCloudService({ accessToken, phoneNumberId: '', wabaId });

  try {
    // Fetch all templates and find the event invite one
    const { data: templates } = await meta.getTemplates();
    const eventInvite = templates.find((t) => t.name === 'waaiio_event_invite');

    const result: Record<string, unknown> = {
      template_name: 'waaiio_event_invite',
      waba_id: wabaId,
      total_templates: templates.length,
      all_template_names: templates.map((t) => `${t.name} (${t.status}, ${t.category}, ${t.language})`),
    };

    if (!eventInvite) {
      result.found = false;
      result.diagnosis = 'Template does not exist on this WABA. Cold invites will fail.';

      if (shouldFix) {
        // Create as MARKETING (correct category for unsolicited invites)
        const created = await meta.createTemplate({
          name: 'waaiio_event_invite',
          language: 'en_US',
          category: 'MARKETING',
          components: [
            {
              type: 'BODY',
              text: "You have been invited to an event. Here are the details:\n\n{{1}}\n\nPlease confirm your attendance by tapping the link below.\n\n{{2}}\n\nWe look forward to seeing you there.",
              example: { body_text: [['Boys Hang Out on July 31 2026 at 11:00 AM at The Citadel Lagos', 'https://waaiio.com/rsvp/abc123']] },
            },
            { type: 'FOOTER', text: 'Powered by Waaiio' },
          ],
          allow_category_change: true,
        });
        result.fix_action = 'created';
        result.fix_result = created;
        logger.info(`[TEMPLATE-CHECK] Created waaiio_event_invite on WABA ${wabaId}:`, created);
      }
    } else {
      result.found = true;
      result.status = eventInvite.status;
      result.category = eventInvite.category;
      result.language = eventInvite.language;
      result.components = eventInvite.components;
      result.quality_score = eventInvite.quality_score;

      const issues: string[] = [];

      if (eventInvite.status !== 'APPROVED') {
        issues.push(`Status is ${eventInvite.status} — template must be APPROVED to send`);
      }
      if (eventInvite.category === 'UTILITY') {
        issues.push('Category is UTILITY — Meta may reject/suppress unsolicited invites. Should be MARKETING.');
      }
      if (eventInvite.language !== 'en_US' && eventInvite.language !== 'en') {
        issues.push(`Language is ${eventInvite.language} — may not match send request`);
      }

      result.issues = issues;
      result.diagnosis = issues.length === 0
        ? 'Template looks good. If cold invites still fail, check phone number format and messaging tier.'
        : `Found ${issues.length} issue(s) that may prevent cold delivery.`;

      if (shouldFix && issues.length > 0) {
        // Delete and recreate with correct settings
        try {
          await meta.deleteTemplate('waaiio_event_invite');
          result.fix_action = 'deleted_old';
        } catch (delErr) {
          logger.warn('[TEMPLATE-CHECK] Delete failed (may not exist):', delErr);
        }

        const created = await meta.createTemplate({
          name: 'waaiio_event_invite',
          language: 'en_US',
          category: 'MARKETING',
          components: [
            {
              type: 'BODY',
              text: "You have been invited to an event. Here are the details:\n\n{{1}}\n\nPlease confirm your attendance by tapping the link below.\n\n{{2}}\n\nWe look forward to seeing you there.",
              example: { body_text: [['Boys Hang Out on July 31 2026 at 11:00 AM at The Citadel Lagos', 'https://waaiio.com/rsvp/abc123']] },
            },
            { type: 'FOOTER', text: 'Powered by Waaiio' },
          ],
          allow_category_change: true,
        });
        result.fix_action = (result.fix_action === 'deleted_old') ? 'replaced' : 'created';
        result.fix_result = created;
        logger.info(`[TEMPLATE-CHECK] Recreated waaiio_event_invite on WABA ${wabaId}:`, created);
      }
    }

    return NextResponse.json(result);
  } catch (error) {
    logger.error('[TEMPLATE-CHECK] Error:', error);
    return NextResponse.json(
      { error: 'Failed to check templates', details: (error as Error).message },
      { status: 500 },
    );
  }
}

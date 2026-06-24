import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { authenticateRequest } from '@/lib/api-auth';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { sendOrEmail, findCustomerEmail } from '@/lib/channels/send-or-email';
import { businessNotificationEmail } from '@/lib/email/templates';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = rateLimitResponse(getRateLimitKey(request, 'waitlist-notify'), 20, 60_000);
    if (rateLimit) return rateLimit;

    const body = await request.json();
    const auth = await authenticateRequest(request, { requireBusinessOwnership: true, body });
    if (auth instanceof NextResponse) return auth;

    const { businessId, entryId, count } = body;
    if (!businessId) {
      return NextResponse.json({ error: 'businessId required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Get business name
    const { data: biz } = await supabase
      .from('businesses')
      .select('name')
      .eq('id', businessId)
      .single();

    const bizName = biz?.name || 'Business';

    // Get channel resolver for sending messages
    const resolver = new ChannelResolver(supabase);
    const resolved = await resolver.resolveByBusinessId(businessId);

    if (!resolved) {
      return NextResponse.json({ error: 'No messaging channel configured' }, { status: 400 });
    }

    let entries;

    if (entryId) {
      // Notify a specific entry
      const { data } = await supabase
        .from('waitlist_entries')
        .select('id, customer_phone, customer_name')
        .eq('id', entryId)
        .eq('business_id', businessId)
        .eq('status', 'waiting')
        .limit(1);
      entries = data;
    } else {
      // Notify first N waiting entries
      const limit = count || 5;
      const { data } = await supabase
        .from('waitlist_entries')
        .select('id, customer_phone, customer_name')
        .eq('business_id', businessId)
        .eq('status', 'waiting')
        .order('created_at', { ascending: true })
        .limit(limit);
      entries = data;
    }

    if (!entries || entries.length === 0) {
      return NextResponse.json({ message: 'No waiting entries to notify' });
    }

    const notified: string[] = [];

    for (const entry of entries) {
      try {
        const phone = entry.customer_phone.startsWith('+')
          ? entry.customer_phone.slice(1)
          : entry.customer_phone;

        const name = entry.customer_name || 'there';
        const msg = `Hi ${name}! Great news — a spot has opened up at ${bizName}. Would you like to book? Reply *yes* to confirm or *no* to pass.`;
        // Try template first (waitlist notifications are often outside 24h)
        let sent = false;
        if (resolved.sender.sendTemplate) {
          try {
            const r = await resolved.sender.sendTemplate({ to: phone, templateName: 'booking_confirmation', templateParams: [bizName, 'Waitlist spot available'] });
            sent = r.success !== false;
          } catch { /* template failed */ }
        }
        if (!sent) {
          const customerEmail = await findCustomerEmail(supabase, phone, businessId);
          let emailOpt: { address: string; subject: string; html: string } | null = null;
          if (customerEmail) {
            const tmpl = businessNotificationEmail({
              businessName: bizName,
              title: 'A Spot Has Opened Up!',
              message: `Hi ${name}! Great news — a spot has opened up at ${bizName}. Would you like to book?`,
            });
            emailOpt = { address: customerEmail, subject: tmpl.subject, html: tmpl.html };
          }

          await sendOrEmail({
            supabase,
            sender: resolved.sender,
            to: phone,
            text: msg,
            email: emailOpt,
            businessName: bizName,
            alwaysEmail: true,
          });
        }

        await supabase
          .from('waitlist_entries')
          .update({ status: 'notified', notified_at: new Date().toISOString() })
          .eq('id', entry.id);

        notified.push(entry.id);
      } catch (err) {
        logger.error('[WAITLIST] Notify error for entry:', entry.id, err);
      }
    }

    return NextResponse.json({ success: true, notified_count: notified.length });
  } catch (error) {
    logger.error('[WAITLIST] Notify error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

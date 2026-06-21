import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { wrap, btn, h, p } from '@/lib/email/templates';
import { logger } from '@/lib/logger';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';

const INDUSTRIES = ['Concierge', 'Hospitality', 'Travel', 'Entertainment', 'Events', 'Membership', 'Other'];
const USE_CASES = ['own_business', 'reselling'];

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function POST(request: NextRequest) {
  try {
    const rl = rateLimitResponse(getRateLimitKey(request, 'demo-request'), 5, 60_000);
    if (rl) return rl;

    const body = await request.json();
    const {
      business_name,
      contact_name,
      work_email,
      phone,
      industry,
      estimated_volume,
      has_waba,
      use_case,
      notes,
    } = body;

    // Required fields
    if (!business_name || !contact_name || !work_email || !phone || !industry) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(work_email)) {
      return NextResponse.json({ error: 'Invalid email address' }, { status: 400 });
    }

    // Length validation
    if (business_name.length > 200 || contact_name.length > 200 || work_email.length > 254 || phone.length > 30) {
      return NextResponse.json({ error: 'Input too long' }, { status: 400 });
    }
    if (notes && notes.length > 2000) {
      return NextResponse.json({ error: 'Notes too long' }, { status: 400 });
    }
    if (estimated_volume && estimated_volume.length > 100) {
      return NextResponse.json({ error: 'Input too long' }, { status: 400 });
    }

    // Enum validation
    if (!INDUSTRIES.includes(industry)) {
      return NextResponse.json({ error: 'Invalid industry' }, { status: 400 });
    }
    if (use_case && !USE_CASES.includes(use_case)) {
      return NextResponse.json({ error: 'Invalid use case' }, { status: 400 });
    }

    // Honeypot
    if (body.website) {
      return NextResponse.json({ success: true });
    }

    // Persist to Supabase
    const supabase = createServiceClient();
    const { error: dbError } = await supabase.from('demo_requests').insert({
      business_name: business_name.trim(),
      contact_name: contact_name.trim(),
      work_email: work_email.trim().toLowerCase(),
      phone: phone.trim(),
      industry,
      estimated_volume: estimated_volume?.trim() || null,
      has_waba: typeof has_waba === 'boolean' ? has_waba : null,
      use_case: use_case || 'own_business',
      notes: notes?.trim() || null,
    });

    if (dbError) {
      logger.error('[DEMO-REQUEST] DB insert failed:', dbError.message);
      return NextResponse.json({ error: 'Failed to submit request' }, { status: 500 });
    }

    // Send notification email
    await sendEmail({
      to: 'hello@waaiio.com',
      subject: `[White Label Demo] ${esc(business_name)} — ${esc(industry)}`,
      html: `
        <h3>New White-Label Demo Request</h3>
        <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:6px 12px;font-weight:bold;color:#555">Business</td><td style="padding:6px 12px">${esc(business_name)}</td></tr>
          <tr style="background:#f9fafb"><td style="padding:6px 12px;font-weight:bold;color:#555">Contact</td><td style="padding:6px 12px">${esc(contact_name)}</td></tr>
          <tr><td style="padding:6px 12px;font-weight:bold;color:#555">Email</td><td style="padding:6px 12px"><a href="mailto:${esc(work_email)}">${esc(work_email)}</a></td></tr>
          <tr style="background:#f9fafb"><td style="padding:6px 12px;font-weight:bold;color:#555">Phone</td><td style="padding:6px 12px">${esc(phone)}</td></tr>
          <tr><td style="padding:6px 12px;font-weight:bold;color:#555">Industry</td><td style="padding:6px 12px">${esc(industry)}</td></tr>
          <tr style="background:#f9fafb"><td style="padding:6px 12px;font-weight:bold;color:#555">Est. Volume</td><td style="padding:6px 12px">${estimated_volume ? esc(estimated_volume) : '—'}</td></tr>
          <tr><td style="padding:6px 12px;font-weight:bold;color:#555">Has WABA?</td><td style="padding:6px 12px">${has_waba === true ? 'Yes' : has_waba === false ? 'No' : '—'}</td></tr>
          <tr style="background:#f9fafb"><td style="padding:6px 12px;font-weight:bold;color:#555">Use Case</td><td style="padding:6px 12px">${use_case === 'reselling' ? 'Reselling to clients' : 'Own business'}</td></tr>
          ${notes ? `<tr><td style="padding:6px 12px;font-weight:bold;color:#555">Notes</td><td style="padding:6px 12px">${esc(notes).replace(/\n/g, '<br/>')}</td></tr>` : ''}
        </table>
      `,
      replyTo: work_email.trim(),
    }).catch((err) => {
      // Don't fail the request if email fails — lead is already saved
      logger.error('[DEMO-REQUEST] Email notification failed:', (err as Error).message);
    });

    // Send auto-response email to the submitter
    const firstName = esc(contact_name.trim().split(' ')[0] || contact_name.trim());
    sendEmail({
      to: work_email.trim().toLowerCase(),
      subject: 'Thanks for your interest in Waaiio White Label',
      html: wrap(`
        ${h(`Hi ${firstName},`)}
        ${p('Thank you for your interest in Waaiio White Label. We\'ve received your demo request and our partnerships team is reviewing it now.')}
        ${p('You can expect to hear from us within <strong>1 business day</strong>. In the meantime, feel free to schedule a call at a time that works for you:')}
        ${btn('Schedule a Call', 'https://cal.com/waaiio/white-label-demo')}
        ${p('If you have any questions before then, just reply to this email.')}
        <p style="margin:24px 0 4px;font-size:14px;color:#3f3f46">Looking forward to speaking with you,</p>
        <p style="margin:0;font-size:14px;font-weight:600;color:#3f3f46">The Waaiio Team</p>
      `),
      replyTo: 'hello@waaiio.com',
    })
      .then(() => {
        supabase
          .from('demo_requests')
          .update({ auto_response_sent: true })
          .eq('work_email', work_email.trim().toLowerCase())
          .order('created_at', { ascending: false })
          .limit(1)
          .then(({ error: updateErr }) => {
            if (updateErr) {
              logger.error('[DEMO-REQUEST] Failed to mark auto_response_sent:', updateErr.message);
            }
          });
      })
      .catch((err) => {
        logger.error('[DEMO-REQUEST] Auto-response email failed:', (err as Error).message);
      });

    logger.info(`[DEMO-REQUEST] New lead: ${work_email} (${business_name})`);

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[DEMO-REQUEST] Error:', (error as Error).message);
    return NextResponse.json({ error: 'Failed to submit request' }, { status: 500 });
  }
}

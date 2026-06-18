import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { bindSession } from '@/lib/security/session-bind';
import { sendEmail } from '@/lib/email/client';
import { logger } from '@/lib/logger';

/**
 * POST /api/auth/session-bind
 * Called by the browser after successful login to record session metadata.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();

    if (!session?.user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const userAgent = request.headers.get('user-agent') || 'unknown';
    const country = request.headers.get('x-vercel-ip-country') || undefined;

    await bindSession({
      userId: session.user.id,
      sessionId: session.access_token.slice(-32),
      ip,
      userAgent,
      country,
    });

    // Send login notification email (non-blocking)
    try {
      const email = session.user.email;
      if (email) {
        const service = createServiceClient();
        const { data: profile } = await service
          .from('profiles')
          .select('first_name')
          .eq('id', session.user.id)
          .single();

        const name = profile?.first_name || 'there';
        const time = new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
        const device = userAgent.includes('Mobile') ? 'Mobile device' : 'Desktop/Laptop';
        const location = country || 'Unknown location';

        sendEmail({
          to: email,
          subject: 'New login to your Waaiio account',
          html: `
            <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto;">
              <h2 style="color: #6C2BD9;">New Login Detected</h2>
              <p>Hi ${name},</p>
              <p>We noticed a new sign-in to your Waaiio account:</p>
              <div style="background: #f9fafb; border-radius: 8px; padding: 16px; margin: 16px 0;">
                <p style="margin: 4px 0; font-size: 14px;"><strong>Time:</strong> ${time}</p>
                <p style="margin: 4px 0; font-size: 14px;"><strong>IP Address:</strong> ${ip}</p>
                <p style="margin: 4px 0; font-size: 14px;"><strong>Device:</strong> ${device}</p>
                <p style="margin: 4px 0; font-size: 14px;"><strong>Location:</strong> ${location}</p>
              </div>
              <p>If this was you, no action is needed.</p>
              <p><strong>If this wasn't you</strong>, change your password immediately:</p>
              <div style="margin: 20px 0;">
                <a href="https://www.waaiio.com/forgot-password" style="background: #ef4444; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">Change Password Now</a>
              </div>
              <p style="color: #999; font-size: 12px;">This is an automated security notification from Waaiio.</p>
            </div>
          `,
        }).catch(err => logger.error('[SESSION-BIND] Login notification email error:', err));
      }
    } catch (emailErr) {
      logger.error('[SESSION-BIND] Login notification error:', emailErr);
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

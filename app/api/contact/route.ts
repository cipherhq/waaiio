import { NextResponse, type NextRequest } from 'next/server';
import { sendEmail } from '@/lib/email/client';
import { logger } from '@/lib/logger';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';

export async function POST(request: NextRequest) {
  try {
    // Stricter per-route limit for contact form (5 req/min)
    const rl = rateLimitResponse(getRateLimitKey(request, 'contact'), 5, 60_000);
    if (rl) return rl;

    const body = await request.json();
    const { name, email, subject, message } = body;

    if (!name || !email || !message) {
      return NextResponse.json({ error: 'Name, email, and message are required' }, { status: 400 });
    }

    // Basic email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'Invalid email address' }, { status: 400 });
    }

    // Input length validation (anti-spam)
    if (name.length > 100 || email.length > 254 || message.length > 5000 || (subject && subject.length > 200)) {
      return NextResponse.json({ error: 'Input too long' }, { status: 400 });
    }

    // Honeypot check — if 'website' field is filled, it's a bot
    if (body.website) {
      // Silently accept but don't send — bot thinks it succeeded
      return NextResponse.json({ success: true });
    }

    // Cloudflare Turnstile verification (enforced when configured)
    const turnstileSecret = process.env.TURNSTILE_SECRET_KEY;
    if (turnstileSecret) {
      if (!body.turnstileToken) {
        return NextResponse.json({ error: 'Verification required. Please complete the check and try again.' }, { status: 403 });
      }
      const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: turnstileSecret, response: body.turnstileToken }),
        signal: AbortSignal.timeout(5000),
      });
      const turnstileResult = await verifyRes.json();
      if (!turnstileResult.success) {
        return NextResponse.json({ error: 'Bot verification failed. Please try again.' }, { status: 403 });
      }
    }

    const subjectLine = subject ? `[Waaiio Contact] ${subject}` : `[Waaiio Contact] New message from ${name}`;

    await sendEmail({
      to: 'hello@waaiio.com',
      subject: subjectLine,
      html: `
        <h3>New Contact Form Submission</h3>
        <p><strong>Name:</strong> ${name.replace(/</g, '&lt;')}</p>
        <p><strong>Email:</strong> ${email.replace(/</g, '&lt;')}</p>
        ${subject ? `<p><strong>Subject:</strong> ${subject.replace(/</g, '&lt;')}</p>` : ''}
        <hr />
        <p>${message.replace(/</g, '&lt;').replace(/\n/g, '<br />')}</p>
      `,
      replyTo: email,
    });

    logger.info(`[CONTACT] Form submitted by ${email} (${name})`);

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[CONTACT] Error:', (error as Error).message);
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 });
  }
}

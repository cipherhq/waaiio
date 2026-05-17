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

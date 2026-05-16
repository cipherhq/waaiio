import { NextResponse, type NextRequest } from 'next/server';
import { sendEmail } from '@/lib/email/client';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, email, subject, message } = body;

    if (!name || !email || !message) {
      return NextResponse.json({ error: 'Name, email, and message are required' }, { status: 400 });
    }

    // Basic email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'Invalid email address' }, { status: 400 });
    }

    // Rate limit: simple in-memory (resets on deploy)
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const key = `contact:${ip}`;
    const store = globalThis as unknown as Record<string, number>;
    const count = store[key] || 0;
    if (count >= 5) {
      return NextResponse.json({ error: 'Too many requests. Please try again later.' }, { status: 429 });
    }
    store[key] = count + 1;
    setTimeout(() => { store[key] = Math.max(0, (store[key] || 0) - 1); }, 60_000);

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

import { Resend } from 'resend';
import { logger } from '@/lib/logger';

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const DEFAULT_FROM = process.env.EMAIL_FROM || 'Waaiio <noreply@waaiio.com>';

interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  from?: string;
}

export async function sendEmail({ to, subject, html, from }: SendEmailOptions) {
  if (!resend) {
    logger.debug(`[EMAIL-DEV] To: ${to} | Subject: ${subject}`);
    return { success: true, dev: true };
  }

  try {
    const { data, error } = await resend.emails.send({
      from: from || DEFAULT_FROM,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
    });

    if (error) {
      logger.error('[EMAIL] Send failed:', error);
      return { success: false, error };
    }

    return { success: true, id: data?.id };
  } catch (err) {
    logger.error('[EMAIL] Exception:', (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
}

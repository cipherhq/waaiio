import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { bookingReminderEmail } from '@/lib/email/templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function verifyCronSecret(authHeader: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const expected = `Bearer ${secret}`;
  if (!authHeader || authHeader.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));
  } catch { return false; }
}

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceClient();
  let remindersSent = 0;

  // Find confirmed bookings happening tomorrow
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDate = tomorrow.toISOString().split('T')[0];

  const { data: bookings } = await supabase
    .from('bookings')
    .select(`
      id, date, time, guest_name, guest_phone, guest_email,
      reference_code, status, user_id,
      businesses!inner(name),
      services(name)
    `)
    .eq('date', tomorrowDate)
    .in('status', ['confirmed', 'pending']);

  for (const booking of bookings || []) {
    // Try guest_email first, then look up user profile
    let email = (booking as any).guest_email;
    if (!email && booking.user_id) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('email')
        .eq('id', booking.user_id)
        .single();
      email = profile?.email;
    }

    if (email) {
      const businessName = (booking as any).businesses?.name || 'Your business';
      const serviceName = (booking as any).services?.name || 'your appointment';
      const { subject, html } = bookingReminderEmail(
        businessName,
        booking.guest_name || 'Customer',
        serviceName,
        booking.date,
        booking.time || '',
        booking.reference_code || '',
      );
      await sendEmail({ to: email, subject, html });
      remindersSent++;
    }
  }

  return NextResponse.json({ ok: true, remindersSent });
}

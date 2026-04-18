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

  // Get all businesses with their reminder config
  const { data: businesses } = await supabase
    .from('businesses')
    .select('id, metadata')
    .limit(500);

  // Build a set of all reminder hours across businesses (default [24, 2])
  const bizMap = new Map<string, number[]>();
  const allHours = new Set<number>();
  for (const biz of businesses || []) {
    const meta = (biz.metadata || {}) as Record<string, unknown>;
    const hours = (meta.reminder_hours as number[]) || [24, 2];
    bizMap.set(biz.id, hours);
    for (const h of hours) allHours.add(h);
  }

  // For each reminder hour, find bookings that need email reminders
  for (const hoursAhead of allHours) {
    const target = new Date();
    target.setHours(target.getHours() + hoursAhead);
    const targetDate = target.toISOString().split('T')[0];

    const { data: bookings } = await supabase
      .from('bookings')
      .select(`
        id, date, time, guest_name, guest_phone, guest_email,
        reference_code, status, user_id, business_id,
        businesses!inner(name),
        services(name)
      `)
      .eq('date', targetDate)
      .in('status', ['confirmed', 'pending']);

    for (const booking of bookings || []) {
      // Check this business uses this reminder hour
      const bizHours = bizMap.get(booking.business_id) || [24, 2];
      if (!bizHours.includes(hoursAhead)) continue;

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
  }

  return NextResponse.json({ ok: true, remindersSent });
}

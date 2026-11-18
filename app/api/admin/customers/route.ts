import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { adminCorsHeaders } from '@/lib/admin-cors';
import { canonicalCustomerPhone } from '@/lib/customer-suspension';

const cors = adminCorsHeaders(null, 'GET, OPTIONS');

export async function OPTIONS() {
  return NextResponse.json({}, { headers: cors });
}

export async function GET(request: NextRequest) {
  const origin = request.headers.get('origin');
  const headers = adminCorsHeaders(origin, 'GET, OPTIONS');
  const admin = await requirePlatformAdmin(request, { requiredRole: ['admin', 'support'] });
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers });
  }

  const supabase = createServiceClient();

  // Fetch all data using service client (bypasses RLS)
  const [bookingsRes, paymentsRes] = await Promise.all([
    supabase
      .from('bookings')
      .select('id, user_id, business_id, guest_name, guest_phone, guest_email, status, total_amount, deposit_amount, created_at')
      .order('created_at', { ascending: false }),
    supabase
      .from('payments')
      .select('user_id, business_id, booking_id, amount, currency, status, created_at')
      .order('created_at', { ascending: false }),
  ]);

  // A failed read is an error, never an empty customer list.
  if (bookingsRes.error || paymentsRes.error) {
    return NextResponse.json({ error: 'Unable to load customer data' }, { status: 500, headers });
  }
  const bookings: Array<(typeof bookingsRes.data)[number] & { canonical_phone?: string | null }> = bookingsRes.data || [];
  const payments = paymentsRes.data || [];

  // Resolve business IDs from payments via bookings
  const bookingIdSet = new Set(payments.filter(p => !p.business_id && p.booking_id).map(p => p.booking_id));
  let bookingBizMap = new Map<string, string>();
  if (bookingIdSet.size > 0) {
    const { data: bkgs } = await supabase
      .from('bookings')
      .select('id, business_id')
      .in('id', [...bookingIdSet]);
    bookingBizMap = new Map((bkgs || []).map(b => [b.id, b.business_id]));
  }

  // Enrich payments with business_id from bookings
  for (const p of payments) {
    if (!p.business_id && p.booking_id) {
      p.business_id = bookingBizMap.get(p.booking_id) || null;
    }
  }

  // Collect all business IDs
  const allBizIds = new Set<string>();
  for (const b of bookings) if (b.business_id) allBizIds.add(b.business_id);
  for (const p of payments) if (p.business_id) allBizIds.add(p.business_id);

  const { data: businesses } = allBizIds.size > 0
    ? await supabase.from('businesses').select('id, name, country_code').in('id', [...allBizIds])
    : { data: [] };

  // Collect all user IDs
  const allUserIds = new Set<string>();
  for (const b of bookings) if (b.user_id) allUserIds.add(b.user_id);
  for (const p of payments) if (p.user_id) allUserIds.add(p.user_id);

  const { data: profiles } = allUserIds.size > 0
    ? await supabase.from('profiles').select('id, first_name, last_name, email, phone').in('id', [...allUserIds])
    : { data: [] };

  // #1103: the canonical WhatsApp number (E.164 digits) that suspension uses.
  // A local-format guest phone is read in its business's country.
  const bizCountry = new Map((businesses || []).map(b => [b.id, b.country_code as string | null]));
  for (const b of bookings) b.canonical_phone = canonicalCustomerPhone(b.guest_phone, bizCountry.get(b.business_id));

  return NextResponse.json({
    bookings,
    payments,
    businesses: businesses || [],
    profiles: (profiles || []).map(p => ({ ...p, canonical_phone: canonicalCustomerPhone(p.phone) })),
  }, { headers });
}

/**
 * GET /api/stays/[code] — read-only stay confirmation for the customer page
 * /stays/[code] (follow-up to #1121; Owner decision 2026-11-18).
 *
 * `code` is the stay's secret confirmation code (M552, 32 hex characters),
 * never the short reference code. It returns only what the guest already sees
 * in the WhatsApp stay confirmation (getReservationConfirmationMessage):
 * business, property, dates, nights, nightly rate, guests, total, deposit and
 * reference, plus the stay status and the property address shown on the
 * public property page. No guest name, phone, email or special requests.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { formatCurrency, type CountryCode } from '@/lib/constants';

const STAY_CODE_RE = /^[0-9a-f]{32}$/;

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const rateLimit = await rateLimitResponseAsync(getRateLimitKey(req, 'stay-confirmation'), 30, 60_000);
  if (rateLimit) return rateLimit;

  const { code: rawCode } = await params;
  const code = (rawCode || '').toLowerCase();
  const notFound = NextResponse.json({ error: 'Stay not found. Please check the link.' }, { status: 404 });
  if (!STAY_CODE_RE.test(code)) return notFound;

  const supabase = createServiceClient();
  const { data: stay } = await supabase
    .from('reservations')
    .select(`
      reference_code, check_in, check_out, nights, guests, nightly_rate, total_amount, deposit_amount, status,
      business:businesses!business_id(name, country_code, subscription_tier),
      property:properties!property_id(name, address)
    `)
    .eq('confirmation_code', code)
    .maybeSingle();
  if (!stay) return notFound;

  const business = one(stay.business) as { name?: string | null; country_code?: string | null; subscription_tier?: string | null } | null;
  const property = one(stay.property) as { name?: string | null; address?: string | null } | null;
  const cc = (business?.country_code || 'NG') as CountryCode;
  const deposit = Number(stay.deposit_amount || 0);

  return NextResponse.json({
    stay: {
      reference_code: stay.reference_code,
      business_name: business?.name || '',
      property_name: property?.name || '',
      property_address: property?.address || '',
      check_in: stay.check_in,
      check_out: stay.check_out,
      nights: stay.nights,
      guests: stay.guests,
      nightly_rate: formatCurrency(Number(stay.nightly_rate || 0), cc),
      total: formatCurrency(Number(stay.total_amount || 0), cc),
      deposit: deposit > 0 ? formatCurrency(deposit, cc) : null,
      status: stay.status,
      subscription_tier: business?.subscription_tier || 'free',
    },
  }, { headers: { 'Cache-Control': 'no-store' } });
}

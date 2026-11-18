/**
 * GET /api/admin/giving — giving records for the admin Giving page (#1105).
 *
 * Giving is selected by activity, not by business category:
 *   - giving bookings: flow_type='payment' bookings for a service with
 *     service_type='giving' (tithes, offerings; same rule as the bot's
 *     "my giving" history), at any business;
 *   - crowdfunding donations: every campaign_donations row.
 * The page used to load only church/mosque/ngo/crowdfunding_org businesses
 * and never read campaign_donations, so giving at any other business was
 * invisible.
 *
 * Each record carries one payment status: 'success' (deposit paid / donation
 * success), 'refunded', 'failed', 'cancelled' or 'pending'. Only 'success'
 * counts towards totals on the page. Currency is the record's own payment or
 * donation currency, else the business's country currency.
 */
import type { NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { adminPreflight, adminResponder } from '@/lib/admin-route';

const METHODS = 'GET, OPTIONS';
const MAX_ROWS = 5000;
const CHUNK = 200;

type Row = Record<string, any>;
type Service = { from: (table: string) => any };

class ReadError extends Error {}

/** Read rows whose `column` is in `ids`, in chunks so the URL stays short. */
async function readIn(service: Service, table: string, columns: string, column: string, ids: Array<string | null | undefined>): Promise<Row[]> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const out: Row[] = [];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const { data, error } = await service.from(table).select(columns).in(column, unique.slice(i, i + CHUNK));
    if (error) throw new ReadError(table);
    out.push(...(data || []));
  }
  return out;
}

/** A booking or donation can have several payment attempts; keep the one that settled. */
function pickPayment(current: Row | undefined, next: Row): Row {
  const rank = (p: Row) => (p.status === 'success' ? 3 : p.status === 'refunded' ? 2 : p.status === 'failed' ? 0 : 1);
  return !current || rank(next) > rank(current) ? next : current;
}

function bookingStatus(b: Row, payment: Row | undefined): string {
  if (b.deposit_status === 'refunded' || payment?.status === 'refunded') return 'refunded';
  if (b.deposit_status === 'paid') return 'success';
  if (b.status === 'cancelled') return 'cancelled';
  if (payment?.status === 'failed') return 'failed';
  return 'pending';
}

function donationStatus(d: Row, payment: Row | undefined): string {
  if (payment?.status === 'refunded') return 'refunded';
  return d.status === 'success' || d.status === 'failed' ? d.status : 'pending';
}

export async function OPTIONS(request: NextRequest) {
  return adminPreflight(request, METHODS);
}

export async function GET(request: NextRequest) {
  const reply = adminResponder(request, METHODS);
  // Same roles that can open the Giving page (admin/src/lib/permissions.ts).
  const admin = await requirePlatformAdmin(request, { requiredRole: ['admin', 'finance'] });
  if (!admin) return reply({ error: 'Unauthorized' }, 403);
  const service = createServiceClient();

  try {
    const { data: givingServices, error: svcErr } = await service.from('services')
      .select('id, name').eq('service_type', 'giving');
    if (svcErr) throw new ReadError('services');
    const serviceNames = new Map((givingServices || []).map((s: Row) => [s.id, s.name as string]));

    const bookings: Row[] = [];
    const serviceIds = [...serviceNames.keys()];
    for (let i = 0; i < serviceIds.length; i += CHUNK) {
      const { data, error } = await service.from('bookings')
        .select('id, business_id, user_id, service_id, total_amount, deposit_status, status, guest_name, guest_phone, reference_code, notes, created_at')
        .eq('flow_type', 'payment').in('service_id', serviceIds.slice(i, i + CHUNK))
        .order('created_at', { ascending: false }).limit(MAX_ROWS);
      if (error) throw new ReadError('bookings');
      bookings.push(...(data || []));
    }

    const { data: donationData, error: donErr } = await service.from('campaign_donations')
      .select('id, campaign_id, business_id, payment_id, donor_phone, donor_name, amount, currency, status, reference_code, created_at')
      .order('created_at', { ascending: false }).limit(MAX_ROWS);
    if (donErr) throw new ReadError('campaign_donations');
    const donations: Row[] = donationData || [];

    const [bookingPayments, donationPayments, campaigns, profiles] = await Promise.all([
      readIn(service, 'payments', 'id, booking_id, status, currency, gateway, gateway_reference, payment_method', 'booking_id', bookings.map(b => b.id)),
      readIn(service, 'payments', 'id, booking_id, status, currency, gateway, gateway_reference, payment_method', 'id', donations.map(d => d.payment_id)),
      readIn(service, 'campaigns', 'id, title', 'id', donations.map(d => d.campaign_id)),
      readIn(service, 'profiles', 'id, first_name, last_name, email', 'id', bookings.map(b => b.user_id)),
    ]);
    const businesses = await readIn(service, 'businesses', 'id, name, category, country_code', 'id', [...bookings, ...donations].map(r => r.business_id));
    const countries = await readIn(service, 'countries', 'code, currency_code', 'code', businesses.map(b => b.country_code));

    const paymentByBooking = new Map<string, Row>();
    for (const p of bookingPayments) paymentByBooking.set(p.booking_id, pickPayment(paymentByBooking.get(p.booking_id), p));
    const paymentById = new Map(donationPayments.map(p => [p.id, p]));
    const campaignTitles = new Map(campaigns.map(c => [c.id, c.title as string]));
    const profileById = new Map(profiles.map(p => [p.id, p]));
    const bizById = new Map(businesses.map(b => [b.id, b]));
    const currencyByCountry = new Map(countries.map(c => [c.code, c.currency_code as string]));
    const bizCurrency = (biz: Row | undefined) => (biz?.country_code && currencyByCountry.get(biz.country_code)) || null;

    const records = [
      ...bookings.map(b => {
        const biz = bizById.get(b.business_id);
        const payment = paymentByBooking.get(b.id);
        const profile = profileById.get(b.user_id);
        return {
          id: b.id,
          source: 'giving',
          business_id: b.business_id,
          business_name: biz?.name || 'Unknown',
          business_category: biz?.category || '',
          country_code: biz?.country_code || null,
          currency: payment?.currency || bizCurrency(biz),
          giver_id: b.user_id || null,
          giver_name: [profile?.first_name, profile?.last_name].filter(Boolean).join(' ') || b.guest_name || 'Anonymous',
          giver_email: profile?.email || null,
          giver_phone: b.guest_phone || null,
          purpose: serviceNames.get(b.service_id) || null,
          amount: Number(b.total_amount || 0),
          status: bookingStatus(b, payment),
          reference_code: b.reference_code || null,
          notes: b.notes || null,
          payment_method: payment?.payment_method || null,
          gateway: payment?.gateway || null,
          gateway_ref: payment?.gateway_reference || null,
          created_at: b.created_at,
        };
      }),
      ...donations.map(d => {
        const biz = bizById.get(d.business_id);
        const payment = d.payment_id ? paymentById.get(d.payment_id) : undefined;
        return {
          id: d.id,
          source: 'crowdfunding',
          business_id: d.business_id,
          business_name: biz?.name || 'Unknown',
          business_category: biz?.category || '',
          country_code: biz?.country_code || null,
          currency: d.currency || payment?.currency || bizCurrency(biz),
          giver_id: null,
          giver_name: d.donor_name || 'Anonymous',
          giver_email: null,
          giver_phone: d.donor_phone || null,
          purpose: campaignTitles.get(d.campaign_id) || null,
          amount: Number(d.amount || 0),
          status: donationStatus(d, payment),
          reference_code: d.reference_code || null,
          notes: null,
          payment_method: payment?.payment_method || null,
          gateway: payment?.gateway || null,
          gateway_ref: payment?.gateway_reference || null,
          created_at: d.created_at,
        };
      }),
    ].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

    const truncated = donations.length >= MAX_ROWS || bookings.length >= MAX_ROWS;
    return reply({ records, truncated });
  } catch (err) {
    if (err instanceof ReadError) return reply({ error: 'Could not load giving records' }, 500);
    throw err;
  }
}

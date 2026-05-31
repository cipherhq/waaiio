import { createServiceClient } from '@/lib/supabase/service';
import { generateReceiptPdf, generateHistoryPdf, generateAnnualStatementPdf } from '@/lib/pdf/receipt-generator';
import type { HistoryRow } from '@/lib/pdf/receipt-generator';
import { PRICING_TIERS, type CountryCode, type SubscriptionTier } from '@/lib/constants';
import { logger } from '@/lib/logger';

/**
 * Generate a receipt/history/annual PDF directly (no HTTP self-fetch).
 * Used by bot.service.ts and capability-selection.flow.ts.
 */
export async function generateDocumentDirect(
  userId: string,
  type: 'receipt' | 'history' | 'annual',
  phone: string,
  year?: number,
): Promise<{ url: string; filename: string } | null> {
  try {
    const supabase = createServiceClient();

    const { data: profile } = await supabase
      .from('profiles')
      .select('id, first_name, last_name, phone')
      .eq('id', userId)
      .single();

    if (!profile) return null;

    const customerName = [profile.first_name, profile.last_name].filter(Boolean).join(' ') || 'Customer';
    const customerPhone = profile.phone || phone;

    let pdfBuffer: Buffer;
    let docType: 'receipt' | 'history' | 'annual' = type;

    if (type === 'receipt') {
      const result = await buildReceipt(supabase, userId, customerName, customerPhone);
      if (!result) return null;
      pdfBuffer = result;
    } else if (type === 'history') {
      const result = await buildHistory(supabase, userId, customerName, customerPhone);
      if (!result) return null;
      pdfBuffer = result;
    } else {
      const targetYear = year || new Date().getFullYear() - 1;
      const result = await buildAnnual(supabase, userId, customerName, customerPhone, targetYear);
      if (!result) return null;
      pdfBuffer = result;
    }

    // Upload and sign
    const uuid = crypto.randomUUID();
    const filePath = `receipts/${userId}/${uuid}.pdf`;
    const filenameMap = { receipt: `receipt-${uuid.slice(0, 8)}.pdf`, history: `history-${uuid.slice(0, 8)}.pdf`, annual: `annual-statement-${uuid.slice(0, 8)}.pdf` };
    const filename = filenameMap[docType];

    const { error: uploadError } = await supabase.storage
      .from('customer-reports')
      .upload(filePath, pdfBuffer, { contentType: 'application/pdf', upsert: false });

    if (uploadError) {
      logger.error('[RECEIPTS] Upload error:', uploadError);
      return null;
    }

    const { data: signedUrlData, error: signError } = await supabase.storage
      .from('customer-reports')
      .createSignedUrl(filePath, 3600);

    if (signError || !signedUrlData?.signedUrl) {
      logger.error('[RECEIPTS] Signed URL error:', signError);
      return null;
    }

    return { url: signedUrlData.signedUrl, filename };
  } catch (err) {
    logger.error('[RECEIPTS] generateDocumentDirect error:', err);
    return null;
  }
}

async function buildReceipt(
  supabase: ReturnType<typeof createServiceClient>,
  userId: string,
  customerName: string,
  customerPhone: string,
): Promise<Buffer | null> {
  const [{ data: recentBooking }, { data: recentCharge }, { data: recentPayment }, { data: recentOrder }] = await Promise.all([
    supabase.from('bookings')
      .select('id, reference_code, date, status, total_amount, created_at, services(name), businesses(name, country_code, subscription_tier, logo_url)')
      .eq('user_id', userId).in('status', ['completed', 'confirmed', 'pending'])
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('subscription_charges')
      .select('id, reference_code, amount, status, created_at, services(name), businesses(name, country_code, subscription_tier, logo_url)')
      .eq('user_id', userId).eq('status', 'success')
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('payments')
      .select('id, gateway_reference, amount, status, created_at, booking_id, businesses:business_id(name, country_code, subscription_tier)')
      .eq('user_id', userId).eq('status', 'success')
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('orders')
      .select('id, reference_code, status, total_amount, created_at, businesses:business_id(name, country_code, subscription_tier, logo_url)')
      .eq('user_id', userId).in('status', ['confirmed', 'processing', 'ready', 'delivered'])
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);

  type Candidate = { source: string; date: Date; data: any };
  const candidates: Candidate[] = [];
  if (recentBooking) candidates.push({ source: 'booking', date: new Date(recentBooking.created_at), data: recentBooking });
  if (recentCharge) candidates.push({ source: 'charge', date: new Date(recentCharge.created_at), data: recentCharge });
  if (recentPayment) candidates.push({ source: 'payment', date: new Date(recentPayment.created_at), data: recentPayment });
  if (recentOrder) candidates.push({ source: 'order', date: new Date(recentOrder.created_at), data: recentOrder });

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.date.getTime() - a.date.getTime());
  const best = candidates[0];
  const d = best.data;
  const biz = d.businesses as { name: string; country_code?: string; subscription_tier?: string; logo_url?: string } | null;
  const svc = d.services as { name: string } | null;
  const cc = (biz?.country_code || 'NG') as CountryCode;

  let serviceName = svc?.name || (best.source === 'charge' ? 'Subscription' : best.source === 'order' ? 'Order' : 'Payment');
  if (best.source === 'payment' && d.booking_id) {
    const { data: linked } = await supabase.from('bookings').select('services(name)').eq('id', d.booking_id).single();
    if (linked) {
      const ls = linked.services as unknown as { name: string } | null;
      if (ls?.name) serviceName = ls.name;
    }
  }

  const tier = (biz?.subscription_tier || 'free') as SubscriptionTier;
  return await generateReceiptPdf({
    businessName: biz?.name || 'Business',
    referenceCode: d.reference_code || d.gateway_reference || '-',
    date: d.date || d.created_at,
    serviceName,
    amount: d.total_amount || d.amount || 0,
    paymentStatus: d.status,
    customerName,
    customerPhone,
    countryCode: cc,
    whitelabel: PRICING_TIERS[tier]?.whitelabel === true,
    logoUrl: biz?.logo_url || undefined,
  });
}

async function buildHistory(
  supabase: ReturnType<typeof createServiceClient>,
  userId: string,
  customerName: string,
  customerPhone: string,
): Promise<Buffer | null> {
  const [{ data: bookings }, { data: charges }, { data: payments }, { data: invoices }, { data: orders }] = await Promise.all([
    supabase.from('bookings')
      .select('id, reference_code, date, status, total_amount, created_at, services(name), businesses(name, country_code)')
      .eq('user_id', userId).in('status', ['completed', 'confirmed', 'pending'])
      .order('created_at', { ascending: false }).limit(50),
    supabase.from('subscription_charges')
      .select('reference_code, amount, status, created_at, services(name), businesses(name, country_code)')
      .eq('user_id', userId).eq('status', 'success')
      .order('created_at', { ascending: false }).limit(50),
    supabase.from('payments')
      .select('gateway_reference, amount, status, created_at, booking_id, businesses:business_id(name, country_code)')
      .eq('user_id', userId).eq('status', 'success')
      .order('created_at', { ascending: false }).limit(50),
    supabase.from('invoices')
      .select('invoice_number, total_amount, status, paid_at, created_at, businesses:business_id(name, country_code)')
      .eq('customer_phone', customerPhone).eq('status', 'paid')
      .order('paid_at', { ascending: false }).limit(50),
    supabase.from('orders')
      .select('reference_code, total_amount, status, created_at, businesses:business_id(name, country_code)')
      .eq('user_id', userId).in('status', ['confirmed', 'processing', 'ready', 'delivered'])
      .order('created_at', { ascending: false }).limit(50),
  ]);

  const rows: HistoryRow[] = [];
  let countryCode: CountryCode = 'NG';
  const bookingIds = new Set<string>();

  if (bookings) for (const b of bookings) {
    const biz = b.businesses as unknown as { name: string; country_code?: string } | null;
    const svc = b.services as unknown as { name: string } | null;
    if (biz?.country_code) countryCode = biz.country_code as CountryCode;
    bookingIds.add((b as any).id);
    rows.push({ date: b.date || b.created_at, serviceName: svc?.name || 'Service', businessName: biz?.name || 'Business', referenceCode: b.reference_code || '-', amount: b.total_amount || 0, status: b.status });
  }
  if (orders) for (const o of orders) {
    const biz = o.businesses as unknown as { name: string; country_code?: string } | null;
    if (biz?.country_code) countryCode = biz.country_code as CountryCode;
    rows.push({ date: o.created_at, serviceName: 'Order', businessName: biz?.name || 'Business', referenceCode: o.reference_code || '-', amount: o.total_amount || 0, status: o.status });
  }
  if (charges) for (const c of charges) {
    const biz = c.businesses as unknown as { name: string; country_code?: string } | null;
    const svc = c.services as unknown as { name: string } | null;
    if (biz?.country_code) countryCode = biz.country_code as CountryCode;
    rows.push({ date: c.created_at, serviceName: svc?.name || 'Subscription', businessName: biz?.name || 'Business', referenceCode: c.reference_code || '-', amount: c.amount || 0, status: c.status });
  }
  if (payments) for (const p of payments) {
    if (p.booking_id && bookingIds.has(p.booking_id)) continue;
    const biz = p.businesses as unknown as { name: string; country_code?: string } | null;
    if (biz?.country_code) countryCode = biz.country_code as CountryCode;
    rows.push({ date: p.created_at, serviceName: 'Payment', businessName: biz?.name || 'Business', referenceCode: p.gateway_reference || '-', amount: p.amount || 0, status: p.status });
  }
  if (invoices) for (const inv of invoices) {
    const biz = inv.businesses as unknown as { name: string; country_code?: string } | null;
    if (biz?.country_code) countryCode = biz.country_code as CountryCode;
    rows.push({ date: inv.paid_at || inv.created_at, serviceName: 'Invoice', businessName: biz?.name || 'Business', referenceCode: inv.invoice_number || '-', amount: inv.total_amount || 0, status: inv.status });
  }

  if (rows.length === 0) return null;
  rows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return await generateHistoryPdf({ customerName, customerPhone, countryCode, rows: rows.slice(0, 50) });
}

async function buildAnnual(
  supabase: ReturnType<typeof createServiceClient>,
  userId: string,
  customerName: string,
  customerPhone: string,
  year: number,
): Promise<Buffer | null> {
  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;

  const [{ data: bookings }, { data: charges }, { data: payments }, { data: invoices }, { data: orders }] = await Promise.all([
    supabase.from('bookings')
      .select('id, reference_code, date, status, total_amount, created_at, services(name), businesses(name, country_code)')
      .eq('user_id', userId).in('status', ['completed', 'confirmed'])
      .gte('created_at', `${startDate}T00:00:00`).lte('created_at', `${endDate}T23:59:59`)
      .order('created_at', { ascending: true }).limit(200),
    supabase.from('subscription_charges')
      .select('reference_code, amount, status, created_at, services(name), businesses(name, country_code)')
      .eq('user_id', userId).eq('status', 'success')
      .gte('created_at', `${startDate}T00:00:00`).lte('created_at', `${endDate}T23:59:59`)
      .order('created_at', { ascending: true }).limit(200),
    supabase.from('payments')
      .select('gateway_reference, amount, status, created_at, booking_id, businesses:business_id(name, country_code)')
      .eq('user_id', userId).eq('status', 'success')
      .gte('created_at', `${startDate}T00:00:00`).lte('created_at', `${endDate}T23:59:59`)
      .order('created_at', { ascending: true }).limit(200),
    supabase.from('invoices')
      .select('invoice_number, total_amount, status, paid_at, created_at, businesses:business_id(name, country_code)')
      .eq('customer_phone', customerPhone).eq('status', 'paid')
      .gte('paid_at', `${startDate}T00:00:00`).lte('paid_at', `${endDate}T23:59:59`)
      .order('paid_at', { ascending: true }).limit(200),
    supabase.from('orders')
      .select('reference_code, total_amount, status, created_at, businesses:business_id(name, country_code)')
      .eq('user_id', userId).in('status', ['confirmed', 'processing', 'ready', 'delivered'])
      .gte('created_at', `${startDate}T00:00:00`).lte('created_at', `${endDate}T23:59:59`)
      .order('created_at', { ascending: true }).limit(200),
  ]);

  const rows: HistoryRow[] = [];
  let countryCode: CountryCode = 'NG';
  let businessName: string | undefined;
  const annualBookingIds = new Set<string>();

  if (bookings) for (const b of bookings) {
    const biz = b.businesses as unknown as { name: string; country_code?: string } | null;
    const svc = b.services as unknown as { name: string } | null;
    if (biz?.country_code) countryCode = biz.country_code as CountryCode;
    if (biz?.name && !businessName) businessName = biz.name;
    annualBookingIds.add((b as any).id);
    rows.push({ date: b.date || b.created_at, serviceName: svc?.name || 'Service', businessName: biz?.name || 'Business', referenceCode: b.reference_code || '-', amount: b.total_amount || 0, status: b.status });
  }
  if (orders) for (const o of orders) {
    const biz = o.businesses as unknown as { name: string; country_code?: string } | null;
    if (biz?.country_code) countryCode = biz.country_code as CountryCode;
    if (biz?.name && !businessName) businessName = biz.name;
    rows.push({ date: o.created_at, serviceName: 'Order', businessName: biz?.name || 'Business', referenceCode: o.reference_code || '-', amount: o.total_amount || 0, status: o.status });
  }
  if (charges) for (const c of charges) {
    const biz = c.businesses as unknown as { name: string; country_code?: string } | null;
    const svc = c.services as unknown as { name: string } | null;
    if (biz?.country_code) countryCode = biz.country_code as CountryCode;
    if (biz?.name && !businessName) businessName = biz.name;
    rows.push({ date: c.created_at, serviceName: svc?.name || 'Subscription', businessName: biz?.name || 'Business', referenceCode: c.reference_code || '-', amount: c.amount || 0, status: c.status });
  }
  if (payments) for (const p of payments) {
    if (p.booking_id && annualBookingIds.has(p.booking_id)) continue;
    const biz = p.businesses as unknown as { name: string; country_code?: string } | null;
    if (biz?.country_code) countryCode = biz.country_code as CountryCode;
    if (biz?.name && !businessName) businessName = biz.name;
    rows.push({ date: p.created_at, serviceName: 'Payment', businessName: biz?.name || 'Business', referenceCode: p.gateway_reference || '-', amount: p.amount || 0, status: p.status });
  }
  if (invoices) for (const inv of invoices) {
    const biz = inv.businesses as unknown as { name: string; country_code?: string } | null;
    if (biz?.country_code) countryCode = biz.country_code as CountryCode;
    if (biz?.name && !businessName) businessName = biz.name;
    rows.push({ date: inv.paid_at || inv.created_at, serviceName: 'Invoice', businessName: biz?.name || 'Business', referenceCode: inv.invoice_number || '-', amount: inv.total_amount || 0, status: inv.status });
  }

  if (rows.length === 0) return null;
  rows.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  return await generateAnnualStatementPdf({ customerName, customerPhone, countryCode, year, businessName, rows });
}

import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { generateReceiptPdf, generateHistoryPdf, generateAnnualStatementPdf } from '@/lib/pdf/receipt-generator';
import type { HistoryRow } from '@/lib/pdf/receipt-generator';
import { PRICING_TIERS, type CountryCode, type SubscriptionTier } from '@/lib/constants';
import { logger } from '@/lib/logger';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    // Verify internal token (or allow if not configured — internal API only)
    const expectedToken = process.env.INTERNAL_API_TOKEN;
    if (expectedToken) {
      const token = request.headers.get('x-internal-token');
      if (!token || token !== expectedToken) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    const { userId, type, phone, year } = await request.json();

    if (!userId || !type || !phone) {
      return NextResponse.json({ error: 'userId, type, and phone required' }, { status: 400 });
    }

    if (type !== 'history' && type !== 'receipt' && type !== 'annual') {
      return NextResponse.json({ error: 'type must be "history", "receipt", or "annual"' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Get customer profile
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, first_name, last_name, phone')
      .eq('id', userId)
      .single();

    if (!profile) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const customerName = [profile.first_name, profile.last_name].filter(Boolean).join(' ') || 'Customer';
    const customerPhone = profile.phone || phone;

    if (type === 'receipt') {
      return await handleReceipt(supabase, userId, customerName, customerPhone);
    } else if (type === 'annual') {
      const targetYear = year ? Number(year) : new Date().getFullYear() - 1;
      return await handleAnnual(supabase, userId, customerName, customerPhone, targetYear);
    } else {
      return await handleHistory(supabase, userId, customerName, customerPhone);
    }
  } catch (error) {
    logger.error('[RECEIPTS] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function handleReceipt(
  supabase: ReturnType<typeof createServiceClient>,
  userId: string,
  customerName: string,
  customerPhone: string,
) {
  // Fetch most recent booking
  const { data: recentBooking } = await supabase
    .from('bookings')
    .select('id, reference_code, date, status, total_amount, created_at, services(name), businesses(name, country_code, subscription_tier)')
    .eq('user_id', userId)
    .in('status', ['completed', 'confirmed', 'pending'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Fetch most recent subscription charge
  const { data: recentCharge } = await supabase
    .from('subscription_charges')
    .select('id, reference_code, amount, status, created_at, services(name), businesses(name, country_code, subscription_tier)')
    .eq('user_id', userId)
    .eq('status', 'success')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Fetch most recent payment (covers event tickets, general payments, etc.)
  const { data: recentPayment } = await supabase
    .from('payments')
    .select('id, gateway_reference, amount, status, created_at, booking_id, businesses:business_id(name, country_code, subscription_tier)')
    .eq('user_id', userId)
    .eq('status', 'success')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Fetch most recent paid invoice
  const { data: recentInvoice } = await supabase
    .from('invoices')
    .select('id, invoice_number, total_amount, status, paid_at, created_at, customer_name, customer_phone, business_id, businesses:business_id(name, country_code, subscription_tier)')
    .eq('customer_phone', customerPhone)
    .eq('status', 'paid')
    .order('paid_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Fetch most recent campaign donation
  const phoneP = customerPhone.startsWith('+') ? customerPhone : `+${customerPhone}`;
  const phoneN = customerPhone.startsWith('+') ? customerPhone.slice(1) : customerPhone;
  const { data: recentDonation } = await supabase
    .from('campaign_donations')
    .select('id, amount, reference_code, created_at, campaigns:campaign_id(name), businesses:business_id(name, country_code)')
    .or(`donor_phone.eq.${phoneP},donor_phone.eq.${phoneN}`)
    .eq('status', 'success')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Use whichever is newest
  type TransactionSource = 'booking' | 'charge' | 'payment' | 'invoice' | 'donation';
  let source: TransactionSource | null = null;
  const candidates: { source: TransactionSource; date: Date }[] = [];
  if (recentBooking) candidates.push({ source: 'booking', date: new Date(recentBooking.created_at) });
  if (recentCharge) candidates.push({ source: 'charge', date: new Date(recentCharge.created_at) });
  if (recentPayment) candidates.push({ source: 'payment', date: new Date(recentPayment.created_at) });
  if (recentInvoice) candidates.push({ source: 'invoice', date: new Date(recentInvoice.paid_at || recentInvoice.created_at) });
  if (recentDonation) candidates.push({ source: 'donation', date: new Date(recentDonation.created_at) });

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.date.getTime() - a.date.getTime());
    source = candidates[0].source;
  }

  if (!source) {
    return NextResponse.json({ error: 'No transactions found' }, { status: 404 });
  }

  let receiptData;
  if (source === 'booking' && recentBooking) {
    const biz = recentBooking.businesses as unknown as { name: string; country_code?: string; subscription_tier?: string } | null;
    const svc = recentBooking.services as unknown as { name: string } | null;
    const countryCode = (biz?.country_code || 'NG') as CountryCode;

    receiptData = {
      businessName: biz?.name || 'Business',
      referenceCode: recentBooking.reference_code || '-',
      date: recentBooking.date || recentBooking.created_at,
      serviceName: svc?.name || 'Service',
      amount: recentBooking.total_amount || 0,
      paymentStatus: recentBooking.status,
      customerName,
      customerPhone,
      countryCode,
      whitelabel: PRICING_TIERS[(biz?.subscription_tier || 'free') as SubscriptionTier]?.whitelabel === true,
    };
  } else if (source === 'charge' && recentCharge) {
    const biz = recentCharge.businesses as unknown as { name: string; country_code?: string; subscription_tier?: string } | null;
    const svc = recentCharge.services as unknown as { name: string } | null;
    const countryCode = (biz?.country_code || 'NG') as CountryCode;

    receiptData = {
      businessName: biz?.name || 'Business',
      referenceCode: recentCharge.reference_code || '-',
      date: recentCharge.created_at,
      serviceName: svc?.name || 'Subscription',
      amount: recentCharge.amount || 0,
      paymentStatus: recentCharge.status,
      customerName,
      customerPhone,
      countryCode,
      whitelabel: PRICING_TIERS[(biz?.subscription_tier || 'free') as SubscriptionTier]?.whitelabel === true,
    };
  } else if (source === 'payment' && recentPayment) {
    const biz = recentPayment.businesses as unknown as { name: string; country_code?: string; subscription_tier?: string } | null;
    const countryCode = (biz?.country_code || 'NG') as CountryCode;

    // If payment has a booking_id, try to get the service name from the booking
    let serviceName = 'Payment';
    if (recentPayment.booking_id) {
      const { data: linkedBooking } = await supabase
        .from('bookings')
        .select('services(name)')
        .eq('id', recentPayment.booking_id)
        .single();
      if (linkedBooking) {
        const svc = linkedBooking.services as unknown as { name: string } | null;
        if (svc?.name) serviceName = svc.name;
      }
    }

    receiptData = {
      businessName: biz?.name || 'Business',
      referenceCode: recentPayment.gateway_reference || '-',
      date: recentPayment.created_at,
      serviceName,
      amount: recentPayment.amount || 0,
      paymentStatus: recentPayment.status,
      customerName,
      customerPhone,
      countryCode,
      whitelabel: PRICING_TIERS[(biz?.subscription_tier || 'free') as SubscriptionTier]?.whitelabel === true,
    };
  } else if (source === 'invoice' && recentInvoice) {
    const biz = recentInvoice.businesses as unknown as { name: string; country_code?: string; subscription_tier?: string } | null;
    const countryCode = (biz?.country_code || 'NG') as CountryCode;

    receiptData = {
      businessName: biz?.name || 'Business',
      referenceCode: recentInvoice.invoice_number || '-',
      date: recentInvoice.paid_at || recentInvoice.created_at,
      serviceName: 'Invoice',
      amount: recentInvoice.total_amount || 0,
      paymentStatus: recentInvoice.status,
      customerName: recentInvoice.customer_name || customerName,
      customerPhone,
      countryCode,
      whitelabel: PRICING_TIERS[(biz?.subscription_tier || 'free') as SubscriptionTier]?.whitelabel === true,
    };
  } else if (source === 'donation' && recentDonation) {
    const biz = recentDonation.businesses as unknown as { name: string; country_code?: string } | null;
    const campaign = recentDonation.campaigns as unknown as { name: string } | null;
    const countryCode = (biz?.country_code || 'NG') as CountryCode;

    receiptData = {
      businessName: biz?.name || 'Organization',
      referenceCode: recentDonation.reference_code || '-',
      date: recentDonation.created_at,
      serviceName: campaign?.name || 'Donation',
      amount: recentDonation.amount || 0,
      paymentStatus: 'success',
      customerName,
      customerPhone,
      countryCode,
      whitelabel: false,
    };
  } else {
    return NextResponse.json({ error: 'No transactions found' }, { status: 404 });
  }

  const pdfBuffer = await generateReceiptPdf(receiptData);
  return await uploadAndSign(supabase, pdfBuffer, userId, 'receipt');
}

async function handleHistory(
  supabase: ReturnType<typeof createServiceClient>,
  userId: string,
  customerName: string,
  customerPhone: string,
) {
  // Fetch bookings
  const { data: bookings } = await supabase
    .from('bookings')
    .select('id, reference_code, date, status, total_amount, created_at, services(name), businesses(name, country_code)')
    .eq('user_id', userId)
    .in('status', ['completed', 'confirmed', 'pending'])
    .order('created_at', { ascending: false })
    .limit(50);

  // Fetch subscription charges
  const { data: charges } = await supabase
    .from('subscription_charges')
    .select('reference_code, amount, status, created_at, services(name), businesses(name, country_code)')
    .eq('user_id', userId)
    .eq('status', 'success')
    .order('created_at', { ascending: false })
    .limit(50);

  // Fetch payments (covers event tickets, general payments, etc.)
  const { data: payments } = await supabase
    .from('payments')
    .select('gateway_reference, amount, status, created_at, booking_id, businesses:business_id(name, country_code)')
    .eq('user_id', userId)
    .eq('status', 'success')
    .order('created_at', { ascending: false })
    .limit(50);

  // Fetch paid invoices
  const { data: invoices } = await supabase
    .from('invoices')
    .select('invoice_number, total_amount, status, paid_at, created_at, customer_name, businesses:business_id(name, country_code)')
    .eq('customer_phone', customerPhone)
    .eq('status', 'paid')
    .order('paid_at', { ascending: false })
    .limit(50);

  // Merge and sort by date
  const rows: HistoryRow[] = [];
  let countryCode: CountryCode = 'NG';

  // Collect booking IDs that already have rows so we don't double-count payments linked to bookings
  const bookingIds = new Set<string>();

  if (bookings) {
    for (const b of bookings) {
      const biz = b.businesses as unknown as { name: string; country_code?: string } | null;
      const svc = b.services as unknown as { name: string } | null;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      bookingIds.add((b as any).id || '');
      rows.push({
        date: b.date || b.created_at,
        serviceName: svc?.name || 'Service',
        businessName: biz?.name || 'Business',
        referenceCode: b.reference_code || '-',
        amount: b.total_amount || 0,
        status: b.status,
      });
    }
  }

  if (charges) {
    for (const c of charges) {
      const biz = c.businesses as unknown as { name: string; country_code?: string } | null;
      const svc = c.services as unknown as { name: string } | null;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      rows.push({
        date: c.created_at,
        serviceName: svc?.name || 'Subscription',
        businessName: biz?.name || 'Business',
        referenceCode: c.reference_code || '-',
        amount: c.amount || 0,
        status: c.status,
      });
    }
  }

  if (payments) {
    for (const p of payments) {
      // Skip payments that are already represented by a booking row
      if (p.booking_id && bookingIds.has(p.booking_id)) continue;
      const biz = p.businesses as unknown as { name: string; country_code?: string } | null;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      rows.push({
        date: p.created_at,
        serviceName: 'Payment',
        businessName: biz?.name || 'Business',
        referenceCode: p.gateway_reference || '-',
        amount: p.amount || 0,
        status: p.status,
      });
    }
  }

  if (invoices) {
    for (const inv of invoices) {
      const biz = inv.businesses as unknown as { name: string; country_code?: string } | null;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      rows.push({
        date: inv.paid_at || inv.created_at,
        serviceName: 'Invoice',
        businessName: biz?.name || 'Business',
        referenceCode: inv.invoice_number || '-',
        amount: inv.total_amount || 0,
        status: inv.status,
      });
    }
  }

  // Fetch campaign donations
  const histPhoneP = customerPhone.startsWith('+') ? customerPhone : `+${customerPhone}`;
  const histPhoneN = customerPhone.startsWith('+') ? customerPhone.slice(1) : customerPhone;
  const { data: donations } = await supabase
    .from('campaign_donations')
    .select('amount, reference_code, created_at, campaigns:campaign_id(name), businesses:business_id(name, country_code)')
    .or(`donor_phone.eq.${histPhoneP},donor_phone.eq.${histPhoneN}`)
    .eq('status', 'success')
    .order('created_at', { ascending: false })
    .limit(50);

  if (donations) {
    for (const d of donations) {
      const biz = d.businesses as unknown as { name: string; country_code?: string } | null;
      const campaign = d.campaigns as unknown as { name: string } | null;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      rows.push({
        date: d.created_at,
        serviceName: campaign?.name || 'Donation',
        businessName: biz?.name || 'Organization',
        referenceCode: d.reference_code || '-',
        amount: d.amount || 0,
        status: 'success',
      });
    }
  }

  if (rows.length === 0) {
    return NextResponse.json({ error: 'No transactions found' }, { status: 404 });
  }

  // Sort by date descending, cap at 50
  rows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const capped = rows.slice(0, 50);

  const pdfBuffer = await generateHistoryPdf({
    customerName,
    customerPhone,
    countryCode,
    rows: capped,
  });

  return await uploadAndSign(supabase, pdfBuffer, userId, 'history');
}

async function handleAnnual(
  supabase: ReturnType<typeof createServiceClient>,
  userId: string,
  customerName: string,
  customerPhone: string,
  year: number,
) {
  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;

  // Fetch bookings for the year
  const { data: bookings } = await supabase
    .from('bookings')
    .select('id, reference_code, date, status, total_amount, created_at, services(name), businesses(name, country_code)')
    .eq('user_id', userId)
    .in('status', ['completed', 'confirmed'])
    .gte('created_at', `${startDate}T00:00:00`)
    .lte('created_at', `${endDate}T23:59:59`)
    .order('created_at', { ascending: true })
    .limit(200);

  // Fetch subscription charges for the year
  const { data: charges } = await supabase
    .from('subscription_charges')
    .select('reference_code, amount, status, created_at, services(name), businesses(name, country_code)')
    .eq('user_id', userId)
    .eq('status', 'success')
    .gte('created_at', `${startDate}T00:00:00`)
    .lte('created_at', `${endDate}T23:59:59`)
    .order('created_at', { ascending: true })
    .limit(200);

  // Fetch payments for the year
  const { data: annualPayments } = await supabase
    .from('payments')
    .select('gateway_reference, amount, status, created_at, booking_id, businesses:business_id(name, country_code)')
    .eq('user_id', userId)
    .eq('status', 'success')
    .gte('created_at', `${startDate}T00:00:00`)
    .lte('created_at', `${endDate}T23:59:59`)
    .order('created_at', { ascending: true })
    .limit(200);

  // Fetch paid invoices for the year
  const { data: annualInvoices } = await supabase
    .from('invoices')
    .select('invoice_number, total_amount, status, paid_at, created_at, customer_name, businesses:business_id(name, country_code)')
    .eq('customer_phone', customerPhone)
    .eq('status', 'paid')
    .gte('paid_at', `${startDate}T00:00:00`)
    .lte('paid_at', `${endDate}T23:59:59`)
    .order('paid_at', { ascending: true })
    .limit(200);

  const rows: HistoryRow[] = [];
  let countryCode: CountryCode = 'NG';
  let businessName: string | undefined;
  const annualBookingIds = new Set<string>();

  if (bookings) {
    for (const b of bookings) {
      const biz = b.businesses as unknown as { name: string; country_code?: string } | null;
      const svc = b.services as unknown as { name: string } | null;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      if (biz?.name && !businessName) businessName = biz.name;
      annualBookingIds.add((b as any).id || '');
      rows.push({
        date: b.date || b.created_at,
        serviceName: svc?.name || 'Service',
        businessName: biz?.name || 'Business',
        referenceCode: b.reference_code || '-',
        amount: b.total_amount || 0,
        status: b.status,
      });
    }
  }

  if (charges) {
    for (const c of charges) {
      const biz = c.businesses as unknown as { name: string; country_code?: string } | null;
      const svc = c.services as unknown as { name: string } | null;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      if (biz?.name && !businessName) businessName = biz.name;
      rows.push({
        date: c.created_at,
        serviceName: svc?.name || 'Subscription',
        businessName: biz?.name || 'Business',
        referenceCode: c.reference_code || '-',
        amount: c.amount || 0,
        status: c.status,
      });
    }
  }

  if (annualPayments) {
    for (const p of annualPayments) {
      if (p.booking_id && annualBookingIds.has(p.booking_id)) continue;
      const biz = p.businesses as unknown as { name: string; country_code?: string } | null;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      if (biz?.name && !businessName) businessName = biz.name;
      rows.push({
        date: p.created_at,
        serviceName: 'Payment',
        businessName: biz?.name || 'Business',
        referenceCode: p.gateway_reference || '-',
        amount: p.amount || 0,
        status: p.status,
      });
    }
  }

  if (annualInvoices) {
    for (const inv of annualInvoices) {
      const biz = inv.businesses as unknown as { name: string; country_code?: string } | null;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      if (biz?.name && !businessName) businessName = biz.name;
      rows.push({
        date: inv.paid_at || inv.created_at,
        serviceName: 'Invoice',
        businessName: biz?.name || 'Business',
        referenceCode: inv.invoice_number || '-',
        amount: inv.total_amount || 0,
        status: inv.status,
      });
    }
  }

  // Fetch campaign donations for the year
  const annPhoneP = customerPhone.startsWith('+') ? customerPhone : `+${customerPhone}`;
  const annPhoneN = customerPhone.startsWith('+') ? customerPhone.slice(1) : customerPhone;
  const { data: annualDonations } = await supabase
    .from('campaign_donations')
    .select('amount, reference_code, created_at, campaigns:campaign_id(name), businesses:business_id(name, country_code)')
    .or(`donor_phone.eq.${annPhoneP},donor_phone.eq.${annPhoneN}`)
    .eq('status', 'success')
    .gte('created_at', `${startDate}T00:00:00`)
    .lte('created_at', `${endDate}T23:59:59`)
    .order('created_at', { ascending: true })
    .limit(200);

  if (annualDonations) {
    for (const d of annualDonations) {
      const biz = d.businesses as unknown as { name: string; country_code?: string } | null;
      const campaign = d.campaigns as unknown as { name: string } | null;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      if (biz?.name && !businessName) businessName = biz.name;
      rows.push({
        date: d.created_at,
        serviceName: campaign?.name || 'Donation',
        businessName: biz?.name || 'Organization',
        referenceCode: d.reference_code || '-',
        amount: d.amount || 0,
        status: 'success',
      });
    }
  }

  if (rows.length === 0) {
    return NextResponse.json({ error: `No transactions found for ${year}` }, { status: 404 });
  }

  // Sort chronologically
  rows.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const pdfBuffer = await generateAnnualStatementPdf({
    customerName,
    customerPhone,
    countryCode,
    year,
    businessName: rows.length > 0 ? undefined : businessName, // omit if multi-business
    rows,
  });

  return await uploadAndSign(supabase, pdfBuffer, userId, 'annual');
}

async function uploadAndSign(
  supabase: ReturnType<typeof createServiceClient>,
  pdfBuffer: Buffer,
  userId: string,
  type: 'receipt' | 'history' | 'annual',
) {
  const uuid = crypto.randomUUID();
  const filePath = `receipts/${userId}/${uuid}.pdf`;
  const filenameMap = {
    receipt: `receipt-${uuid.slice(0, 8)}.pdf`,
    history: `history-${uuid.slice(0, 8)}.pdf`,
    annual: `annual-statement-${uuid.slice(0, 8)}.pdf`,
  };
  const filename = filenameMap[type];

  // Upload to Supabase Storage
  const { error: uploadError } = await supabase.storage
    .from('customer-reports')
    .upload(filePath, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: false,
    });

  if (uploadError) {
    logger.error('[RECEIPTS] Upload error:', uploadError);
    return NextResponse.json({ error: 'Failed to upload PDF' }, { status: 500 });
  }

  // Create signed URL (1 hour)
  const { data: signedUrlData, error: signError } = await supabase.storage
    .from('customer-reports')
    .createSignedUrl(filePath, 3600);

  if (signError || !signedUrlData?.signedUrl) {
    logger.error('[RECEIPTS] Signed URL error:', signError);
    return NextResponse.json({ error: 'Failed to create download link' }, { status: 500 });
  }

  return NextResponse.json({ url: signedUrlData.signedUrl, filename });
}

import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { generateReceiptPdf, generateHistoryPdf, generateAnnualStatementPdf } from '@/lib/pdf/receipt-generator';
import type { HistoryRow } from '@/lib/pdf/receipt-generator';
import { PRICING_TIERS, type CountryCode, type SubscriptionTier } from '@/lib/constants';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    // Verify internal token
    const token = request.headers.get('x-internal-token');
    if (!token || token !== process.env.INTERNAL_API_TOKEN) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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

  // Use whichever is newest
  type TransactionSource = 'booking' | 'charge';
  let source: TransactionSource | null = null;
  if (recentBooking && recentCharge) {
    source = new Date(recentBooking.created_at) >= new Date(recentCharge.created_at) ? 'booking' : 'charge';
  } else if (recentBooking) {
    source = 'booking';
  } else if (recentCharge) {
    source = 'charge';
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
  } else if (recentCharge) {
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
    .select('reference_code, date, status, total_amount, created_at, services(name), businesses(name, country_code)')
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

  // Merge and sort by date
  const rows: HistoryRow[] = [];
  let countryCode: CountryCode = 'NG';

  if (bookings) {
    for (const b of bookings) {
      const biz = b.businesses as unknown as { name: string; country_code?: string } | null;
      const svc = b.services as unknown as { name: string } | null;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
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
    .select('reference_code, date, status, total_amount, created_at, services(name), businesses(name, country_code)')
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

  const rows: HistoryRow[] = [];
  let countryCode: CountryCode = 'NG';
  let businessName: string | undefined;

  if (bookings) {
    for (const b of bookings) {
      const biz = b.businesses as unknown as { name: string; country_code?: string } | null;
      const svc = b.services as unknown as { name: string } | null;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      if (biz?.name && !businessName) businessName = biz.name;
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

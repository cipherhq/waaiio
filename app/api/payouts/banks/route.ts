import { NextRequest, NextResponse } from 'next/server';

const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY || '';
const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY || '';

// In-memory cache: gateway+country → { banks, fetchedAt }
const bankCache = new Map<string, { banks: { code: string; name: string }[]; fetchedAt: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const gateway = searchParams.get('gateway') || 'paystack';
  const country = (searchParams.get('country') || 'NG').toUpperCase();

  const cacheKey = `${gateway}:${country}`;
  const cached = bankCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return NextResponse.json({ banks: cached.banks });
  }

  try {
    let banks: { code: string; name: string }[] = [];

    if (gateway === 'paystack') {
      if (!paystackSecretKey) {
        return NextResponse.json({ banks: [{ code: '058', name: 'GTBank (Mock)' }, { code: '033', name: 'UBA (Mock)' }] });
      }
      const countryParam = country === 'NG' ? 'nigeria' : country === 'GH' ? 'ghana' : country.toLowerCase();
      const res = await fetch(`https://api.paystack.co/bank?country=${countryParam}`, {
        headers: { Authorization: `Bearer ${paystackSecretKey}` },
      });
      const data = await res.json();
      if (data.status && Array.isArray(data.data)) {
        banks = data.data.map((b: { code: string; name: string }) => ({ code: b.code, name: b.name }));
      }
    } else if (gateway === 'flutterwave') {
      if (!flutterwaveSecretKey) {
        return NextResponse.json({ banks: [{ code: '058', name: 'GTBank (Mock)' }, { code: '033', name: 'UBA (Mock)' }] });
      }
      const res = await fetch(`https://api.flutterwave.com/v3/banks/${country}`, {
        headers: { Authorization: `Bearer ${flutterwaveSecretKey}` },
      });
      const data = await res.json();
      if (data.status === 'success' && Array.isArray(data.data)) {
        banks = data.data.map((b: { code: string; name: string }) => ({ code: b.code, name: b.name }));
      }
    } else {
      return NextResponse.json({ banks: [] });
    }

    bankCache.set(cacheKey, { banks, fetchedAt: Date.now() });
    return NextResponse.json({ banks });
  } catch (error) {
    console.error('List banks error:', (error as Error).message);
    return NextResponse.json({ error: 'Failed to fetch banks' }, { status: 500 });
  }
}

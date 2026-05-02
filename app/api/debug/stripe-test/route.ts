import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { initializePayment } from '@/lib/bot/flows/shared/payment';

export async function GET() {
  const result: Record<string, unknown> = {
    stripeKey: process.env.STRIPE_SECRET_KEY ? process.env.STRIPE_SECRET_KEY.slice(0, 12) + '...' : 'MISSING',
  };

  try {
    const supabase = createServiceClient();

    // Simulate exact payment flow for Citadel
    const paymentResult = await initializePayment(supabase, {
      bookingId: undefined,
      userId: '00000000-0000-0000-0000-000000000001',
      amount: 100,
      referenceCode: 'DEBUG-TEST-' + Date.now(),
      businessName: 'Debug Test',
      phone: '+1234567890',
      countryCode: 'US',
      businessId: 'adea3e0c-47b0-4976-b961-2709b512ab04', // Citadel
    });

    if (paymentResult) {
      result.status = 'SUCCESS';
      result.url = paymentResult.url.slice(0, 80) + '...';
      result.reference = paymentResult.reference;
    } else {
      result.status = 'FAILED - initializePayment returned null';
    }
  } catch (err) {
    result.status = 'ERROR';
    result.error = (err as Error).message;
    result.stack = (err as Error).stack?.split('\n').slice(0, 5);
  }

  return NextResponse.json(result);
}

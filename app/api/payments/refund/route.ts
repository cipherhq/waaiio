import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { createClient } from '@/lib/supabase/server';
import { processRefund } from '@/lib/payments/refund-handler';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { paymentId, businessId, amount, reason, idempotencyKey } = body as {
      paymentId: string;
      businessId: string;
      amount: number;
      reason?: string;
      idempotencyKey?: string;
    };

    if (!paymentId || !businessId || !amount || typeof amount !== 'number' || amount <= 0) {
      return NextResponse.json({ error: 'Missing or invalid fields: paymentId, businessId, amount (must be positive number)' }, { status: 400 });
    }

    // Stable refund-request ID: client-supplied for retry recovery, or generated once per request.
    // The client SHOULD persist this and resend on retry to ensure idempotency.
    const logicalRefundId = idempotencyKey || `biz-refund-${paymentId}-${randomUUID()}`;

    // Verify the user owns the business
    const { data: business } = await supabase
      .from('businesses')
      .select('id')
      .eq('id', businessId)
      .eq('owner_id', user.id)
      .single();

    if (!business) {
      return NextResponse.json({ error: 'Business not found or not authorized' }, { status: 403 });
    }

    // Verify the payment belongs to this business
    const { data: payment } = await supabase
      .from('payments')
      .select('id, business_id')
      .eq('id', paymentId)
      .eq('business_id', businessId)
      .single();

    if (!payment) {
      return NextResponse.json({ error: 'Payment not found for this business' }, { status: 404 });
    }

    const result = await processRefund({
      supabase,
      paymentId,
      businessId,
      amount,
      reason,
      initiatedBy: user.id,
      initiatedByRole: 'business',
      logicalRefundId,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.errorMessage }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      refundId: result.refundId,
      isDirectSplit: result.isDirectSplit,
      idempotencyKey: logicalRefundId,
    });
  } catch (error) {
    logger.error('Refund API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

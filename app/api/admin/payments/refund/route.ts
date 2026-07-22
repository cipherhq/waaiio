import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { processRefund } from '@/lib/payments/refund-handler';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile || profile.role !== 'admin') {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const body = await request.json();
    const { paymentId, businessId, amount, reason, idempotencyKey } = body as {
      paymentId: string;
      businessId: string;
      amount: number;
      reason?: string;
      idempotencyKey?: string;
    };

    if (!paymentId || !businessId || !amount) {
      return NextResponse.json({ error: 'paymentId, businessId, and amount are required' }, { status: 400 });
    }

    if (!idempotencyKey) {
      return NextResponse.json({ error: 'idempotencyKey is required for refund requests' }, { status: 400 });
    }

    const logicalRefundId = idempotencyKey;

    const serviceClient = createServiceClient();

    const result = await processRefund({
      supabase: serviceClient,
      paymentId,
      businessId,
      amount,
      reason: reason || '',
      initiatedBy: user.id,
      initiatedByRole: 'admin',
      logicalRefundId,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.errorMessage || 'Refund failed', idempotencyKey: logicalRefundId }, { status: 400 });
    }

    try {
      await serviceClient.from('admin_audit_logs').insert({
        actor_id: user.id,
        action: 'refund_approved',
        entity_type: 'payment',
        entity_id: paymentId,
        details: {
          business_id: businessId,
          amount,
          reason: reason || null,
          refund_id: result.refundId,
          is_direct_split: result.isDirectSplit,
        },
      });
    } catch {
      logger.error('[ADMIN-REFUND] Audit log failed');
    }

    return NextResponse.json({
      success: true,
      refundId: result.refundId,
      isDirectSplit: result.isDirectSplit,
      idempotencyKey: logicalRefundId,
    });
  } catch (error) {
    logger.error('[ADMIN-REFUND] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

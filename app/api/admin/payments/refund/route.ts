import { NextRequest, NextResponse } from 'next/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { processRefund } from '@/lib/payments/refund-handler';
import { createServiceClient } from '@/lib/supabase/service';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { consumeStepUp, StepUpError } from '@/lib/admin-step-up';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
    if (!admin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    // Create a Supabase client with the admin's auth context for RLS-aware operations
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    const supabase = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { autoRefreshToken: false, persistSession: false },
      },
    );

    const body = await request.json();
    const { paymentId, businessId, amount, reason, stepUpId } = body as {
      paymentId: string;
      businessId: string;
      amount: number;
      reason?: string;
      stepUpId?: string;
    };

    if (!paymentId || !businessId || !amount) {
      return NextResponse.json({ error: 'Missing required fields: paymentId, businessId, amount' }, { status: 400 });
    }

    // SEC-005 Layer 4: Consume operation-bound step-up authorization
    try {
      await consumeStepUp(admin, stepUpId!, 'refund', paymentId, { businessId, amount });
    } catch (err) {
      const msg = err instanceof StepUpError ? err.message : 'Step-up authorization required';
      return NextResponse.json({ error: msg, code: 'step_up_required' }, { status: 403 });
    }

    const result = await processRefund({
      supabase,
      paymentId,
      businessId,
      amount,
      reason,
      initiatedBy: admin.id,
      initiatedByRole: 'admin',
    });

    if (!result.success) {
      return NextResponse.json({ error: result.errorMessage }, { status: 400 });
    }

    // Audit log for refund approval
    const serviceClient = createServiceClient();
    await serviceClient.from('admin_audit_logs').insert({
      actor_id: admin.id,
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

    return NextResponse.json({
      success: true,
      refundId: result.refundId,
      isDirectSplit: result.isDirectSplit,
    });
  } catch (error) {
    logger.error('Admin refund API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

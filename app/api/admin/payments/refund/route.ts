import { NextRequest, NextResponse } from 'next/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { processRefund } from '@/lib/payments/refund-handler';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    // Admin app sends auth token via Authorization header (cross-origin from port 8083)
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');

    if (!token) {
      return NextResponse.json({ error: 'Missing authorization token' }, { status: 401 });
    }

    const supabase = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { autoRefreshToken: false, persistSession: false },
      },
    );

    const { data: { user } } = await supabase.auth.getUser(token);

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Verify user is admin
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile || profile.role !== 'admin') {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const body = await request.json();
    const { paymentId, businessId, amount, reason } = body as {
      paymentId: string;
      businessId: string;
      amount: number;
      reason?: string;
    };

    if (!paymentId || !businessId || !amount) {
      return NextResponse.json({ error: 'Missing required fields: paymentId, businessId, amount' }, { status: 400 });
    }

    const result = await processRefund({
      supabase,
      paymentId,
      businessId,
      amount,
      reason,
      initiatedBy: user.id,
      initiatedByRole: 'admin',
    });

    if (!result.success) {
      return NextResponse.json({ error: result.errorMessage }, { status: 400 });
    }

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

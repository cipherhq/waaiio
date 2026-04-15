import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { payment_method, note } = body;

    const { data: invoice } = await supabase
      .from('invoices')
      .select('id, status, total_amount')
      .eq('id', id)
      .single();

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }

    if (invoice.status === 'paid') {
      return NextResponse.json({ error: 'Invoice already paid' }, { status: 400 });
    }

    if (invoice.status === 'cancelled') {
      return NextResponse.json({ error: 'Invoice is cancelled' }, { status: 400 });
    }

    const { error } = await supabase
      .from('invoices')
      .update({
        status: 'paid',
        amount_paid: invoice.total_amount,
        paid_at: new Date().toISOString(),
        manual_payment_method: payment_method || 'cash',
        manual_payment_note: note || null,
        marked_paid_by: user.id,
      })
      .eq('id', id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

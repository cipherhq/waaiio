import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data, error } = await supabase
      .from('invoices')
      .select('*, invoice_items(*)')
      .eq('id', id)
      .single();

    if (error || !data) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }

    // Verify user owns the business that owns this invoice
    const { data: biz } = await supabase
      .from('businesses')
      .select('id')
      .eq('id', data.business_id)
      .eq('owner_id', user.id)
      .maybeSingle();

    if (!biz) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }

    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Check current status + ownership
    const { data: existing } = await supabase
      .from('invoices')
      .select('id, status, business_id')
      .eq('id', id)
      .single();

    if (!existing) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }

    const { data: ownedBiz } = await supabase
      .from('businesses')
      .select('id')
      .eq('id', existing.business_id)
      .eq('owner_id', user.id)
      .maybeSingle();

    if (!ownedBiz) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }
    if (existing.status !== 'draft') {
      return NextResponse.json({ error: 'Only draft invoices can be edited' }, { status: 400 });
    }

    const body = await request.json();
    const { data, error } = await supabase.rpc('save_invoice_tax_980', {
      p_business_id: existing.business_id, p_invoice_id: id, p_body: body,
    });
    if (error || !data) {
      return NextResponse.json({ error: 'Unable to save invoice. Check line prices, tax settings and discounts.' }, { status: 400 });
    }
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Verify ownership before cancelling
    const { data: invoice } = await supabase
      .from('invoices')
      .select('id, business_id')
      .eq('id', id)
      .single();

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }

    const { data: ownedBiz } = await supabase
      .from('businesses')
      .select('id')
      .eq('id', invoice.business_id)
      .eq('owner_id', user.id)
      .maybeSingle();

    if (!ownedBiz) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }

    const { error } = await supabase
      .from('invoices')
      .update({ status: 'cancelled' })
      .eq('id', id);

    if (error) {
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

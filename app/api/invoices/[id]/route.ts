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

    // Check current status
    const { data: existing } = await supabase
      .from('invoices')
      .select('id, status')
      .eq('id', id)
      .single();

    if (!existing) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }
    if (existing.status !== 'draft') {
      return NextResponse.json({ error: 'Only draft invoices can be edited' }, { status: 400 });
    }

    const body = await request.json();
    const {
      customer_name, customer_phone, customer_email, customer_address,
      customer_profile_id, items, tax_rate, discount_type, discount_value,
      due_date, notes, terms, currency, issue_date,
    } = body;

    // Recompute financials if items provided
    let updateData: Record<string, unknown> = {};

    if (items?.length) {
      const subtotal = items.reduce((sum: number, item: { quantity: number; unit_price: number }) =>
        sum + (item.quantity || 1) * (item.unit_price || 0), 0);

      const taxRate = tax_rate ?? 0;
      const taxAmount = Math.round(subtotal * taxRate / 100 * 100) / 100;

      let discountAmount = 0;
      if (discount_type === 'percent' && discount_value) {
        discountAmount = Math.round(subtotal * discount_value / 100 * 100) / 100;
      } else if (discount_type === 'flat' && discount_value) {
        discountAmount = discount_value;
      }

      const totalAmount = Math.round((subtotal + taxAmount - discountAmount) * 100) / 100;

      updateData = {
        subtotal, tax_rate: taxRate, tax_amount: taxAmount,
        discount_type: discount_type || null, discount_value: discount_value || 0,
        discount_amount: discountAmount, total_amount: totalAmount,
      };

      // Replace line items
      await supabase.from('invoice_items').delete().eq('invoice_id', id);
      const itemRows = items.map((item: { description: string; quantity: number; unit_price: number }, i: number) => ({
        invoice_id: id,
        description: item.description,
        quantity: item.quantity || 1,
        unit_price: item.unit_price || 0,
        amount: Math.round((item.quantity || 1) * (item.unit_price || 0) * 100) / 100,
        sort_order: i,
      }));
      await supabase.from('invoice_items').insert(itemRows);
    }

    if (customer_name !== undefined) updateData.customer_name = customer_name;
    if (customer_phone !== undefined) updateData.customer_phone = customer_phone || null;
    if (customer_email !== undefined) updateData.customer_email = customer_email || null;
    if (customer_address !== undefined) updateData.customer_address = customer_address || null;
    if (customer_profile_id !== undefined) updateData.customer_profile_id = customer_profile_id || null;
    if (due_date !== undefined) updateData.due_date = due_date || null;
    if (notes !== undefined) updateData.notes = notes || null;
    if (terms !== undefined) updateData.terms = terms || null;
    if (currency !== undefined) updateData.currency = currency;
    if (issue_date !== undefined) updateData.issue_date = issue_date;

    const { data, error } = await supabase
      .from('invoices')
      .update(updateData)
      .eq('id', id)
      .select('*, invoice_items(*)')
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
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

    const { error } = await supabase
      .from('invoices')
      .update({ status: 'cancelled' })
      .eq('id', id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

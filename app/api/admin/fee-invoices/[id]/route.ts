import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Only admin can manage fee invoices
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle();
  if (!profile || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const { action, payment_reference, reason } = await request.json();
  const service = createServiceClient();

  // Fetch current invoice
  const { data: invoice } = await service.from('platform_fee_invoices').select('*').eq('id', id).single();
  if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

  if (action === 'mark_paid') {
    if (!['pending', 'overdue'].includes(invoice.status)) {
      return NextResponse.json({ error: 'Invoice cannot be marked paid in current status' }, { status: 400 });
    }
    // Compare-and-set
    const { data: updated } = await service.from('platform_fee_invoices')
      .update({ status: 'paid', paid_at: new Date().toISOString(), paid_via: 'manual', payment_reference: payment_reference || null })
      .eq('id', id).in('status', ['pending', 'overdue']).select('id').maybeSingle();
    if (!updated) return NextResponse.json({ error: 'Already processed' }, { status: 409 });

    // Mandatory audit
    const { error: auditErr } = await service.from('admin_audit_logs').insert({
      actor_id: user.id, action: 'fee_invoice_marked_paid', entity_type: 'fee_invoice', entity_id: id,
      details: { invoice_number: invoice.invoice_number, amount: invoice.total_fee_amount, payment_reference },
    });
    if (auditErr) {
      // Revert
      await service.from('platform_fee_invoices').update({ status: invoice.status, paid_at: null, paid_via: null, payment_reference: null }).eq('id', id);
      return NextResponse.json({ error: 'Audit logging failed' }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  }

  if (action === 'waive') {
    if (!reason) return NextResponse.json({ error: 'Reason required for waive' }, { status: 400 });
    if (!['pending', 'overdue'].includes(invoice.status)) {
      return NextResponse.json({ error: 'Invoice cannot be waived in current status' }, { status: 400 });
    }
    const { data: updated } = await service.from('platform_fee_invoices')
      .update({ status: 'waived', waived_reason: reason, waived_by: user.id })
      .eq('id', id).in('status', ['pending', 'overdue']).select('id').maybeSingle();
    if (!updated) return NextResponse.json({ error: 'Already processed' }, { status: 409 });

    const { error: auditErr } = await service.from('admin_audit_logs').insert({
      actor_id: user.id, action: 'fee_invoice_waived', entity_type: 'fee_invoice', entity_id: id,
      details: { invoice_number: invoice.invoice_number, amount: invoice.total_fee_amount, reason },
    });
    if (auditErr) {
      await service.from('platform_fee_invoices').update({ status: invoice.status, waived_reason: null, waived_by: null }).eq('id', id);
      return NextResponse.json({ error: 'Audit logging failed' }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}

import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { generateInvoicePdf } from '@/lib/pdf/invoice-pdf-generator';
import { PRICING_TIERS, type SubscriptionTier } from '@/lib/constants';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const tokenParam = searchParams.get('token');

    let supabase;

    if (tokenParam) {
      // Public access via token
      supabase = createServiceClient();

      const { data: invoice } = await supabase
        .from('invoices')
        .select('id, token')
        .eq('id', id)
        .eq('token', tokenParam)
        .single();

      if (!invoice) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
    } else {
      // Auth required
      supabase = await createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Fetch invoice with items
    const { data: invoice } = await supabase
      .from('invoices')
      .select('*, invoice_items(*)')
      .eq('id', id)
      .single();

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }

    // Fetch business name + tier
    const { data: biz } = await supabase
      .from('businesses')
      .select('name, country_code, subscription_tier')
      .eq('id', invoice.business_id)
      .single();

    const items = (invoice.invoice_items || []).sort(
      (a: { sort_order: number }, b: { sort_order: number }) => a.sort_order - b.sort_order
    );

    const buffer = await generateInvoicePdf({
      businessName: biz?.name || 'Business',
      referenceCode: invoice.reference_code,
      issueDate: invoice.issue_date,
      dueDate: invoice.due_date,
      customerName: invoice.customer_name,
      customerPhone: invoice.customer_phone,
      customerEmail: invoice.customer_email,
      customerAddress: invoice.customer_address,
      items: items.map((item: { description: string; quantity: number; unit_price: number; amount: number }) => ({
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unit_price,
        amount: item.amount,
      })),
      subtotal: invoice.subtotal,
      taxRate: invoice.tax_rate,
      taxAmount: invoice.tax_amount,
      discountType: invoice.discount_type,
      discountValue: invoice.discount_value,
      discountAmount: invoice.discount_amount,
      totalAmount: invoice.total_amount,
      amountPaid: invoice.amount_paid,
      currency: invoice.currency,
      notes: invoice.notes,
      terms: invoice.terms,
      status: invoice.status,
      countryCode: (biz?.country_code || 'NG') as 'NG' | 'US' | 'GB' | 'GH' | 'KE' | 'ZA',
      whitelabel: PRICING_TIERS[(biz?.subscription_tier || 'free') as SubscriptionTier]?.whitelabel === true,
    });

    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="invoice-${invoice.reference_code}.pdf"`,
      },
    });
  } catch (err) {
    console.error('invoices/pdf error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

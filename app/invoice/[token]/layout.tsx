import type { Metadata } from 'next';
import { createServiceClient } from '@/lib/supabase/service';

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const supabase = createServiceClient();

  const { data: invoice } = await supabase
    .from('invoices')
    .select('reference_code, business_id, businesses:business_id(name)')
    .eq('token', token)
    .maybeSingle();

  if (invoice) {
    const biz = invoice.businesses as unknown as { name: string } | null;
    const businessName = biz?.name || 'a business';
    const refCode = invoice.reference_code || '';

    return {
      title: `Invoice from ${businessName}`,
      description: `View and pay invoice ${refCode}`.trim() + '.',
      openGraph: {
        title: `Invoice from ${businessName}`,
        description: `View and pay invoice ${refCode}`.trim() + '.',
      },
    };
  }

  return {
    title: 'Invoice | Waaiio',
    description: 'View and pay an invoice on Waaiio.',
  };
}

export default function InvoiceLayout({ children }: { children: React.ReactNode }) {
  return children;
}

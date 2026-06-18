import type { Metadata } from 'next';
import { createServiceClient } from '@/lib/supabase/service';

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const supabase = createServiceClient();

  const { data: contract } = await supabase
    .from('contracts')
    .select('title, business_id, businesses(name)')
    .eq('token', token)
    .maybeSingle();

  if (contract) {
    const biz = contract.businesses as unknown as { name: string } | null;
    const businessName = biz?.name || 'a business';
    const title = contract.title || 'Document';

    return {
      title: `Sign: ${title}`,
      description: `Review and sign this document from ${businessName}.`,
      openGraph: {
        title: `Sign: ${title}`,
        description: `Review and sign this document from ${businessName}.`,
      },
    };
  }

  return {
    title: 'Sign Document | Waaiio',
    description: 'Review and sign a document on Waaiio.',
  };
}

export default function SignLayout({ children }: { children: React.ReactNode }) {
  return children;
}

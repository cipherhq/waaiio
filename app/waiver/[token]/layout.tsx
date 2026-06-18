import type { Metadata } from 'next';
import { createServiceClient } from '@/lib/supabase/service';

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const supabase = createServiceClient();

  const { data: waiver } = await supabase
    .from('waiver_templates')
    .select('title, description, business_id, businesses(name)')
    .eq('share_token', token)
    .eq('is_active', true)
    .maybeSingle();

  if (waiver) {
    const biz = waiver.businesses as unknown as { name: string } | null;
    const bizName = biz?.name || 'Waaiio';

    return {
      title: `${waiver.title} — ${bizName}`,
      description: waiver.description || `Sign this waiver from ${bizName}`,
      openGraph: {
        title: waiver.title,
        description: `Waiver from ${bizName}. Review and sign digitally.`,
      },
    };
  }

  return {
    title: 'Sign Waiver | Waaiio',
    description: 'Review and sign this digital waiver.',
  };
}

export default function WaiverLayout({ children }: { children: React.ReactNode }) {
  return children;
}

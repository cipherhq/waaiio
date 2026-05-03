'use client';

import { useEffect } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { useRouter } from 'next/navigation';

/**
 * Redirects to the get-started page's WhatsApp connection step.
 * The Embedded Signup flow on get-started is proven to work —
 * reusing it avoids Facebook redirect_uri mismatch issues.
 */
export default function ConnectWhatsAppPage() {
  const business = useBusiness();
  const router = useRouter();

  useEffect(() => {
    router.replace(`/get-started?step=whatsapp&business_id=${business.id}`);
  }, [business.id, router]);

  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
    </div>
  );
}

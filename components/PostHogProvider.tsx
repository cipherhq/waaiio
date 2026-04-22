'use client';

import { useEffect } from 'react';
import { getPostHogClient } from '@/lib/posthog/client';
import { createClient } from '@/lib/supabase/client';

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const ph = getPostHogClient();
    if (!ph) return;

    // Identify user if logged in
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) {
        ph.identify(user.id, { email: user.email });
      }
    });
  }, []);

  return <>{children}</>;
}

'use client';

import { useEffect } from 'react';
import { getCookieConsent } from '@/components/marketing/CookieConsent';
import { createClient } from '@/lib/supabase/client';

let posthogInitialized = false;

/**
 * PostHog provider that respects cookie consent.
 * Only initializes PostHog if analytics consent has been given.
 * Listens for consent changes to start/stop tracking dynamically.
 */
export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    function initIfConsented() {
      const consent = getCookieConsent();
      if (!consent?.analytics) {
        // If PostHog was initialized but consent was revoked, opt out
        if (posthogInitialized) {
          import('posthog-js').then(({ default: ph }) => {
            ph.opt_out_capturing();
          });
        }
        return;
      }

      // Analytics consent given — initialize or opt back in
      if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;

      import('posthog-js').then(({ default: posthog }) => {
        if (!posthogInitialized) {
          posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
            api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
            capture_pageview: true,
            capture_pageleave: true,
            opt_out_capturing_by_default: true,
            loaded: (ph) => {
              if (process.env.NODE_ENV === 'development') ph.debug();
            },
          });
          posthogInitialized = true;
        }

        posthog.opt_in_capturing();

        // Identify user if logged in
        const supabase = createClient();
        supabase.auth.getUser().then(({ data: { user } }) => {
          if (user) {
            posthog.identify(user.id, { email: user.email });
          }
        });
      });
    }

    // Check on mount
    initIfConsented();

    // Listen for consent changes (from CookieConsent component)
    function handleConsentChange() {
      initIfConsented();
    }
    window.addEventListener('waaiio:consent', handleConsentChange);
    return () => window.removeEventListener('waaiio:consent', handleConsentChange);
  }, []);

  return <>{children}</>;
}

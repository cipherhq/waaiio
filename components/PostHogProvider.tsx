'use client';

import { useEffect } from 'react';
import { getCookieConsent } from '@/components/marketing/CookieConsent';
import { createClient } from '@/lib/supabase/client';

let posthogInitialized = false;

/**
 * Pages whose URL holds a private, single-use token and whose content may be
 * health or other sensitive answers (#963 client intake). Analytics never
 * starts there, and any event from such a page is dropped, so neither the
 * token nor what the client taps reaches PostHog.
 */
export function isPrivateLinkPath(pathname: string): boolean {
  return pathname === '/intake' || pathname.startsWith('/intake/');
}

/** posthog-js before_send hook: drop events from (or naming) a private link page. */
export function dropPrivateLinkEvents<T extends { properties?: Record<string, unknown> } | null>(event: T): T | null {
  if (!event) return event;
  if (typeof window !== 'undefined' && isPrivateLinkPath(window.location.pathname)) return null;
  const props = event.properties || {};
  for (const key of ['$current_url', '$pathname', '$referrer', '$initial_current_url', '$prev_pageview_pathname']) {
    const value = props[key];
    if (typeof value === 'string' && /\/intake(\/|$|\?)/.test(value)) return null;
  }
  return event;
}

/**
 * PostHog provider that respects cookie consent.
 * Only initializes PostHog if analytics consent has been given.
 * Listens for consent changes to start/stop tracking dynamically.
 */
export function PostHogProvider({ children }: { children: React.ReactNode }) {
  // Install test_run_id fetch interceptor once (independent of PostHog consent/key).
  // The interceptor is idempotent internally and reads sessionStorage on each request,
  // so setting/clearing waaiio_test_run_id after load works without a reload.
  useEffect(() => {
    import('@/lib/observability/product-events').then(({ installTestRunFetchInterceptor }) => {
      installTestRunFetchInterceptor();
    }).catch(() => { /* non-critical */ });
  }, []);

  useEffect(() => {
    function initIfConsented() {
      if (isPrivateLinkPath(window.location.pathname)) {
        // Never track a private intake link, even with analytics consent.
        if (posthogInitialized) {
          import('posthog-js').then(({ default: ph }) => { ph.opt_out_capturing(); });
        }
        return;
      }
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
            before_send: dropPrivateLinkEvents,
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
            posthog.identify(user.id);
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

import posthog from 'posthog-js';

/**
 * Returns the PostHog client instance.
 * PostHog initialization is now handled by PostHogProvider which
 * respects cookie consent. This function returns the instance
 * for direct capture calls — it will no-op if not initialized.
 */
export function getPostHogClient() {
  if (typeof window === 'undefined') return null;

  // PostHog may not be initialized if user hasn't consented to analytics
  // In that case, posthog methods will no-op via opt_out_capturing
  return posthog;
}

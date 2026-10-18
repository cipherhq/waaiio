import * as Sentry from '@sentry/nextjs';

/**
 * Next.js instrumentation hook — loads Sentry for server and edge runtimes.
 *
 * @sentry/nextjs v10 requires this file to initialize server-side and edge
 * Sentry SDKs. In Next.js 15 the instrumentation hook is built-in (no
 * experimental flag needed).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

/**
 * Next.js 15 request-error hook — captures errors from nested React Server
 * Components that the global error boundary cannot reach.
 */
export const onRequestError = Sentry.captureRequestError;

/**
 * Next.js instrumentation hook — loads Sentry for server and edge runtimes.
 *
 * @sentry/nextjs v10 requires this file to initialize server-side and edge
 * Sentry SDKs in Next.js 14. Without it, sentry.server.config.ts and
 * sentry.edge.config.ts are never loaded, and only client-side errors are
 * captured.
 *
 * Requires experimental.instrumentationHook: true in next.config.mjs for
 * Next.js 14.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

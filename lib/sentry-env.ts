/**
 * Shared Sentry environment resolution for all runtimes (client, server, edge).
 *
 * Priority: WAAIIO_ENVIRONMENT (or NEXT_PUBLIC_ variant for client) > VERCEL_ENV > 'development'.
 * Never uses NODE_ENV — it is always 'production' on Vercel regardless of the deployment target.
 *
 * Sentry is enabled only when the DSN is set and the environment is 'production' or 'staging'.
 */

export function getSentryEnvironment(vars: {
  waaiioEnv?: string;
  vercelEnv?: string;
}): string {
  return vars.waaiioEnv || vars.vercelEnv || 'development';
}

export function isSentryEnabled(dsn: string | undefined, environment: string): boolean {
  if (!dsn) return false;
  return environment === 'production' || environment === 'staging';
}

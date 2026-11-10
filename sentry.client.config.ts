import * as Sentry from '@sentry/nextjs';
import { getSentryEnvironment, isSentryEnabled } from './lib/sentry-env';
import { privateLinkScrubbers } from './lib/sentry-redact';

const environment = getSentryEnvironment({
  waaiioEnv: process.env.NEXT_PUBLIC_WAAIIO_ENVIRONMENT,
  vercelEnv: process.env.NEXT_PUBLIC_VERCEL_ENV,
});

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0.1,
  environment,
  // Sentry 11 collects more by default. Keep the v10 default (sendDefaultPii off):
  // https://github.com/getsentry/sentry-javascript/blob/develop/MIGRATION.md ("keep the v10 default behavior").
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: {
      request: { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] },
      response: { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] },
    },
    httpBodies: [],
    urlQueryParams: { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] },
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    queues: false,
    graphQL: { document: false, variables: false },
  },
  // Private intake link tokens never leave in URLs (#963).
  ...privateLinkScrubbers,
  enabled: isSentryEnabled(process.env.NEXT_PUBLIC_SENTRY_DSN, environment),
});

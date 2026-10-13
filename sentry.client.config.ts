import * as Sentry from '@sentry/nextjs';
import { getSentryEnvironment, isSentryEnabled } from './lib/sentry-env';

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
  enabled: isSentryEnabled(process.env.NEXT_PUBLIC_SENTRY_DSN, environment),
});

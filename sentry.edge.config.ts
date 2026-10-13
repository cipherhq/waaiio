import * as Sentry from '@sentry/nextjs';
import { getSentryEnvironment, isSentryEnabled } from './lib/sentry-env';

const environment = getSentryEnvironment({
  waaiioEnv: process.env.WAAIIO_ENVIRONMENT,
  vercelEnv: process.env.VERCEL_ENV,
});

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  environment,
  enabled: isSentryEnabled(process.env.SENTRY_DSN, environment),
});

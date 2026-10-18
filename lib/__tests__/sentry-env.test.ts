import { describe, it, expect } from 'vitest';
import { getSentryEnvironment, isSentryEnabled } from '@/lib/sentry-env';

describe('getSentryEnvironment', () => {
  it('prefers WAAIIO_ENVIRONMENT over VERCEL_ENV', () => {
    expect(getSentryEnvironment({ waaiioEnv: 'staging', vercelEnv: 'production' })).toBe('staging');
  });

  it('falls back to VERCEL_ENV when WAAIIO_ENVIRONMENT is not set', () => {
    expect(getSentryEnvironment({ waaiioEnv: undefined, vercelEnv: 'preview' })).toBe('preview');
  });

  it('falls back to development when neither is set', () => {
    expect(getSentryEnvironment({ waaiioEnv: undefined, vercelEnv: undefined })).toBe('development');
  });

  it('falls back to development for empty strings', () => {
    expect(getSentryEnvironment({ waaiioEnv: '', vercelEnv: '' })).toBe('development');
  });
});

describe('isSentryEnabled', () => {
  it('returns true for production with a DSN', () => {
    expect(isSentryEnabled('https://key@sentry.io/123', 'production')).toBe(true);
  });

  it('returns true for staging with a DSN', () => {
    expect(isSentryEnabled('https://key@sentry.io/123', 'staging')).toBe(true);
  });

  it('returns false for development even with a DSN', () => {
    expect(isSentryEnabled('https://key@sentry.io/123', 'development')).toBe(false);
  });

  it('returns false for preview even with a DSN', () => {
    expect(isSentryEnabled('https://key@sentry.io/123', 'preview')).toBe(false);
  });

  it('returns false when DSN is undefined', () => {
    expect(isSentryEnabled(undefined, 'production')).toBe(false);
  });

  it('returns false when DSN is empty string', () => {
    expect(isSentryEnabled('', 'production')).toBe(false);
  });
});

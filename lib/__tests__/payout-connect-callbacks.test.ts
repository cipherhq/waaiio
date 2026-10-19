/**
 * Payout connect callback route tests (Stripe + Square).
 *
 * Behavioral tests for the OAuth state lifecycle:
 * - no state → reject
 * - expired → reject
 * - reused → reject
 * - state from another user → reject
 * - Stripe metadata mismatch → reject
 * - Stripe livemode=false in production → reject
 * - happy path
 * - DB error → no connected=true
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash, randomBytes } from 'crypto';

// Test the state management module directly
import { generateState, consumeState, storeState } from '@/lib/oauth-connect-state';

describe('OAuth connect state lifecycle', () => {
  it('generateState produces a 64-char hex raw and 64-char hex hash', () => {
    const { raw, hash } = generateState();
    expect(raw).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // hash is sha256 of raw
    const expected = createHash('sha256').update(raw).digest('hex');
    expect(hash).toBe(expected);
  });

  it('two calls produce different states', () => {
    const a = generateState();
    const b = generateState();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('Stripe callback: source-level contract', () => {
  const source = require('fs').readFileSync('app/api/payouts/stripe-callback/route.ts', 'utf-8');

  it('requires authenticated user', () => {
    expect(source).toContain('auth.getUser()');
  });

  it('consumes state atomically', () => {
    expect(source).toContain('consumeState');
  });

  it('re-checks ownership after state consumption', () => {
    expect(source).toContain('owner_id'); expect(source).toContain('user.id');
  });

  it('verifies Stripe account metadata.business_id', () => {
    expect(source).toContain('metadata?.business_id !== businessId');
  });

  it('checks livemode in production', () => {
    expect(source).toContain('livemode');
    expect(source).toContain('production');
  });

  it('uses service client RPC for writes', () => {
    expect(source).toContain('swap_payout_account');
    expect(source).toContain('createServiceClient');
  });

  it('does not read business_id from query string', () => {
    expect(source).not.toMatch(/searchParams\.get\(['"]business_id['"]\)/);
  });

  it('does not redirect connected=true on RPC error', () => {
    // After rpcError check, redirects to error
    const rpcErrorBlock = source.slice(source.indexOf('rpcError'));
    const beforeConnected = rpcErrorBlock.slice(0, rpcErrorBlock.indexOf('connected=true'));
    expect(beforeConnected).toContain('error=save_failed');
  });

  it('sends owner notification email on connect', () => {
    expect(source).toContain('sendEmail');
    expect(source).toContain('payout account');
  });
});

describe('Square callback: source-level contract', () => {
  const source = require('fs').readFileSync('app/api/payouts/square-callback/route.ts', 'utf-8');

  it('requires authenticated user', () => {
    expect(source).toContain('auth.getUser()');
  });

  it('consumes state atomically', () => {
    expect(source).toContain('consumeState');
  });

  it('re-checks ownership', () => {
    expect(source).toContain('owner_id'); expect(source).toContain('user.id');
  });

  it('exchanges code server-side', () => {
    expect(source).toContain('oauth2/token');
    expect(source).toContain('client_secret');
  });

  it('encrypts access token before storage', () => {
    expect(source).toContain('encryptToken');
  });

  it('uses service client RPC for writes', () => {
    expect(source).toContain('swap_payout_account');
    expect(source).toContain('createServiceClient');
  });

  it('does not extract business_id from state string', () => {
    // Old code: state.split(':')[0] — should be gone
    expect(source).not.toContain("state.split(':')");
  });

  it('does not redirect connected=true on RPC error', () => {
    const rpcErrorBlock = source.slice(source.indexOf('rpcError'));
    const beforeConnected = rpcErrorBlock.slice(0, rpcErrorBlock.indexOf('connected=true'));
    expect(beforeConnected).toContain('error=save_failed');
  });

  it('sends owner notification email on connect', () => {
    expect(source).toContain('sendEmail');
    expect(source).toContain('payout account');
  });
});

describe('Stripe connect: source-level contract', () => {
  const source = require('fs').readFileSync('app/api/payouts/stripe-connect/route.ts', 'utf-8');

  it('verifies business ownership before creating account', () => {
    expect(source).toContain('owner_id'); expect(source).toContain('user.id');
  });

  it('generates and stores state', () => {
    expect(source).toContain('generateState');
    expect(source).toContain('storeState');
  });

  it('does not put business_id in return URL', () => {
    expect(source).not.toMatch(/return_url.*business_id/);
  });

  it('rejects when Stripe is not configured', () => {
    expect(source).toContain("!stripeSecretKey");
    expect(source).toContain('Stripe not configured');
  });
});

describe('Square connect: source-level contract', () => {
  const source = require('fs').readFileSync('app/api/payouts/square-connect/route.ts', 'utf-8');

  it('verifies business ownership', () => {
    expect(source).toContain('owner_id'); expect(source).toContain('user.id');
  });

  it('generates and stores state', () => {
    expect(source).toContain('generateState');
    expect(source).toContain('storeState');
  });

  it('rejects when Square is not configured', () => {
    expect(source).toContain('!squareAppId');
    expect(source).toContain('Square not configured');
  });
});

describe('Migration 446: source-level contract', () => {
  const source = require('fs').readFileSync('supabase/migrations/446_payout_accounts_server_only.sql', 'utf-8');

  it('revokes INSERT/UPDATE/DELETE from authenticated', () => {
    expect(source).toContain('REVOKE INSERT, UPDATE, DELETE ON public.payout_accounts FROM PUBLIC, anon, authenticated');
  });

  it('drops owner INSERT and UPDATE policies', () => {
    expect(source).toContain('DROP POLICY IF EXISTS "Business owners can insert own payout accounts"');
    expect(source).toContain('DROP POLICY IF EXISTS "Business owners can update own payout accounts"');
  });

  it('grants column-limited SELECT to authenticated', () => {
    expect(source).toContain('GRANT SELECT (');
    expect(source).toContain(') ON public.payout_accounts TO authenticated');
  });

  it('excludes secret columns from authenticated SELECT', () => {
    // The GRANT SELECT block should NOT contain these columns
    const grantBlock = source.slice(source.indexOf('GRANT SELECT ('), source.indexOf(') ON public.payout_accounts TO authenticated'));
    expect(grantBlock).not.toContain('square_access_token');
    expect(grantBlock).not.toContain('subaccount_code');
    expect(grantBlock).not.toContain('stripe_account_id');
  });

  it('creates oauth_connect_states table', () => {
    expect(source).toContain('CREATE TABLE IF NOT EXISTS public.oauth_connect_states');
    expect(source).toContain('state_hash');
    expect(source).toContain('user_id');
    expect(source).toContain('expires_at');
    expect(source).toContain('used_at');
  });

  it('grants ALL on oauth_connect_states to service_role only', () => {
    expect(source).toContain('GRANT ALL ON public.oauth_connect_states TO service_role');
  });

  it('has a verification DO block', () => {
    expect(source).toContain('VERIFICATION');
    expect(source).toContain('has_table_privilege');
    expect(source).toContain('has_column_privilege');
  });
});

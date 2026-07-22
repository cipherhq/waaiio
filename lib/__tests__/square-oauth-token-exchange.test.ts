/**
 * Square OAuth Token Exchange Tests
 *
 * Verifies:
 * - Token exchange request includes redirect_uri
 * - Authorize and callback use identical redirect URIs via shared helper
 * - Shared helper is the single source of truth
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

describe('Square OAuth redirect_uri consistency', () => {
  const connectRoute = readFileSync('app/api/payouts/square-connect/route.ts', 'utf-8');
  const callbackRoute = readFileSync('app/api/payouts/square-callback/route.ts', 'utf-8');
  const scopesModule = readFileSync('lib/payments/square-scopes.ts', 'utf-8');

  // ── 1. Token exchange includes redirect_uri ──
  it('token exchange request body includes redirect_uri', () => {
    // The JSON.stringify body sent to /oauth2/token must contain redirect_uri
    const tokenBodyMatch = callbackRoute.match(/body:\s*JSON\.stringify\(\{[\s\S]*?\}\)/);
    expect(tokenBodyMatch).not.toBeNull();
    const tokenBody = tokenBodyMatch![0];
    expect(tokenBody).toContain('redirect_uri');
  });

  it('token exchange uses getSquareRedirectUri helper', () => {
    expect(callbackRoute).toContain('getSquareRedirectUri(appUrl)');
  });

  // ── 2. Authorize and callback use the same helper ──
  it('authorize route uses getSquareRedirectUri helper', () => {
    expect(connectRoute).toContain('getSquareRedirectUri(appUrl)');
  });

  it('both routes import getSquareRedirectUri from the same module', () => {
    expect(connectRoute).toContain("from '@/lib/payments/square-scopes'");
    expect(callbackRoute).toContain("from '@/lib/payments/square-scopes'");
    expect(connectRoute).toContain('getSquareRedirectUri');
    expect(callbackRoute).toContain('getSquareRedirectUri');
  });

  it('neither route hardcodes the redirect path', () => {
    // Should not contain the literal callback path outside of the shared helper
    const connectWithoutImports = connectRoute.replace(/import.*square-scopes.*/g, '');
    const callbackWithoutImports = callbackRoute.replace(/import.*square-scopes.*/g, '');
    expect(connectWithoutImports).not.toContain("'/api/payouts/square-callback'");
    expect(callbackWithoutImports).not.toContain("'/api/payouts/square-callback'");
  });

  // ── 3. Shared helper is the single source of truth ──
  it('getSquareRedirectUri is defined in square-scopes.ts', () => {
    expect(scopesModule).toContain('export function getSquareRedirectUri');
    expect(scopesModule).toContain('/api/payouts/square-callback');
  });

  it('getSquareRedirectUri builds from appUrl parameter', () => {
    // The helper takes appUrl as a parameter, not from env directly
    expect(scopesModule).toMatch(/function getSquareRedirectUri\(appUrl:\s*string\)/);
  });

  // ── 4. Token exchange request has all required fields ──
  it('token exchange sends all required Square ObtainToken fields', () => {
    const tokenBodyMatch = callbackRoute.match(/body:\s*JSON\.stringify\(\{[\s\S]*?\}\)/);
    expect(tokenBodyMatch).not.toBeNull();
    const tokenBody = tokenBodyMatch![0];
    expect(tokenBody).toContain('client_id');
    expect(tokenBody).toContain('client_secret');
    expect(tokenBody).toContain('code');
    expect(tokenBody).toContain('grant_type');
    expect(tokenBody).toContain('redirect_uri');
  });

  // ── 5. Sanitized logging is preserved ──
  it('callback logs sanitized diagnostics on token exchange failure', () => {
    expect(callbackRoute).toContain('[SQUARE-CALLBACK] Token exchange failed');
    expect(callbackRoute).toContain('httpStatus');
    expect(callbackRoute).toContain('squareErrorCode');
    expect(callbackRoute).toContain('squareRequestId');
  });

  it('callback does not expose diagnostics in redirect URL', () => {
    // The redirect on failure should only contain error=token_exchange_failed
    // No sq_status, sq_code, sq_detail in the URL
    const redirectLine = callbackRoute.match(/redirect.*token_exchange_failed.*/g);
    expect(redirectLine).not.toBeNull();
    for (const line of redirectLine!) {
      expect(line).not.toContain('sq_status');
      expect(line).not.toContain('sq_code');
      expect(line).not.toContain('sq_detail');
    }
  });
});

describe('getSquareRedirectUri', () => {
  it('returns the correct callback path', async () => {
    const { getSquareRedirectUri } = await import('@/lib/payments/square-scopes');
    expect(getSquareRedirectUri('https://example.com')).toBe('https://example.com/api/payouts/square-callback');
  });

  it('does not add trailing slash', async () => {
    const { getSquareRedirectUri } = await import('@/lib/payments/square-scopes');
    const uri = getSquareRedirectUri('https://example.com');
    expect(uri.endsWith('/')).toBe(false);
  });

  it('handles appUrl with trailing slash', async () => {
    const { getSquareRedirectUri } = await import('@/lib/payments/square-scopes');
    const uri = getSquareRedirectUri('https://example.com/');
    // Should produce a valid URL regardless
    expect(uri).toContain('/api/payouts/square-callback');
  });
});

describe('Square OAuth session parameter (sandbox vs production)', () => {
  const connectRoute = readFileSync('app/api/payouts/square-connect/route.ts', 'utf-8');

  it('does not hardcode session=false in the base params', () => {
    // The URLSearchParams constructor call should NOT contain session: 'false'
    const paramsBlock = connectRoute.match(/new URLSearchParams\(\{[\s\S]*?\}\)/);
    expect(paramsBlock).not.toBeNull();
    expect(paramsBlock![0]).not.toContain("session");
  });

  it('only sets session=false for production environment', () => {
    expect(connectRoute).toContain("squareEnvironment === 'production'");
    expect(connectRoute).toContain("params.set('session', 'false')");
  });

  it('sandbox URLs omit session parameter (defaults to true)', () => {
    // When squareEnvironment !== 'production', session is never added
    // Verify the conditional guard
    const sessionBlock = connectRoute.substring(
      connectRoute.indexOf("params.set('session'"),
      connectRoute.indexOf("params.set('session'") + 200,
    );
    // The set call must be inside a production-only block
    expect(connectRoute).toMatch(/if\s*\(squareEnvironment === 'production'\)\s*\{[\s\S]*?params\.set\('session'/);
  });

  it('authorize URL still contains required params: client_id, scope, state, redirect_uri', () => {
    const paramsBlock = connectRoute.match(/new URLSearchParams\(\{[\s\S]*?\}\)/);
    expect(paramsBlock).not.toBeNull();
    const params = paramsBlock![0];
    expect(params).toContain('client_id');
    expect(params).toContain('scope');
    expect(params).toContain('state');
    expect(params).toContain('redirect_uri');
  });
});

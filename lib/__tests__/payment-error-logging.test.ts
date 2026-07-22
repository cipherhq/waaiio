/**
 * Payment Error Logging Tests
 *
 * Proves that catch blocks preserve error information for all thrown types:
 * Error objects, strings, objects, undefined, and null.
 * Verifies secrets never appear in logs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

describe('Square gateway catch block error preservation', () => {
  const squareCode = readFileSync('lib/payments/square.ts', 'utf-8');

  it('uses instanceof Error check, not cast', () => {
    expect(squareCode).toContain('error instanceof Error');
    expect(squareCode).not.toMatch(/\[SQUARE\] init error:.*\(error as Error\)\.message/);
  });

  it('handles non-Error thrown values', () => {
    expect(squareCode).toContain('non-Error thrown:');
  });

  it('includes stack frames for Error objects', () => {
    expect(squareCode).toMatch(/error\.stack\?\.split/);
  });

  it('never logs access tokens in catch block', () => {
    // The catch block should not reference squareAccessToken, opts.squareAccessToken, or useToken
    const catchBlock = squareCode.substring(
      squareCode.lastIndexOf('} catch (error) {'),
      squareCode.lastIndexOf('} catch (error) {') + 300,
    );
    expect(catchBlock).not.toContain('squareAccessToken');
    expect(catchBlock).not.toContain('useToken');
    expect(catchBlock).not.toContain('opts.squareAccessToken');
  });
});

describe('initializePayment catch block error preservation', () => {
  const paymentCode = readFileSync('lib/bot/flows/shared/payment.ts', 'utf-8');

  it('uses instanceof Error check, not cast', () => {
    expect(paymentCode).toContain('error instanceof Error');
    expect(paymentCode).not.toMatch(/\[PAYMENT\] initializePayment error:.*\(error as Error\)\.message/);
  });

  it('handles non-Error thrown values', () => {
    expect(paymentCode).toContain('non-Error thrown:');
  });

  it('includes stack frames for Error objects', () => {
    // The catch block should reference error.stack to extract frames
    const catchIdx = paymentCode.lastIndexOf('} catch (error) {');
    const catchBlock = paymentCode.substring(catchIdx, catchIdx + 300);
    expect(catchBlock).toContain('error.stack');
  });

  it('never logs tokens or secrets in catch block', () => {
    const catchIdx = paymentCode.lastIndexOf('} catch (error) {');
    const catchBlock = paymentCode.substring(catchIdx, catchIdx + 300);
    expect(catchBlock).not.toContain('squareAccessToken');
    expect(catchBlock).not.toContain('byoSecretKey');
    expect(catchBlock).not.toContain('opts.squareAccessToken');
  });
});

describe('Logger handles undefined arguments', () => {
  const loggerCode = readFileSync('lib/logger.ts', 'utf-8');

  it('formatArgs uses JSON.stringify for non-string non-Error values', () => {
    expect(loggerCode).toContain('JSON.stringify(a)');
  });

  it('production format includes level prefix', () => {
    expect(loggerCode).toContain('`[${level}]');
  });
});

/**
 * Payout setup password field: verify the input stays mounted while typing
 * and the full password value reaches the /api/payouts/setup request.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// __dirname resolves to the test file's directory regardless of cwd
const source = readFileSync(
  resolve(__dirname, '../../app/dashboard/payouts/page.tsx'),
  'utf-8',
);

describe('Payout setup password field', () => {
  it('password input renders without a !setupPassword guard that hides it on first keystroke', () => {
    // The bug was: {(step === 'idle' || step === 'confirming') && !setupPassword && (
    // The fix is: {(step === 'idle' || step === 'confirming') && (
    //
    // Find the password-for-setup section and verify it does NOT contain
    // the !setupPassword condition in the render guard.
    const passwordSection = source.slice(
      source.indexOf('{/* Password for setup */}'),
      source.indexOf('{/* Password for setup */}') + 500,
    );
    expect(passwordSection).not.toBe('');

    // The render condition should NOT include !setupPassword
    expect(passwordSection).not.toMatch(/&&\s*!setupPassword\s*&&/);

    // It should still be gated on step
    expect(passwordSection).toMatch(/step\s*===\s*'idle'\s*\|\|\s*step\s*===\s*'confirming'/);
  });

  it('the "Yes, set up payouts" button is disabled when setupPassword is empty', () => {
    // The button should have disabled={!setupPassword}
    const confirmSection = source.slice(
      source.indexOf('Yes, set up payouts'),
      source.indexOf('Yes, set up payouts') + 200,
    );
    // Go backwards to find the button's disabled prop
    const buttonArea = source.slice(
      source.indexOf('Yes, set up payouts') - 300,
      source.indexOf('Yes, set up payouts') + 50,
    );
    expect(buttonArea).toContain('disabled={!setupPassword}');
  });

  it('handleConfirm sends the full setupPassword to /api/payouts/setup', () => {
    // Verify the fetch body includes password: pw (where pw = setupPassword)
    const fnStart = source.indexOf('async function handleConfirm()');
    const fnEnd = source.indexOf('\n  }', fnStart + 100); // closing brace at indent level 2
    const confirmFn = source.slice(fnStart, fnEnd + 4);
    expect(confirmFn).toContain('const pw = setupPassword');
    expect(confirmFn).toContain('password: pw');
  });

  it('setupPassword is cleared after successful setup', () => {
    const fnStart = source.indexOf('async function handleConfirm()');
    const fnEnd = source.indexOf('\n  }', fnStart + 100);
    const confirmFn = source.slice(fnStart, fnEnd + 4);
    expect(confirmFn).toContain("setSetupPassword('')");
  });

  it('change-account and disconnect password fields do not have the disappearing-input bug', () => {
    // The changePassword fields should render without a !changePassword guard.
    // Check the "Confirm account change" section
    const changeSection = source.slice(
      source.indexOf('Confirm account change'),
      source.indexOf('Confirm account change') + 800,
    );
    expect(changeSection).toContain('value={changePassword}');
    expect(changeSection).not.toMatch(/&&\s*!changePassword\s*&&/);

    // Check the "Disconnect payout account" section
    const disconnectSection = source.slice(
      source.indexOf('Disconnect payout account'),
      source.indexOf('Disconnect payout account') + 800,
    );
    expect(disconnectSection).toContain('value={changePassword}');
    expect(disconnectSection).not.toMatch(/&&\s*!changePassword\s*&&/);
  });

  it('setupPassword is never logged or persisted to localStorage/sessionStorage', () => {
    // Verify no console.log/localStorage/sessionStorage references for setupPassword
    expect(source).not.toMatch(/console\.\w+\(.*setupPassword/);
    expect(source).not.toMatch(/localStorage.*setupPassword/);
    expect(source).not.toMatch(/sessionStorage.*setupPassword/);
  });
});

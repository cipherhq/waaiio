/**
 * Issue #219 — PostgreSQL-backed notification enum evidence.
 *
 * Verifies that the notification_type enum in the initial migration
 * includes 'payment' (valid) and does NOT include 'payment_received'
 * (deprecated/invalid). Also verifies that send-confirmation.ts uses
 * the correct enum value for both Payment/Giving and donation notifications.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('PostgreSQL notification_type enum evidence', () => {
  const migrationSrc = readFileSync(
    resolve(__dirname, '../../supabase/migrations/001_initial_schema.sql'),
    'utf-8',
  );
  const sendConfirmationSrc = readFileSync(
    resolve(__dirname, '../payments/send-confirmation.ts'),
    'utf-8',
  );

  it('h1. notification_type enum includes "payment"', () => {
    // The CREATE TYPE notification_type AS ENUM must contain 'payment'
    const enumMatch = migrationSrc.match(/CREATE TYPE notification_type AS ENUM\s*\(([^)]+)\)/);
    expect(enumMatch).not.toBeNull();
    const enumValues = enumMatch![1];
    expect(enumValues).toContain("'payment'");
  });

  it('h2. notification_type enum does NOT include "payment_received"', () => {
    const enumMatch = migrationSrc.match(/CREATE TYPE notification_type AS ENUM\s*\(([^)]+)\)/);
    expect(enumMatch).not.toBeNull();
    const enumValues = enumMatch![1];
    expect(enumValues).not.toContain("'payment_received'");
  });

  it('h3. send-confirmation.ts uses type: "payment" for Payment/Giving and donation notifications', () => {
    // The Payment/Giving path uses a direct .insert() with type: 'payment'
    // (not 'payment_received' or any other deprecated value)
    expect(sendConfirmationSrc).toContain("type: 'payment'");

    // The donation path also uses type: 'payment' via createNotification
    // Find the donation createNotification call (near "campaign donation" or "donation" context)
    const donationSectionIdx = sendConfirmationSrc.indexOf('donation-owner-notify');
    expect(donationSectionIdx).toBeGreaterThan(-1);
    // The createNotification call after the donation section must use type: 'payment'
    const afterDonation = sendConfirmationSrc.slice(donationSectionIdx);
    const donationTypeMatch = afterDonation.match(/type:\s*'([^']+)'/);
    expect(donationTypeMatch).not.toBeNull();
    expect(donationTypeMatch![1]).toBe('payment');

    // Must NOT use deprecated 'payment_received' anywhere
    expect(sendConfirmationSrc).not.toContain("type: 'payment_received'");
    // Must NOT use 'donation' as a notification type value
    expect(sendConfirmationSrc).not.toContain("type: 'donation'");
  });
});

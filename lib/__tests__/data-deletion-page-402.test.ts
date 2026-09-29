/**
 * Data deletion page (#402) — truthfulness regression tests
 *
 * Prevents the public data-deletion page from overstating what the
 * backend actually deletes. The DELETE /api/account endpoint soft-deletes
 * businesses and removes the auth user/profile, but does NOT physically
 * erase business-linked records (bookings, payments, customers, media).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const pageSrc = readFileSync(
  resolve(__dirname, '../../app/(marketing)/data-deletion/page.tsx'),
  'utf-8'
);

const apiSrc = readFileSync(
  resolve(__dirname, '../../app/api/account/route.ts'),
  'utf-8'
);

describe('#402 data-deletion page — truthfulness', () => {
  it('does not claim data is "permanently removed" or "permanently erased"', () => {
    expect(pageSrc).not.toMatch(/permanently\s+(removed|erased|deleted)/i);
  });

  it('does not claim all businesses are physically deleted', () => {
    // Page must reflect soft-delete behavior, not physical deletion
    expect(pageSrc).toContain('deactivated');
    expect(pageSrc).toContain('soft-deleted');
  });

  it('does not claim customer/booking data is deleted', () => {
    // Backend does not delete bookings, customers, or orders
    expect(pageSrc).not.toMatch(/customer.*data.*(?:removed|deleted|erased)/i);
    expect(pageSrc).not.toMatch(/booking.*data.*(?:removed|deleted|erased)/i);
  });

  it('does not claim payment records are deleted', () => {
    expect(pageSrc).not.toMatch(/payment\s+records.*(?:removed|deleted|erased)/i);
  });

  it('does not claim uploaded media is deleted', () => {
    expect(pageSrc).not.toMatch(/uploaded\s+media.*(?:removed|deleted|erased)/i);
    expect(pageSrc).not.toMatch(/logos.*images.*(?:removed|deleted|erased)/i);
  });

  it('mentions both immediate deletion and grace period options', () => {
    expect(pageSrc).toContain('Immediate Deletion');
    expect(pageSrc).toContain('30-Day Grace Period');
  });

  it('explains data retention for operational/financial records', () => {
    expect(pageSrc).toMatch(/retain/i);
    expect(pageSrc).toMatch(/legal|compliance|accounting/i);
  });

  it('does not make unsupported GDPR/CCPA response-time guarantees', () => {
    expect(pageSrc).not.toMatch(/within\s+30\s+days.*(?:GDPR|CCPA)/i);
    expect(pageSrc).not.toMatch(/in\s+accordance\s+with\s+(?:GDPR|CCPA)/i);
  });

  it('does not claim deletion automatically completes after grace period', () => {
    // No cron/worker exists to execute final deletion after 30 days
    expect(pageSrc).not.toMatch(/after\s+the\s+grace\s+period\s+expires/i);
    expect(pageSrc).not.toMatch(/automatically\s+(deleted|removed|completed)/i);
    expect(pageSrc).not.toMatch(/deletion\s+will\s+complete/i);
  });

  it('does not claim login alone cancels scheduled deletion', () => {
    // PATCH /api/account exists but no login flow calls it automatically
    expect(pageSrc).not.toMatch(/simply\s+log\s+back\s+in/i);
    expect(pageSrc).not.toMatch(/logging\s+in\s+cancels/i);
  });

  it('directs users to dashboard Cancel Deletion action or privacy email', () => {
    expect(pageSrc).toContain('Cancel Deletion');
    // Must also offer fallback contact for users who cannot access dashboard
    expect(pageSrc).toContain('privacy@waaiio.com');
  });

  it('includes the Meta-required deletion instructions', () => {
    expect(pageSrc).toContain('Delete Account');
    expect(pageSrc).toContain('Dashboard');
    expect(pageSrc).toContain('Settings');
  });

  it('includes the fallback privacy email', () => {
    expect(pageSrc).toContain('privacy@waaiio.com');
  });

  it('links to privacy policy and terms', () => {
    expect(pageSrc).toContain('/privacy');
    expect(pageSrc).toContain('/terms');
  });
});

describe('#402 dashboard deletion banner — truthfulness', () => {
  const dashboardSrc = readFileSync(
    resolve(__dirname, '../../app/dashboard/page.tsx'),
    'utf-8'
  );

  it('does not claim data will be permanently removed', () => {
    expect(dashboardSrc).not.toMatch(/permanently\s+removed/i);
    expect(dashboardSrc).not.toMatch(/All your data will be/i);
  });

  it('does not claim automatic deletion after the scheduled date', () => {
    expect(dashboardSrc).not.toMatch(/automatically\s+(deleted|removed)/i);
  });

  it('describes current state (deactivated) and offers cancel action', () => {
    expect(dashboardSrc).toContain('deactivated');
    expect(dashboardSrc).toContain('Cancel Deletion');
  });
});

describe('#402 backend alignment — soft-delete confirmation', () => {
  it('backend soft-deletes businesses (does not physically delete)', () => {
    // Both immediate and grace-period paths use soft-delete
    expect(apiSrc).toContain("status: 'deleted'");
    // No physical table row deletion for businesses
    expect(apiSrc).not.toMatch(/\.delete\(\).*businesses/);
  });

  it('backend supports both immediate and grace-period paths', () => {
    expect(apiSrc).toContain('gracePeriod');
    expect(apiSrc).toContain('deletion_scheduled');
  });

  it('backend deletes auth user on immediate path only', () => {
    expect(apiSrc).toContain('admin.deleteUser');
  });
});

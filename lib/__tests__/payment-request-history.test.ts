/**
 * Payment Request History Tests
 *
 * Verifies:
 * - Status mapping uses correct enum values (success, not completed/successful)
 * - Ownership enforced via business_id + RLS
 * - Empty state renders
 * - Payment link shown only for pending with checkout URL
 * - Detail view includes required fields
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const pageCode = readFileSync('app/dashboard/payment-request/page.tsx', 'utf-8');

describe('Payment request status mapping', () => {
  it('checks for "success" status (matching payment_status enum)', () => {
    expect(pageCode).toContain("includes('success')");
  });

  it('does NOT check for non-existent "completed" status', () => {
    expect(pageCode).not.toContain("includes('completed')");
  });

  it('does NOT check for non-existent "successful" status', () => {
    expect(pageCode).not.toContain("includes('successful')");
  });

  it('maps success to Paid label', () => {
    // Find the success check and verify it returns Paid
    const successIdx = pageCode.indexOf("includes('success')");
    const labelIdx = pageCode.indexOf("'Paid'", successIdx);
    const nextCheck = pageCode.indexOf("includes('", successIdx + 20);
    expect(labelIdx).toBeGreaterThan(successIdx);
    expect(labelIdx).toBeLessThan(nextCheck);
  });

  it('maps pending to Pending label', () => {
    expect(pageCode).toContain("includes('pending')");
    const pendingIdx = pageCode.indexOf("includes('pending')");
    const nearbyPaid = pageCode.indexOf("'Pending'", pendingIdx);
    expect(nearbyPaid).toBeGreaterThan(pendingIdx);
  });

  it('maps refunded to Refunded label', () => {
    expect(pageCode).toContain("includes('refunded')");
  });

  it('maps failed to Failed label', () => {
    expect(pageCode).toContain("includes('failed')");
  });
});

describe('Payment request data access', () => {
  it('queries bookings with flow_type payment', () => {
    expect(pageCode).toContain(".eq('flow_type', 'payment')");
  });

  it('queries by business_id (RLS ownership)', () => {
    expect(pageCode).toContain(".eq('business_id', business.id)");
  });

  it('uses browser supabase client (respects RLS)', () => {
    expect(pageCode).toContain("from '@/lib/supabase/client'");
  });

  it('selects payment details including gateway and metadata', () => {
    expect(pageCode).toContain('payments!payments_reservation_id_fkey(status, gateway, gateway_reference');
    expect(pageCode).toContain('metadata');
  });

  it('disambiguates the payments join to avoid PGRST201', () => {
    // bookings has two FKs to payments (booking_id and payment_id)
    // Must use !fk_name to disambiguate
    expect(pageCode).toContain('payments!payments_reservation_id_fkey');
    expect(pageCode).not.toMatch(/\.select\([^)]*payments\(status/);
  });

  it('sorts newest first', () => {
    expect(pageCode).toContain("order('created_at', { ascending: false })");
  });
});

describe('Payment request table columns', () => {
  it('shows Customer column', () => {
    expect(pageCode).toContain('>Customer<');
  });

  it('shows Amount column', () => {
    expect(pageCode).toContain('>Amount<');
  });

  it('shows Sent date column', () => {
    expect(pageCode).toContain('>Sent<');
  });

  it('shows Status column', () => {
    expect(pageCode).toContain('>Status<');
  });

  it('shows delivery method column', () => {
    expect(pageCode).toContain('>Via<');
  });

  it('shows Provider column', () => {
    expect(pageCode).toContain('>Provider<');
  });

  it('shows Actions column', () => {
    expect(pageCode).toContain('>Actions<');
  });
});

describe('Payment link actions', () => {
  it('shows Copy Link button for pending requests with checkout URL', () => {
    expect(pageCode).toContain('Copy Link');
    expect(pageCode).toContain('isPending && checkoutUrl');
  });

  it('shows Open link for pending requests', () => {
    expect(pageCode).toContain('Open');
    expect(pageCode).toContain("target=\"_blank\"");
  });

  it('extracts checkout URL from payment metadata', () => {
    expect(pageCode).toContain('square_checkout_url');
    expect(pageCode).toContain('checkout_url');
  });

  it('uses clipboard API for copy', () => {
    expect(pageCode).toContain('navigator.clipboard.writeText');
  });
});

describe('Empty state', () => {
  it('shows empty state when no requests', () => {
    expect(pageCode).toContain('No payment requests yet');
  });

  it('shows guidance text', () => {
    expect(pageCode).toContain('Requests you send will appear here');
  });
});

describe('List refresh after send', () => {
  it('calls loadRequests after successful single send', () => {
    // After res.ok, the code calls loadRequests()
    const sendSection = pageCode.substring(
      pageCode.indexOf("'Payment request sent!'"),
      pageCode.indexOf("'Payment request sent!'") + 200,
    );
    expect(sendSection).toContain('loadRequests()');
  });

  it('calls loadRequests after successful bulk send', () => {
    // After bulk send with sent > 0, loadRequests is called
    expect(pageCode).toContain('if (sent > 0)');
    const bulkSection = pageCode.substring(
      pageCode.indexOf('if (sent > 0)'),
      pageCode.indexOf('if (sent > 0)') + 200,
    );
    expect(bulkSection).toContain('loadRequests()');
  });
});

describe('Detail view', () => {
  it('shows recipient name', () => {
    expect(pageCode).toContain('>Recipient<');
  });

  it('shows contact info', () => {
    expect(pageCode).toContain('>Contact<');
  });

  it('shows amount', () => {
    // Detail view has Amount label
    const detailSection = pageCode.substring(pageCode.indexOf('Payment Request</h3>'));
    expect(detailSection).toContain('>Amount<');
  });

  it('shows reference code', () => {
    expect(pageCode).toContain('>Reference<');
  });

  it('shows provider', () => {
    const detailSection = pageCode.substring(pageCode.indexOf('Payment Request</h3>'));
    expect(detailSection).toContain('>Provider<');
  });

  it('shows gateway reference when available', () => {
    expect(pageCode).toContain('>Gateway Ref<');
    expect(pageCode).toContain('gateway_reference');
  });

  it('shows created time', () => {
    expect(pageCode).toContain('>Created<');
  });

  it('shows paid time when payment is success', () => {
    expect(pageCode).toContain('>Paid<');
    expect(pageCode).toContain("status === 'success'");
  });

  it('shows payment actions in detail view for pending', () => {
    expect(pageCode).toContain('Copy Payment Link');
    expect(pageCode).toContain('Open Payment Link');
  });
});

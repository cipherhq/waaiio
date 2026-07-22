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

  it('has deterministic sort with tie-breaker', () => {
    expect(pageCode).toContain("order('id', { ascending: false })");
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
  it('refreshes page 1 after successful single send when on page 1', () => {
    const sendSection = pageCode.substring(
      pageCode.indexOf("'Payment request sent!'"),
      pageCode.indexOf("'Payment request sent!'") + 300,
    );
    expect(sendSection).toContain('loadRequests(1, pageSize)');
  });

  it('refreshes after successful bulk send when on page 1', () => {
    expect(pageCode).toContain('if (sent > 0)');
    const bulkSection = pageCode.substring(
      pageCode.indexOf('if (sent > 0)'),
      pageCode.indexOf('if (sent > 0)') + 300,
    );
    expect(bulkSection).toContain('loadRequests(1, pageSize)');
  });
});

describe('Pagination', () => {
  it('uses Supabase range() for server-side pagination', () => {
    expect(pageCode).toContain('.range(from, to)');
  });

  it('requests exact count from server', () => {
    expect(pageCode).toContain("{ count: 'exact' }");
  });

  it('reads page number from URL search params', () => {
    expect(pageCode).toContain("searchParams.get('page')");
  });

  it('persists page number in URL on navigation', () => {
    expect(pageCode).toContain("params.set('page'");
    expect(pageCode).toContain('router.push');
  });

  it('supports page sizes 25, 50, and 100', () => {
    expect(pageCode).toContain('[25, 50, 100]');
  });

  it('resets to page 1 when page size changes', () => {
    expect(pageCode).toContain("params.delete('page')");
  });

  it('disables Previous button on first page', () => {
    expect(pageCode).toContain('disabled={currentPage <= 1}');
  });

  it('disables Next button on last page', () => {
    expect(pageCode).toContain('disabled={currentPage >= totalPages}');
  });

  it('shows page range indicator', () => {
    expect(pageCode).toContain('of {totalCount} payment requests');
  });

  it('shows Page X of Y', () => {
    expect(pageCode).toContain('Page {currentPage} of {totalPages}');
  });

  it('refetches page 1 when creating a request on page 1', () => {
    expect(pageCode).toContain('currentPage === 1');
    expect(pageCode).toContain('loadRequests(1, pageSize)');
  });

  it('shows banner when request created on page > 1', () => {
    expect(pageCode).toContain('newRequestCreated');
    expect(pageCode).toContain('Return to page 1 to view the newest request');
  });

  it('removes page 1 from URL (clean default)', () => {
    // When navigating to page 1, page param should be deleted from URL
    const goToPageFn = pageCode.substring(
      pageCode.indexOf('function goToPage'),
      pageCode.indexOf('function goToPage') + 300,
    );
    expect(goToPageFn).toContain("params.delete('page')");
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

describe('Async safety', () => {
  it('uses a fetch ID counter to prevent stale responses', () => {
    expect(pageCode).toContain('fetchIdRef');
    expect(pageCode).toContain('fetchIdRef.current');
  });

  it('discards stale responses when a newer fetch has been initiated', () => {
    // After await, checks if fetchId still matches current
    expect(pageCode).toContain('if (fetchId !== fetchIdRef.current) return');
  });
});

describe('Modal accessibility', () => {
  it('modal container is focusable for initial focus placement', () => {
    expect(pageCode).toContain('ref={modalRef}');
    expect(pageCode).toContain('tabIndex={-1}');
  });

  it('saves trigger element reference for focus restoration', () => {
    expect(pageCode).toContain('triggerRef');
    expect(pageCode).toContain('triggerRef.current');
  });

  it('restores focus to trigger element on close', () => {
    // useEffect checks !selectedRequest and focuses triggerRef
    const effectSection = pageCode.substring(
      pageCode.indexOf('Modal focus management'),
      pageCode.indexOf('Modal focus management') + 300,
    );
    expect(effectSection).toContain('triggerRef.current.focus()');
  });
});

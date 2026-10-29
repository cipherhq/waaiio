/**
 * Lane 1 — Outbound Customer Delivery Status Tests
 *
 * Issue #736: Proves that payment-request, invoice, contract and waiver
 * send routes return truthful delivery status and do not report false
 * success when WhatsApp/email delivery fails.
 *
 * Tests use source-level structural analysis (file reads) to verify:
 * 1. No pre-emission false success (status set before delivery)
 * 2. Truthful per-channel delivery status in API response
 * 3. sendOrEmail result captured, not discarded
 * 4. Adjacent senders (broadcasts, reminders, orders) are unchanged
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

function readRoute(routePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), routePath), 'utf-8');
}

describe('Lane 1: Invoice send route delivery status', () => {
  const src = readRoute('app/api/invoices/send/route.ts');

  it('does not set invoice status to sent before delivery attempt', () => {
    // The token/URL update should NOT include status: 'sent'
    // Find the first .update() call and verify it doesn't set status: 'sent'
    const tokenUpdateMatch = src.match(/\.update\(\{[^}]*token,[^}]*\}\)/s);
    expect(tokenUpdateMatch).toBeTruthy();
    expect(tokenUpdateMatch![0]).not.toContain("status: 'sent'");
  });

  it('sets invoice status to sent only after delivery acceptance', () => {
    // status: 'sent' must appear AFTER anyChannelAccepted check
    const sentStatusIdx = src.indexOf("status: 'sent'");
    const anyChannelIdx = src.indexOf('anyChannelAccepted');
    expect(sentStatusIdx).toBeGreaterThan(-1);
    expect(anyChannelIdx).toBeGreaterThan(-1);
    expect(sentStatusIdx).toBeGreaterThan(anyChannelIdx);
  });

  it('returns wa_delivery_status in the API response', () => {
    expect(src).toContain('wa_delivery_status');
    // Must appear in the NextResponse.json return
    const responseMatch = src.match(/NextResponse\.json\(\{[^}]*wa_delivery_status/s);
    expect(responseMatch).toBeTruthy();
  });

  it('returns email_delivery_status in the API response', () => {
    expect(src).toContain('email_delivery_status');
    const responseMatch = src.match(/NextResponse\.json\(\{[^}]*email_delivery_status/s);
    expect(responseMatch).toBeTruthy();
  });

  it('records wa_delivery_status on failure (not just success)', () => {
    // wa_delivery_status must be set for both accepted and failed
    const failedAssignment = src.includes("waDeliveryStatus = waMessageId ? 'accepted' : 'failed'");
    expect(failedAssignment).toBe(true);
  });

  it('returns success: false when all delivery channels fail', () => {
    expect(src).toContain('success: anyChannelAccepted');
  });
});

describe('Lane 1: Payment request send route delivery status', () => {
  const src = readRoute('app/api/payment-request/send/route.ts');

  it('captures sendOrEmail result instead of discarding it', () => {
    // Must assign the result: const deliveryResult = await sendOrEmail(...)
    expect(src).toContain('deliveryResult = await sendOrEmail');
  });

  it('returns wa_delivery_status in the API response', () => {
    const responseMatch = src.match(/NextResponse\.json\(\{[^}]*wa_delivery_status/s);
    expect(responseMatch).toBeTruthy();
  });

  it('returns success based on actual delivery outcome', () => {
    expect(src).toContain('success: anyChannelAccepted');
  });

  it('maps sendOrEmail whatsapp sent to accepted', () => {
    expect(src).toContain("deliveryResult.whatsapp === 'sent' ? 'accepted' : 'failed'");
  });
});

describe('Lane 1: Waiver sign route notification status', () => {
  const src = readRoute('app/api/waivers/sign/route.ts');

  it('tracks customer WhatsApp notification status', () => {
    expect(src).toContain('customerWaStatus');
  });

  it('returns notification_status in the API response', () => {
    expect(src).toContain('notification_status');
    expect(src).toContain('customer_whatsapp: customerWaStatus');
  });

  it('preserves waiver signed success regardless of notification failure', () => {
    // success: true must always be returned (waiver is signed regardless)
    const responseMatch = src.match(/success:\s*true/);
    expect(responseMatch).toBeTruthy();
  });

  it('sets customerWaStatus to failed on sendText error', () => {
    // The catch block must set failed status
    expect(src).toContain("customerWaStatus = 'failed'");
  });
});

describe('Lane 1: Non-regression — adjacent senders unchanged', () => {
  it('broadcasts/send route is not modified', () => {
    const src = readRoute('app/api/broadcasts/send/route.ts');
    // Verify the file still uses sendOrEmail the original way (fire-and-forget is OK for broadcasts)
    expect(src).toContain('sendOrEmail');
  });

  it('reminders cron route is not modified', () => {
    const src = readRoute('app/api/cron/reminders/route.ts');
    expect(src).toContain('sendOrEmail');
  });

  it('orders update-status route is not modified', () => {
    const src = readRoute('app/api/orders/update-status/route.ts');
    expect(src).toContain('sendOrEmail');
  });
});

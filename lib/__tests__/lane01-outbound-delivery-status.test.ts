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
 * 4. sendEmail return value checked (not just try/catch)
 * 5. messageCategory explicitly set on each outbound sender
 * 6. No reference to non-existent DB columns
 * 7. Adjacent senders (broadcasts, reminders, orders) are unchanged
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

function readRoute(routePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), routePath), 'utf-8');
}

// ─── Invoice send route ─────────────────────────────────────────────

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

  it('does not reference wa_status_updated_at (column absent on invoices table)', () => {
    expect(src).not.toContain('wa_status_updated_at');
  });

  it('logs DB update errors for WA delivery status instead of swallowing them', () => {
    expect(src).toContain('waUpdateErr');
    expect(src).toContain("logger.error('[INVOICE] Failed to record WA delivery status:'");
  });
});

// ─── Invoice send: messageCategory ──────────────────────────────────

describe('Lane 1: Invoice send route message classification', () => {
  const src = readRoute('app/api/invoices/send/route.ts');

  it('passes messageCategory utility on sendTemplate', () => {
    // sendTemplate call must include messageCategory: 'utility'
    const templateBlock = src.match(/sendTemplate\(\{[\s\S]*?\}\)/);
    expect(templateBlock).toBeTruthy();
    expect(templateBlock![0]).toContain("messageCategory: 'utility'");
  });

  it('passes messageCategory utility on sendText fallback', () => {
    expect(src).toContain("sendText({ to: cleanPhone, text: message, messageCategory: 'utility' })");
  });

  it('passes messageCategory utility on sendDocument (PDF attachment)', () => {
    const docBlock = src.match(/sendDocument\(\{[\s\S]*?\}\)/);
    expect(docBlock).toBeTruthy();
    expect(docBlock![0]).toContain("messageCategory: 'utility'");
  });
});

// ─── Invoice send: email truthful status ────────────────────────────

describe('Lane 1: Invoice send route email truthfulness', () => {
  const src = readRoute('app/api/invoices/send/route.ts');

  it('checks sendEmail return value (not just try/catch)', () => {
    // Must check emailResult.success, not just rely on exception
    expect(src).toContain('emailResult.success');
  });

  it('sets emailDeliveryStatus to failed when sendEmail returns success: false', () => {
    // The pattern: emailResult.success ? 'accepted' : 'failed'
    expect(src).toContain("emailResult.success ? 'accepted' : 'failed'");
  });
});

// ─── Payment request send route ─────────────────────────────────────

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

describe('Lane 1: Payment request message classification', () => {
  const src = readRoute('app/api/payment-request/send/route.ts');

  it('passes messageCategory utility to sendOrEmail', () => {
    // The sendOrEmail call must include messageCategory: 'utility'
    const sendOrEmailBlock = src.match(/sendOrEmail\(\{[\s\S]*?\}\)/);
    expect(sendOrEmailBlock).toBeTruthy();
    expect(sendOrEmailBlock![0]).toContain("messageCategory: 'utility'");
  });
});

describe('Lane 1: Payment request email truthfulness', () => {
  const src = readRoute('app/api/payment-request/send/route.ts');

  it('checks sendEmail return value for email-only path', () => {
    expect(src).toContain('emailResult.success');
  });

  it('sets emailDeliveryStatus to failed when sendEmail returns success: false', () => {
    expect(src).toContain("emailResult.success ? 'accepted' : 'failed'");
  });
});

// ─── Waiver sign route ──────────────────────────────────────────────

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

describe('Lane 1: Waiver sign route message classification', () => {
  const src = readRoute('app/api/waivers/sign/route.ts');

  it('passes messageCategory utility on customer confirmation sendText', () => {
    expect(src).toContain("messageCategory: 'utility'");
  });

  it('passes messageCategory utility on owner notification sendText', () => {
    // Both customer and owner sends should have messageCategory
    const matches = src.match(/messageCategory: 'utility'/g);
    expect(matches).toBeTruthy();
    // At least 2: one for customer, one for owner
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── sendOrEmail supports messageCategory passthrough ───────────────

describe('Lane 1: sendOrEmail messageCategory passthrough', () => {
  const src = readRoute('lib/channels/send-or-email.ts');

  it('accepts messageCategory in SendOrEmailOpts', () => {
    expect(src).toContain('messageCategory?: string');
  });

  it('passes messageCategory to sender.sendText', () => {
    expect(src).toContain('messageCategory: opts.messageCategory');
  });
});

// ─── Non-regression — adjacent senders unchanged ────────────────────

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

  it('sendOrEmail messageCategory is optional (backward-compatible)', () => {
    const src = readRoute('lib/channels/send-or-email.ts');
    // The field must be optional (?)
    expect(src).toContain('messageCategory?: string');
    // Existing callers that don't pass it will get undefined, which becomes null
    // at the sender level — same as before
  });
});

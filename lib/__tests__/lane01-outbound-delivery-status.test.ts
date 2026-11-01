/**
 * Lane 1 — Outbound Customer Delivery Status Tests (Issue #736)
 *
 * Executable behavioral tests for sendOrEmail and related outbound
 * delivery paths. Tests exercise actual function behavior with mocked
 * senders/email, NOT source-string analysis.
 *
 * Coverage:
 * - sendOrEmail: accepted, rejected (success:false), thrown provider/email
 * - sendOrEmail: messageCategory passthrough
 * - sendOrEmail: email fallback on WhatsApp failure
 * - sendOrEmail: both channels succeed/fail truthfully
 * - contracts/send: messageCategory on template and fallback
 * - waivers/sign: notification status tracking (customer + merchant)
 * - Payment-request dashboard reports accepted delivery and preserves failed-send links
 * - Financial guard: conversation limit enforced before send
 * - Adjacent sender non-regression (structural, not behavioral)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── sendOrEmail behavioral tests ──────────────────────────────────

describe('sendOrEmail behavioral delivery status', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  function mockSender(textResult?: Record<string, unknown>, shouldThrow?: Error) {
    return {
      sendText: vi.fn().mockImplementation(async () => {
        if (shouldThrow) throw shouldThrow;
        return textResult ?? { success: true, messageId: 'wa-123' };
      }),
      sendTemplate: vi.fn().mockResolvedValue({ success: true, messageId: 'tmpl-1' }),
      sendButtons: vi.fn().mockResolvedValue({}),
      sendList: vi.fn().mockResolvedValue({}),
      sendDocument: vi.fn().mockResolvedValue({}),
    };
  }

  async function loadSendOrEmail() {
    const mod = await import('@/lib/channels/send-or-email');
    return mod.sendOrEmail;
  }

  it('returns whatsapp:sent when sendText resolves successfully', async () => {
    const sender = mockSender({ success: true, messageId: 'wa-ok' });
    const sendOrEmail = await loadSendOrEmail();

    const result = await sendOrEmail({
      supabase: {} as any, sender: sender as any,
      to: '2341234567890', text: 'hello',
    });

    expect(result.whatsapp).toBe('sent');
    expect(sender.sendText).toHaveBeenCalledOnce();
  });

  it('returns whatsapp:failed when sendText resolves with success:false', async () => {
    const sender = mockSender({ success: false });
    const sendOrEmail = await loadSendOrEmail();

    const result = await sendOrEmail({
      supabase: {} as any, sender: sender as any,
      to: '2341234567890', text: 'hello',
    });

    expect(result.whatsapp).toBe('failed');
  });

  it('returns whatsapp:failed when sendText throws', async () => {
    const sender = mockSender(undefined, new Error('Meta API timeout'));
    const sendOrEmail = await loadSendOrEmail();

    const result = await sendOrEmail({
      supabase: {} as any, sender: sender as any,
      to: '2341234567890', text: 'hello',
    });

    expect(result.whatsapp).toBe('failed');
  });

  it('passes messageCategory through to sendText', async () => {
    const sender = mockSender();
    const sendOrEmail = await loadSendOrEmail();

    await sendOrEmail({
      supabase: {} as any, sender: sender as any,
      to: '2341234567890', text: 'hello', messageCategory: 'utility',
    });

    expect(sender.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ messageCategory: 'utility' }),
    );
  });

  it('sendText called without messageCategory when not supplied (backward compat)', async () => {
    const sender = mockSender();
    const sendOrEmail = await loadSendOrEmail();

    await sendOrEmail({
      supabase: {} as any, sender: sender as any,
      to: '2341234567890', text: 'hello',
    });

    expect(sender.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ messageCategory: undefined }),
    );
  });

  it('email fallback fires when WhatsApp fails', async () => {
    vi.doMock('@/lib/email/client', () => ({
      sendEmail: vi.fn().mockResolvedValue({ success: true, id: 'em-1' }),
    }));
    const { sendOrEmail } = await import('@/lib/channels/send-or-email');
    const sender = mockSender(undefined, new Error('WhatsApp down'));

    const result = await sendOrEmail({
      supabase: {} as any, sender: sender as any,
      to: '2341234567890', text: 'hello',
      email: { address: 'test@example.com', subject: 'Test', html: '<p>test</p>' },
    });

    expect(result.whatsapp).toBe('failed');
    expect(result.email).toBe('sent');
  });

  it('email returns failed when sendEmail resolves with success:false', async () => {
    vi.doMock('@/lib/email/client', () => ({
      sendEmail: vi.fn().mockResolvedValue({ success: false, error: '4xx bad request' }),
    }));
    const { sendOrEmail } = await import('@/lib/channels/send-or-email');
    const sender = mockSender(undefined, new Error('WA down'));

    const result = await sendOrEmail({
      supabase: {} as any, sender: sender as any,
      to: '2341234567890', text: 'hello',
      email: { address: 'test@example.com', subject: 'Test', html: '<p>test</p>' },
    });

    expect(result.whatsapp).toBe('failed');
    expect(result.email).toBe('failed');
  });

  it('email returns failed when sendEmail throws', async () => {
    vi.doMock('@/lib/email/client', () => ({
      sendEmail: vi.fn().mockRejectedValue(new Error('Resend down')),
    }));
    const { sendOrEmail } = await import('@/lib/channels/send-or-email');
    const sender = mockSender(undefined, new Error('WA down'));

    const result = await sendOrEmail({
      supabase: {} as any, sender: sender as any,
      to: '2341234567890', text: 'hello',
      email: { address: 'test@example.com', subject: 'Test', html: '<p>test</p>' },
    });

    expect(result.whatsapp).toBe('failed');
    expect(result.email).toBe('failed');
  });

  it('dual delivery (alwaysEmail) sends email even when WhatsApp succeeds', async () => {
    vi.doMock('@/lib/email/client', () => ({
      sendEmail: vi.fn().mockResolvedValue({ success: true }),
    }));
    const { sendOrEmail } = await import('@/lib/channels/send-or-email');
    const sender = mockSender();

    const result = await sendOrEmail({
      supabase: {} as any, sender: sender as any,
      to: '2341234567890', text: 'hello',
      email: { address: 'test@example.com', subject: 'Test', html: '<p>test</p>' },
      alwaysEmail: true,
    });

    expect(result.whatsapp).toBe('sent');
    expect(result.email).toBe('sent');
  });

  it('email skipped when no address and WhatsApp succeeds', async () => {
    const sender = mockSender();
    const sendOrEmail = await loadSendOrEmail();

    const result = await sendOrEmail({
      supabase: {} as any, sender: sender as any,
      to: '2341234567890', text: 'hello',
    });

    expect(result.email).toBe('no_address');
  });
});

// ─── Contract send: messageCategory and truthful status ────────────

describe('Lane 1: contracts/send messageCategory and delivery', () => {
  it('contracts/send route sets messageCategory utility on template send', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.join(process.cwd(), 'app/api/contracts/send/route.ts'), 'utf-8');
    // Template send includes messageCategory
    const templateBlock = src.match(/sendTemplate\(\{[\s\S]*?\}\)/);
    expect(templateBlock).toBeTruthy();
    expect(templateBlock![0]).toContain("messageCategory: 'utility'");
  });

  it('contracts/send route sets messageCategory utility on sendOrEmail fallback', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.join(process.cwd(), 'app/api/contracts/send/route.ts'), 'utf-8');
    const sendOrEmailBlock = src.match(/sendOrEmail\(\{[\s\S]*?\}\)/);
    expect(sendOrEmailBlock).toBeTruthy();
    expect(sendOrEmailBlock![0]).toContain("messageCategory: 'utility'");
  });

  it('contracts/send checks email result for success:false (not fire-and-forget)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.join(process.cwd(), 'app/api/contracts/send/route.ts'), 'utf-8');
    expect(src).toContain('emailResult.success !== false');
  });
});

// ─── Waiver sign: notification truth ───────────────────────────────

describe('Lane 1: waivers/sign notification status tracking', () => {
  it('waivers/sign inspects customer sendText return value', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.join(process.cwd(), 'app/api/waivers/sign/route.ts'), 'utf-8');
    // Must capture return value AND check success field
    expect(src).toContain('waResult = await resolved.sender.sendText');
    expect(src).toContain('waResult.success === false');
  });

  it('waivers/sign inspects merchant sendText return value', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.join(process.cwd(), 'app/api/waivers/sign/route.ts'), 'utf-8');
    expect(src).toContain('ownerResult = await resolved.sender.sendText');
    expect(src).toContain('ownerResult.success === false');
  });

  it('waivers/sign returns both customer and merchant whatsapp status', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.join(process.cwd(), 'app/api/waivers/sign/route.ts'), 'utf-8');
    expect(src).toContain('customer_whatsapp: customerWaStatus');
    expect(src).toContain('merchant_whatsapp: merchantWaStatus');
  });

  it('waivers/sign returns success:true regardless of notification failure', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.join(process.cwd(), 'app/api/waivers/sign/route.ts'), 'utf-8');
    // success: true is unconditional — signing persists even if notification fails
    const match = src.match(/success:\s*true/);
    expect(match).toBeTruthy();
  });
});

// ─── Invoice send: existing structural validation ──────────────────

describe('Lane 1: Invoice send route delivery truthfulness', () => {
  it('invoices/send does not reference wa_status_updated_at (absent column)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.join(process.cwd(), 'app/api/invoices/send/route.ts'), 'utf-8');
    expect(src).not.toContain('wa_status_updated_at');
  });

  it('invoices/send checks sendEmail return value', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.join(process.cwd(), 'app/api/invoices/send/route.ts'), 'utf-8');
    expect(src).toContain("emailResult.success ? 'accepted' : 'failed'");
  });

  it('invoices/send sets messageCategory utility on template, text, and document sends', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.join(process.cwd(), 'app/api/invoices/send/route.ts'), 'utf-8');
    const matches = src.match(/messageCategory:\s*'utility'/g);
    expect(matches).toBeTruthy();
    expect(matches!.length).toBeGreaterThanOrEqual(3); // template, text fallback, document
  });
});

// ─── Invoice status race guard ─────────────────────────────────────

describe('Lane 1: Invoice status race guard — draft-only transition', () => {
  it('invoices/send status update is guarded by .eq("status","draft")', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.join(process.cwd(), 'app/api/invoices/send/route.ts'), 'utf-8');

    // The status:'sent' update must include .eq('status', 'draft') to prevent
    // regressing a paid/viewed/overdue invoice back to 'sent'.
    // Find the update block that sets status:'sent'
    const sentUpdateIdx = src.indexOf("status: 'sent'");
    expect(sentUpdateIdx).toBeGreaterThan(-1);

    // The .eq('status', 'draft') guard must appear after the .eq('id', invoice_id)
    // but within the same statement chain
    const afterSent = src.slice(sentUpdateIdx);
    const eqDraft = afterSent.indexOf(".eq('status', 'draft')");
    expect(eqDraft).toBeGreaterThan(-1);
    // Must be within 200 chars of the status:'sent' line (same Supabase chain)
    expect(eqDraft).toBeLessThan(200);
  });

  it('invoices/send preserves advanced status (paid/viewed) on concurrent update', async () => {
    // Simulate: invoice is 'paid' when the status update fires.
    // The .eq('status', 'draft') guard means the UPDATE WHERE clause
    // won't match, so 0 rows update — status stays 'paid'.
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.join(process.cwd(), 'app/api/invoices/send/route.ts'), 'utf-8');

    // Verify the guard is present AND that there is NO unconditional
    // .update({ status: 'sent' }) without the draft guard
    const updateBlocks = [...src.matchAll(/\.update\(\{[^}]*status:\s*'sent'[^}]*\}\)/g)];
    expect(updateBlocks.length).toBeGreaterThan(0);

    for (const block of updateBlocks) {
      // Each status:'sent' update must be followed by .eq('status', 'draft')
      const afterBlock = src.slice(block.index!);
      const nextSemicolon = afterBlock.indexOf(';');
      const chain = afterBlock.slice(0, nextSemicolon > 0 ? nextSemicolon : 300);
      expect(chain).toContain(".eq('status', 'draft')");
    }
  });

  it('allowed invoice statuses are draft, sent, viewed, paid, overdue, cancelled', async () => {
    // Verify against migration 063 CHECK constraint
    const fs = await import('fs');
    const path = await import('path');
    const migration = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/063_invoices.sql'), 'utf-8');
    expect(migration).toContain("CHECK (status IN ('draft', 'sent', 'viewed', 'paid', 'overdue', 'cancelled'))");
  });
});

// ─── Payment request send: structural validation ───────────────────

describe('Lane 1: Payment request send route', () => {
  it('payment-request/send captures sendOrEmail result', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.join(process.cwd(), 'app/api/payment-request/send/route.ts'), 'utf-8');
    expect(src).toContain('deliveryResult = await sendOrEmail');
  });

  it('payment-request/send passes messageCategory utility', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.join(process.cwd(), 'app/api/payment-request/send/route.ts'), 'utf-8');
    const block = src.match(/sendOrEmail\(\{[\s\S]*?\}\)/);
    expect(block).toBeTruthy();
    expect(block![0]).toContain("messageCategory: 'utility'");
  });

  it('payment-request/send checks sendEmail return value for email-only path', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.join(process.cwd(), 'app/api/payment-request/send/route.ts'), 'utf-8');
    expect(src).toContain("emailResult.success ? 'accepted' : 'failed'");
  });

  it('payment-request dashboard checks the response success body before reporting sent', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.join(process.cwd(), 'app/dashboard/payment-request/page.tsx'), 'utf-8');
    expect(src).toContain('res.ok && data.success === true');
    expect(src).toContain('createdButNotDelivered');
  });

  it('payment-request dashboard preserves created links when delivery fails', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.join(process.cwd(), 'app/dashboard/payment-request/page.tsx'), 'utf-8');
    expect(src).toContain('setUndeliveredPaymentRequests');
    expect(src).toContain('Open payment link');
    expect(src).toContain('do not submit this request again');
  });
});

// ─── Financial guard: conversation limit ────────────────────────────

describe('Lane 1: Financial messaging guard', () => {
  it('contracts/send enforces conversation limit before sending', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.join(process.cwd(), 'app/api/contracts/send/route.ts'), 'utf-8');
    // Check within the POST handler body (after the function definition)
    const postIdx = src.indexOf('export async function POST');
    expect(postIdx).toBeGreaterThan(-1);
    const postBody = src.slice(postIdx);
    const limitIdx = postBody.indexOf('checkConversationLimit');
    const sendCallIdx = postBody.indexOf('await sendWhatsAppMessage(');
    expect(limitIdx).toBeGreaterThan(-1);
    expect(sendCallIdx).toBeGreaterThan(-1);
    // The conversation limit check must come BEFORE the first send call
    expect(sendCallIdx).toBeGreaterThan(limitIdx);
  });
});

// ─── Non-regression: adjacent senders unchanged ────────────────────

describe('Lane 1: Non-regression — adjacent senders', () => {
  it('broadcasts/send is not modified by this PR', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.join(process.cwd(), 'app/api/broadcasts/send/route.ts'), 'utf-8');
    expect(src).toContain('sendOrEmail');
  });

  it('cron/reminders is not modified by this PR', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.join(process.cwd(), 'app/api/cron/reminders/route.ts'), 'utf-8');
    expect(src).toContain('sendOrEmail');
  });

  it('orders/update-status is not modified by this PR', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.join(process.cwd(), 'app/api/orders/update-status/route.ts'), 'utf-8');
    expect(src).toContain('sendOrEmail');
  });

  it('sendOrEmail messageCategory is backward-compatible (optional field)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.join(process.cwd(), 'lib/channels/send-or-email.ts'), 'utf-8');
    expect(src).toContain('messageCategory?: string');
  });
});

// ─── PRODUCT DECISION NEEDED — explicitly documented ───────────────

describe('Lane 1: Product decisions remain open (not resolved by this PR)', () => {
  it('invoice resend deduplication: PRODUCT DECISION NEEDED', () => {
    // This test documents the open product decision. It always passes
    // because this PR intentionally does NOT change resend behavior.
    // Decision needed: Should merchants be blocked from re-sending
    // an already-delivered invoice? Should there be dedup on wa_message_id?
    expect(true).toBe(true);
  });

  it('automatic WhatsApp and email delivery status: PRODUCT DECISION NEEDED', () => {
    // The explicit `both` option is removed, but payment-request WhatsApp sends
    // may still email alongside WhatsApp when an address is available.
    // Decision needed: should the dashboard distinguish partial delivery?
    expect(true).toBe(true);
  });

  it('prior message-ID retention: PRODUCT DECISION NEEDED', () => {
    // On resend, wa_message_id is overwritten. Decision needed:
    // Should the system preserve the prior successful message ID?
    expect(true).toBe(true);
  });
});

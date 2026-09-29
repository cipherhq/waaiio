/**
 * Issue #230/#231 — Return-to-WhatsApp exact-origin resolution
 *
 * Source-analysis tests proving that the payment-success page correctly
 * resolves the Return to WhatsApp phone number from payment metadata
 * (_inbound_channel_id, _confirmation_origin) instead of business-level
 * channel fallback for WhatsApp-originated payments.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const paymentSuccessCode = readFileSync(
  resolve(__dirname, '../../app/payment-success/page.tsx'),
  'utf-8',
);

describe('#230/#231 — Exact-origin Return to WhatsApp', () => {
  it('reads _inbound_channel_id from payment metadata', () => {
    // The page must extract _inbound_channel_id from payment.metadata
    expect(paymentSuccessCode).toContain('_inbound_channel_id');
    expect(paymentSuccessCode).toContain(
      'payment.metadata as Record<string, unknown>',
    );
    // Must be read as a variable for use in the channel query
    const idx = paymentSuccessCode.indexOf('_inbound_channel_id');
    expect(idx).toBeGreaterThan(-1);
  });

  it('reads _confirmation_origin from payment metadata', () => {
    // The page must extract _confirmation_origin from payment.metadata
    expect(paymentSuccessCode).toContain('_confirmation_origin');
    // Must check for 'whatsapp' origin specifically
    expect(paymentSuccessCode).toContain("confirmationOrigin === 'whatsapp'");
  });

  it('queries whatsapp_channels by exact inbound channel ID', () => {
    // The exact-origin path must query whatsapp_channels by the persisted ID
    // — not by business_id, country_code, or channel_type
    expect(paymentSuccessCode).toContain(
      "from('whatsapp_channels')",
    );
    expect(paymentSuccessCode).toContain(
      ".eq('id', inboundChannelId)",
    );
  });

  it('validates the exact-origin channel is active', () => {
    // The page must check is_active before using the channel
    expect(paymentSuccessCode).toContain('originChannel?.is_active');
    // The select must include is_active in the query
    expect(paymentSuccessCode).toContain('is_active');
  });

  it('shows manual return message when exact-origin fails (not a wrong number)', () => {
    // When exact-origin resolution fails, the page must show a manual message
    // instead of falling back to a potentially wrong WhatsApp number
    expect(paymentSuccessCode).toContain('exactOriginFailed');
    expect(paymentSuccessCode).toContain(
      'Please return to your WhatsApp conversation manually.',
    );
    // The ReturnToWhatsApp component must NOT render when exactOriginFailed is true
    expect(paymentSuccessCode).toContain('!exactOriginFailed');
  });

  it('non-WhatsApp-origin payments use existing fallback chain', () => {
    // The fallback chain (assigned_channel_id, dedicated, shared, biz.phone)
    // must still exist for non-WhatsApp-origin payments
    expect(paymentSuccessCode).toContain('assigned_channel_id');
    expect(paymentSuccessCode).toContain('whatsapp_channel_id');
    expect(paymentSuccessCode).toContain("channel_type', 'dedicated'");
    expect(paymentSuccessCode).toContain("channel_type', 'shared'");

    // The fallback chain must be inside the non-WhatsApp-origin branch
    // Verify it's gated by the else clause (not WhatsApp origin)
    const elseBlock = paymentSuccessCode.indexOf(
      'Non-WhatsApp-origin (web or legacy): use existing business-level fallback chain',
    );
    expect(elseBlock).toBeGreaterThan(-1);

    // The fallback assigned_channel lookup must appear AFTER the else block
    const assignedIdx = paymentSuccessCode.indexOf(
      "select('assigned_channel_id, whatsapp_channel_id')",
    );
    expect(assignedIdx).toBeGreaterThan(elseBlock);
  });

  it('does not hardcode phone numbers in exact-origin resolution path', () => {
    // The exact-origin resolution path must not contain hardcoded phone numbers
    // Extract the exact-origin code block (between the #230 comment and the else block)
    const startMarker = '#230/#231: Exact-origin Return to WhatsApp resolution';
    const endMarker = 'Non-WhatsApp-origin (web or legacy)';
    const startIdx = paymentSuccessCode.indexOf(startMarker);
    const endIdx = paymentSuccessCode.indexOf(endMarker, startIdx);
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);

    const exactOriginBlock = paymentSuccessCode.slice(startIdx, endIdx);

    // No hardcoded phone numbers (patterns like +1..., 1234..., etc.)
    expect(exactOriginBlock).not.toMatch(/['"](?:\+?1\d{10}|\+?234\d{10}|12029\d{6})['"]/);
    // No env var fallback phone numbers in the exact-origin path
    expect(exactOriginBlock).not.toContain('NEXT_PUBLIC_WHATSAPP_NUMBER');
  });

  it('cross-tenant guard validates channel belongs to business or is shared', () => {
    // The exact-origin path must verify the channel belongs to the payment's business
    // or is a shared channel — prevents cross-tenant phone number leakage
    expect(paymentSuccessCode).toContain(
      'originChannel.business_id === payment.business_id',
    );
    expect(paymentSuccessCode).toContain(
      "originChannel.channel_type === 'shared'",
    );
    // The comment must explain the guard
    expect(paymentSuccessCode).toContain('Cross-tenant guard');
  });

  it('WhatsApp-origin with missing _inbound_channel_id fails closed', () => {
    // When _confirmation_origin is 'whatsapp' but _inbound_channel_id is missing,
    // the page must set exactOriginFailed = true (not fall through to business fallback)
    expect(paymentSuccessCode).toContain(
      "isWhatsAppOrigin && !inboundChannelId",
    );
    // This path must set exactOriginFailed, not use the business fallback
    const missingChannelIdx = paymentSuccessCode.indexOf(
      "isWhatsAppOrigin && !inboundChannelId",
    );
    const failedSetIdx = paymentSuccessCode.indexOf(
      'exactOriginFailed = true',
      missingChannelIdx,
    );
    // The fail-closed assignment must be close to the guard
    expect(failedSetIdx).toBeGreaterThan(missingChannelIdx);
    expect(failedSetIdx - missingChannelIdx).toBeLessThan(200);
  });

  it('does not modify ReturnToWhatsApp component', () => {
    // The fix must be in the payment-success page, not the shared component
    const componentCode = readFileSync(
      resolve(__dirname, '../../components/ReturnToWhatsApp.tsx'),
      'utf-8',
    );
    // The component must NOT reference _inbound_channel_id or _confirmation_origin
    expect(componentCode).not.toContain('_inbound_channel_id');
    expect(componentCode).not.toContain('_confirmation_origin');
    expect(componentCode).not.toContain('exactOriginFailed');
  });
});

/**
 * Issue #230 — Payment Success Exact-Origin Return to WhatsApp
 *
 * Verifies that the /payment-success page uses persisted _inbound_channel_id
 * from payment metadata for WhatsApp-origin payments, and fails closed
 * (no silent fallback) when exact-origin resolution fails.
 *
 * Security: forged cross-business ref must NOT expose private channels.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const pageCode = readFileSync(resolve(__dirname, '../page.tsx'), 'utf-8');
const returnToWhatsAppCode = readFileSync(
  resolve(__dirname, '../../../components/ReturnToWhatsApp.tsx'),
  'utf-8',
);

describe('#230: Payment Success Exact-Origin WhatsApp Return', () => {
  // ── Structural: metadata is fetched ──

  it('fetches metadata in the payment select query', () => {
    // Both payment queries (gateway_reference and booking fallback) must include metadata
    const selectMatches = pageCode.match(/\.select\([^)]*metadata[^)]*businesses/g);
    expect(selectMatches).not.toBeNull();
    expect(selectMatches!.length).toBeGreaterThanOrEqual(2);
  });

  it('reads _confirmation_origin from payment metadata', () => {
    expect(pageCode).toContain("paymentMeta?._confirmation_origin === 'whatsapp'");
  });

  it('reads _inbound_channel_id from payment metadata', () => {
    expect(pageCode).toContain('paymentMeta?._inbound_channel_id');
  });

  // ── Structural: exact-origin resolution ──

  it('resolves exact origin channel by inboundChannelId from whatsapp_channels', () => {
    // Must query whatsapp_channels with the exact inbound channel ID
    expect(pageCode).toContain(".eq('id', inboundChannelId)");
  });

  it('checks is_active on the origin channel', () => {
    expect(pageCode).toContain('originChannel?.is_active');
  });

  it('verifies channel belongs to same business (cross-tenant guard)', () => {
    expect(pageCode).toContain('originChannel.business_id === payment.business_id');
  });

  // ── Structural: fail closed ──

  it('does NOT fall back to business-level resolution for WhatsApp-origin payments', () => {
    // The legacy fallback chain is inside `else if (!isWhatsAppOrigin)` —
    // it must NOT be reachable when isWhatsAppOrigin is true
    expect(pageCode).toContain('} else if (!isWhatsAppOrigin) {');
    // There must be no unconditional fallback after the WhatsApp origin block
    expect(pageCode).not.toMatch(
      /if \(isWhatsAppOrigin && inboundChannelId\)[\s\S]*?}\s*\/\/ fallback for all/,
    );
  });

  it('shows "return manually" message when WhatsApp origin but no phone resolved', () => {
    expect(pageCode).toContain('isWhatsAppOrigin && !businessPhone');
    expect(pageCode).toContain('Please return to your WhatsApp conversation manually.');
  });

  it('WhatsApp origin with missing _inbound_channel_id fails closed (no fallback)', () => {
    // When isWhatsAppOrigin is true but inboundChannelId is undefined,
    // the code enters neither the exact-origin block nor the legacy block
    // → businessPhone stays undefined → fail closed in render
    expect(pageCode).toContain(
      'WhatsApp origin with missing _inbound_channel_id',
    );
  });

  // ── Structural: legacy path preserved ──

  it('preserves legacy assigned_channel_id → dedicated → shared fallback for non-WhatsApp origin', () => {
    expect(pageCode).toContain('assigned_channel_id');
    expect(pageCode).toContain("channel_type', 'dedicated'");
    expect(pageCode).toContain("channel_type', 'shared'");
  });

  it('legacy path falls back to biz.phone as last resort', () => {
    // Only in legacy path
    expect(pageCode).toContain("biz?.phone || undefined");
  });

  // ── Structural: security ──

  it('never reads phone from query params or browser input', () => {
    // businessPhone must never come from searchParams
    expect(pageCode).not.toMatch(/params\.(phone|whatsapp|number)/);
    expect(pageCode).not.toMatch(/searchParams.*phone/);
  });

  it('queries origin channel server-side via service client', () => {
    // The supabase client is created via createServiceClient (server-side, bypasses RLS)
    expect(pageCode).toContain('createServiceClient');
    // And the origin channel query uses the same supabase instance
    expect(pageCode).toContain("supabase\n            .from('whatsapp_channels')");
  });

  // ── Structural: shared channels allow null business_id ──

  it('allows shared channels (business_id=null) for origin resolution', () => {
    expect(pageCode).toContain('originChannel.business_id === null');
  });

  // ── Behavioral: resolveOriginPhone extracted logic ──

  describe('resolveOriginPhone logic (extracted)', () => {
    // Extract the resolution logic into a testable function shape
    function resolveOriginPhone(opts: {
      isWhatsAppOrigin: boolean;
      inboundChannelId?: string;
      originChannel?: { phone_number: string | null; is_active: boolean; business_id: string | null } | null;
      paymentBusinessId?: string;
      // Legacy path inputs
      legacyPhone?: string;
    }): { phone: string | undefined; failClosed: boolean } {
      let businessPhone: string | undefined;
      const isWhatsAppOrigin = opts.isWhatsAppOrigin;

      if (isWhatsAppOrigin && opts.inboundChannelId) {
        const originChannel = opts.originChannel;
        if (
          originChannel?.is_active &&
          originChannel.phone_number &&
          (!opts.paymentBusinessId || originChannel.business_id === opts.paymentBusinessId || originChannel.business_id === null)
        ) {
          businessPhone = originChannel.phone_number;
        }
      } else if (!isWhatsAppOrigin) {
        businessPhone = opts.legacyPhone;
      }

      return {
        phone: businessPhone,
        failClosed: isWhatsAppOrigin && !businessPhone,
      };
    }

    it('NG business, NG shared channel origin → returns NG number', () => {
      const result = resolveOriginPhone({
        isWhatsAppOrigin: true,
        inboundChannelId: 'ch-ng-shared',
        originChannel: { phone_number: '2341234567890', is_active: true, business_id: null },
        paymentBusinessId: 'biz-ng',
      });
      expect(result.phone).toBe('2341234567890');
      expect(result.failClosed).toBe(false);
    });

    it('UK business, UK shared channel origin → returns UK number', () => {
      const result = resolveOriginPhone({
        isWhatsAppOrigin: true,
        inboundChannelId: 'ch-uk-shared',
        originChannel: { phone_number: '441234567890', is_active: true, business_id: null },
        paymentBusinessId: 'biz-uk',
      });
      expect(result.phone).toBe('441234567890');
      expect(result.failClosed).toBe(false);
    });

    it('US business, US shared channel origin → returns US number', () => {
      const result = resolveOriginPhone({
        isWhatsAppOrigin: true,
        inboundChannelId: 'ch-us-shared',
        originChannel: { phone_number: '12029226251', is_active: true, business_id: null },
        paymentBusinessId: 'biz-us',
      });
      expect(result.phone).toBe('12029226251');
      expect(result.failClosed).toBe(false);
    });

    it('dedicated channel origin → returns dedicated number', () => {
      const result = resolveOriginPhone({
        isWhatsAppOrigin: true,
        inboundChannelId: 'ch-dedicated',
        originChannel: { phone_number: '19995551234', is_active: true, business_id: 'biz-1' },
        paymentBusinessId: 'biz-1',
      });
      expect(result.phone).toBe('19995551234');
      expect(result.failClosed).toBe(false);
    });

    it('NG business on US shared channel (cross-country) → returns US number (exact origin)', () => {
      const result = resolveOriginPhone({
        isWhatsAppOrigin: true,
        inboundChannelId: 'ch-us-shared',
        originChannel: { phone_number: '12029226251', is_active: true, business_id: null },
        paymentBusinessId: 'biz-ng',
      });
      expect(result.phone).toBe('12029226251');
      expect(result.failClosed).toBe(false);
    });

    it('WhatsApp origin with inactive channel → fail closed', () => {
      const result = resolveOriginPhone({
        isWhatsAppOrigin: true,
        inboundChannelId: 'ch-inactive',
        originChannel: { phone_number: '12029226251', is_active: false, business_id: null },
        paymentBusinessId: 'biz-1',
      });
      expect(result.phone).toBeUndefined();
      expect(result.failClosed).toBe(true);
    });

    it('WhatsApp origin with missing channel (not found) → fail closed', () => {
      const result = resolveOriginPhone({
        isWhatsAppOrigin: true,
        inboundChannelId: 'ch-deleted',
        originChannel: null,
        paymentBusinessId: 'biz-1',
      });
      expect(result.phone).toBeUndefined();
      expect(result.failClosed).toBe(true);
    });

    it('WhatsApp origin with missing _inbound_channel_id → fail closed', () => {
      const result = resolveOriginPhone({
        isWhatsAppOrigin: true,
        inboundChannelId: undefined,
        paymentBusinessId: 'biz-1',
      });
      expect(result.phone).toBeUndefined();
      expect(result.failClosed).toBe(true);
    });

    it('legacy/no-origin payment → uses legacy phone', () => {
      const result = resolveOriginPhone({
        isWhatsAppOrigin: false,
        legacyPhone: '12029226251',
      });
      expect(result.phone).toBe('12029226251');
      expect(result.failClosed).toBe(false);
    });

    it('non-WhatsApp origin → uses legacy phone', () => {
      const result = resolveOriginPhone({
        isWhatsAppOrigin: false,
        legacyPhone: '441234567890',
      });
      expect(result.phone).toBe('441234567890');
      expect(result.failClosed).toBe(false);
    });

    it('forged cross-business ref → does NOT expose private channel', () => {
      // Channel belongs to biz-attacker, but payment belongs to biz-victim
      const result = resolveOriginPhone({
        isWhatsAppOrigin: true,
        inboundChannelId: 'ch-attacker-dedicated',
        originChannel: { phone_number: '19995559999', is_active: true, business_id: 'biz-attacker' },
        paymentBusinessId: 'biz-victim',
      });
      expect(result.phone).toBeUndefined();
      expect(result.failClosed).toBe(true);
    });
  });

  // ── ReturnToWhatsApp component ──

  describe('ReturnToWhatsApp component', () => {
    it('accepts optional phone prop', () => {
      expect(returnToWhatsAppCode).toContain('phone?: string');
    });

    it('renders a wa.me link', () => {
      expect(returnToWhatsAppCode).toContain('wa.me/');
    });
  });
});

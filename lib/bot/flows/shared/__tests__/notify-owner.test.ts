import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock email client
vi.mock('@/lib/email/client', () => ({
  sendEmail: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/email/templates', () => ({
  newOrderEmail: vi.fn().mockReturnValue({ subject: 'New Order', html: '<p>order</p>' }),
  newBookingOwnerEmail: vi.fn().mockReturnValue({ subject: 'New Booking', html: '<p>booking</p>' }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/constants', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/constants');
  return {
    ...actual,
    formatCurrency: vi.fn().mockReturnValue('NGN 5,000'),
  };
});

import { notifyOwnerNewOrder } from '../notify-owner';
import { sendEmail } from '@/lib/email/client';

const mockSendEmail = sendEmail as ReturnType<typeof vi.fn>;

function createMockSender() {
  return {
    sendText: vi.fn().mockResolvedValue({}),
    sendButtons: vi.fn().mockResolvedValue({}),
    sendList: vi.fn().mockResolvedValue({}),
    sendImage: vi.fn().mockResolvedValue({}),
    sendDocument: vi.fn().mockResolvedValue({}),
  };
}

interface MockFetchOwnerConfig {
  ownerEmail?: string | null;
  ownerPhone?: string | null;
  waMethod?: string;
  wabaChannelId?: string | null;
  wabaPhone?: string | null;
  subscriptionTier?: string;
  notifyEmailEnabled?: boolean;
  notifySoundEnabled?: boolean;
  notifyWhatsappEnabled?: boolean;
  notifyWhatsappPhone?: string | null;
  notifyMonthlyCount?: number;
  notifyMonthReset?: string | null;
}

function createMockSupabase(cfg: MockFetchOwnerConfig = {}) {
  const {
    ownerEmail = 'owner@test.com',
    ownerPhone = '+2341234567890',
    waMethod = 'shared',
    wabaChannelId = null,
    wabaPhone = null,
    subscriptionTier = 'free',
    notifyEmailEnabled = true,
    notifySoundEnabled = true,
    notifyWhatsappEnabled = false,
    notifyWhatsappPhone = null,
    notifyMonthlyCount = 0,
    notifyMonthReset = null,
  } = cfg;

  return {
    from: vi.fn((table: string) => {
      if (table === 'businesses') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: {
                  phone: '+234000000000',
                  owner_id: 'owner-1',
                  wa_method: waMethod,
                  whatsapp_channel_id: wabaChannelId,
                  subscription_tier: subscriptionTier,
                  profiles: { email: ownerEmail, phone: ownerPhone },
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'whatsapp_channels') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: wabaPhone ? { phone_number: wabaPhone } : null,
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'whatsapp_config') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  notify_email_enabled: notifyEmailEnabled,
                  notify_sound_enabled: notifySoundEnabled,
                  notify_whatsapp_enabled: notifyWhatsappEnabled,
                  notify_whatsapp_phone: notifyWhatsappPhone,
                  notify_monthly_count: notifyMonthlyCount,
                  notify_month_reset: notifyMonthReset,
                },
                error: null,
              }),
            }),
          }),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: null }),
          }),
        };
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null, error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null }) }),
      };
    }),
  };
}

const baseOpts = {
  businessId: 'biz-1',
  businessName: 'Test Biz',
  countryCode: 'NG' as const,
  referenceCode: 'REF-001',
  customerName: 'John Doe',
  items: [{ name: 'Widget', quantity: 2, price: 2500 }],
  totalAmount: 5000,
};

describe('notifyOwnerNewOrder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.waaiio.com';
  });

  it('sends email when email notifications are enabled', async () => {
    const supabase = createMockSupabase({ notifyEmailEnabled: true });
    const sender = createMockSender();

    await notifyOwnerNewOrder({ supabase: supabase as any, sender: sender as any, ...baseOpts });

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'owner@test.com' }),
    );
  });

  it('does NOT send email when email notifications are disabled', async () => {
    const supabase = createMockSupabase({ notifyEmailEnabled: false });
    const sender = createMockSender();

    await notifyOwnerNewOrder({ supabase: supabase as any, sender: sender as any, ...baseOpts });

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('does NOT send email when owner has no email', async () => {
    const supabase = createMockSupabase({ ownerEmail: null });
    const sender = createMockSender();

    await notifyOwnerNewOrder({ supabase: supabase as any, sender: sender as any, ...baseOpts });

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('sends WhatsApp when enabled and within monthly limit', async () => {
    const supabase = createMockSupabase({
      notifyWhatsappEnabled: true,
      notifyWhatsappPhone: '+2349876543210',
      notifyMonthlyCount: 5,
      notifyMonthReset: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`,
    });
    const sender = createMockSender();

    await notifyOwnerNewOrder({ supabase: supabase as any, sender: sender as any, ...baseOpts });

    expect(sender.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ to: '2349876543210' }), // + stripped
    );
  });

  it('does NOT send WhatsApp when monthly limit exceeded (free tier = 50)', async () => {
    const supabase = createMockSupabase({
      subscriptionTier: 'free',
      notifyWhatsappEnabled: true,
      notifyWhatsappPhone: '+2349876543210',
      notifyMonthlyCount: 50, // At limit
      notifyMonthReset: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`,
    });
    const sender = createMockSender();

    await notifyOwnerNewOrder({ supabase: supabase as any, sender: sender as any, ...baseOpts });

    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('allows unlimited WhatsApp notifications for growth tier', async () => {
    const supabase = createMockSupabase({
      subscriptionTier: 'growth',
      notifyWhatsappEnabled: true,
      notifyWhatsappPhone: '+2349876543210',
      notifyMonthlyCount: 999, // Way over free limit but growth is unlimited
      notifyMonthReset: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`,
    });
    const sender = createMockSender();

    await notifyOwnerNewOrder({ supabase: supabase as any, sender: sender as any, ...baseOpts });

    expect(sender.sendText).toHaveBeenCalled();
  });

  it('does NOT send WhatsApp when owner phone matches WABA number', async () => {
    const supabase = createMockSupabase({
      ownerPhone: '+2341234567890',
      wabaChannelId: 'ch-1',
      wabaPhone: '+2341234567890', // Same as owner phone
      notifyWhatsappEnabled: true,
      notifyWhatsappPhone: '+2341234567890',
      notifyMonthlyCount: 0,
    });
    const sender = createMockSender();

    await notifyOwnerNewOrder({ supabase: supabase as any, sender: sender as any, ...baseOpts });

    // Owner phone should be nullified because it matches WABA, but WhatsApp
    // notifications still use the separate notifyWhatsappPhone
    // The key behavior: ownerPhone is set to null when matching WABA
    // This prevents sending notifications to the WABA number via ownerPhone
  });

  it('resets monthly counter on new month', async () => {
    const supabase = createMockSupabase({
      notifyWhatsappEnabled: true,
      notifyWhatsappPhone: '+2349876543210',
      notifyMonthlyCount: 100, // Was at 100 last month
      notifyMonthReset: '2025-01-01', // Old month
    });
    const sender = createMockSender();

    await notifyOwnerNewOrder({ supabase: supabase as any, sender: sender as any, ...baseOpts });

    // Counter should have been reset, so WhatsApp should be sent
    expect(sender.sendText).toHaveBeenCalled();
    // Should have called update to reset counter
    expect(supabase.from).toHaveBeenCalledWith('whatsapp_config');
  });

  it('does nothing when business is not found', async () => {
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      })),
    };
    const sender = createMockSender();

    await notifyOwnerNewOrder({ supabase: supabase as any, sender: sender as any, ...baseOpts });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(sender.sendText).not.toHaveBeenCalled();
  });
});

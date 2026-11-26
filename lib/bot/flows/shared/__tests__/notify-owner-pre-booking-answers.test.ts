import { describe, it, expect, vi, beforeEach } from 'vitest';

// Real email template (not mocked) so the test reads the actual email the owner gets.
vi.mock('@/lib/merchant-notifications/compatibility', () => ({
  hasMerchantNotificationIntent: vi.fn().mockResolvedValue(false),
  hasStoppedMerchantNotifications: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue({}) }));
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

import { notifyOwnerNewBooking } from '../notify-owner';
import { sendEmail } from '@/lib/email/client';

function db() {
  const chain = (data: unknown) => {
    const q: Record<string, unknown> = {};
    q.select = () => q; q.eq = () => q; q.update = () => q;
    q.single = async () => ({ data, error: null });
    q.maybeSingle = async () => ({ data, error: null });
    q.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve);
    return q;
  };
  return {
    from: (table: string) => {
      if (table === 'businesses') return chain({ phone: '+2340000000000', owner_id: 'o1', wa_method: 'shared', whatsapp_channel_id: null, subscription_tier: 'growth', metadata: {}, profiles: { email: 'owner@test.com', phone: '+2341111111111' } });
      if (table === 'whatsapp_config') return chain({ notify_email_enabled: true, notify_whatsapp_enabled: true, notify_whatsapp_phone: '+2342222222222', notify_monthly_count: 0, notify_month_reset: '2999-01-01' });
      return chain(null);
    },
    rpc: async () => ({ data: true, error: null }),
  };
}

const sender = () => ({ sendText: vi.fn().mockResolvedValue({}) });
const base = {
  businessId: 'b1', businessName: 'Mama Put', countryCode: 'NG' as const, referenceCode: 'BK-1',
  customerName: 'Ada', date: 'Sat 1 Dec', time: '19:00', quantity: 2, quantityLabel: 'guests',
};

describe('owner new-booking notification — pre-booking answers', () => {
  beforeEach(() => vi.mocked(sendEmail).mockClear());

  it('email and WhatsApp list each answer as "Question: Answer", escaped in the email', async () => {
    const s = sender();
    const answers = [
      { label: 'Any dietary needs or allergies?', answer: 'Nut allergy <b>severe</b>' },
      { label: 'Earlier question', answer: 'Window seat' },
    ];
    await notifyOwnerNewBooking({ ...base, supabase: db() as never, sender: s as never, preBookingAnswers: answers });

    const html = vi.mocked(sendEmail).mock.calls[0][0].html as string;
    expect(html).toContain('Any dietary needs or allergies?');
    expect(html).toContain('Nut allergy &lt;b&gt;severe&lt;/b&gt;');
    expect(html).not.toContain('<b>severe</b>');
    expect(html).toContain('Earlier question');
    expect(html).toContain('Window seat');

    const text = s.sendText.mock.calls[0][0].text as string;
    expect(text).toContain('Pre-booking answers');
    expect(text).toContain('Any dietary needs or allergies?: Nut allergy <b>severe</b>');
    expect(text).toContain('Earlier question: Window seat');
  });

  it('shows no answers section when the customer gave none', async () => {
    const s = sender();
    await notifyOwnerNewBooking({ ...base, supabase: db() as never, sender: s as never, preBookingAnswers: [] });
    expect(vi.mocked(sendEmail).mock.calls[0][0].html).not.toContain('Earlier question');
    expect(s.sendText.mock.calls[0][0].text).not.toContain('Pre-booking answers');
  });

  it('keeps a very long answer short in the WhatsApp alert', async () => {
    const s = sender();
    await notifyOwnerNewBooking({ ...base, supabase: db() as never, sender: s as never, preBookingAnswers: [{ label: 'Q', answer: 'x'.repeat(5000) }] });
    const text = s.sendText.mock.calls[0][0].text as string;
    expect(text.length).toBeLessThan(1000);
    expect(text).toContain('Q: ' + 'x'.repeat(299) + '…');
  });
});

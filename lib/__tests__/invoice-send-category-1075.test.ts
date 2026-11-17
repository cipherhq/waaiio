/**
 * #1075 — POST /api/invoices/send message categories (handler level).
 *
 * The approved invoice template stays a `utility` (paid) message. The plain-text
 * fallback and the PDF document are not templates, so WhatsApp does not bill
 * them: they are sent as `service`. Only Supabase, the channel and the PDF/email
 * helpers are synthetic; the real route runs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({ template: vi.fn(), text: vi.fn(), document: vi.fn() }));
const INVOICE = {
  id: 'inv-1', business_id: 'biz-1', customer_phone: '+2348012345678', customer_name: 'Ada', reference_code: 'INV-1',
  total_amount: 1000, currency: 'NGN', invoice_items: [], status: 'draft', created_at: '2026-11-16T00:00:00Z',
};
const BIZ = { id: 'biz-1', name: 'Biz', owner_id: 'owner', country_code: 'NG', logo_url: null, subscription_tier: 'growth' };

function chain(data: unknown) {
  const c: Record<string, unknown> = {};
  for (const k of ['select', 'eq', 'update', 'insert', 'order', 'limit', 'in', 'is']) c[k] = () => c;
  c.single = async () => ({ data, error: null });
  c.maybeSingle = async () => ({ data, error: null });
  c.then = (resolve: (v: unknown) => unknown) => resolve({ data, error: null });
  return c;
}
const tableData = (table: string) => (table === 'invoices' ? INVOICE : table === 'businesses' ? BIZ : null);

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({
  auth: { getUser: async () => ({ data: { user: { id: 'owner' } } }) },
  from: (t: string) => chain(tableData(t)),
}) }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({
  from: (t: string) => chain(tableData(t)),
  rpc: async () => ({ data: INVOICE, error: null }),
  storage: { from: () => ({ upload: async () => ({ error: null }), createSignedUrl: async () => ({ data: { signedUrl: 'https://files.example.test/inv.pdf' } }) }) },
}) }));
vi.mock('@/lib/capabilities/api-guard', () => ({ requireCapability: async () => ({ allowed: true }) }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null, getRateLimitKey: () => 'key' }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/bot/conversation-guard', () => ({ checkConversationLimit: async () => ({ allowed: true }) }));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: async () => ({ invoice_expiry_days: 30 }) }));
vi.mock('@/lib/pdf/invoice-pdf-generator', () => ({ generateInvoicePdf: async () => Buffer.from('pdf') }));
vi.mock('@/lib/pdf/localize-pdf', () => ({ resolvePdfLabels: async () => null }));
vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn(async () => ({ success: true })) }));
vi.mock('@/lib/email/templates', () => ({ invoiceEmail: () => ({ subject: 's', html: 'h' }) }));
vi.mock('@/lib/channels/channel-resolver', () => ({ ChannelResolver: class {
  async resolveByBusinessId() { return { sender: { sendTemplate: m.template, sendText: m.text, sendDocument: m.document } }; }
  async getSharedChannelForCountry() { return null; }
} }));
import { POST } from '@/app/api/invoices/send/route';

const send = () => POST(new NextRequest('https://example.test/api/invoices/send', {
  method: 'POST', body: JSON.stringify({ invoice_id: 'inv-1', channel: 'whatsapp' }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  m.template.mockResolvedValue({ success: true, messageId: 'wamid.template' });
  m.text.mockResolvedValue({ success: true, messageId: 'wamid.text' });
  m.document.mockResolvedValue({ success: true, messageId: 'wamid.doc' });
});

describe('#1075 invoice send categories', () => {
  it('template stays utility (paid); the PDF document is a free service message', async () => {
    expect((await send()).status).toBe(200);
    expect(m.template).toHaveBeenCalledWith(expect.objectContaining({ templateName: 'invoice_payment_request', messageCategory: 'utility' }));
    expect(m.text).not.toHaveBeenCalled();
    expect(m.document).toHaveBeenCalledWith(expect.objectContaining({ messageCategory: 'service' }));
  });

  it('when the template fails, the plain-text fallback is a free service message', async () => {
    m.template.mockRejectedValue(new Error('template not approved'));
    expect((await send()).status).toBe(200);
    expect(m.text).toHaveBeenCalledTimes(1);
    expect(m.text).toHaveBeenCalledWith(expect.objectContaining({ messageCategory: 'service' }));
    expect(m.document).toHaveBeenCalledWith(expect.objectContaining({ messageCategory: 'service' }));
  });
});

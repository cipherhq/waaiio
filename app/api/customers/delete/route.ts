import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest } from '@/lib/api-auth';
import { logAudit } from '@/lib/audit/log';
import { logger } from '@/lib/logger';
import * as crypto from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GDPR Article 17 — Right to Erasure
 *
 * Anonymizes (not hard-deletes) a customer's PII across all tables
 * for a specific business. Financial records are preserved for
 * accounting/legal compliance — only PII fields are nulled.
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Rename business_id to businessId for authenticateRequest
  if (body.business_id && !body.businessId) {
    body.businessId = body.business_id;
  }

  const auth = await authenticateRequest(request, {
    requireBusinessOwnership: true,
    businessIdKey: 'businessId',
    body,
  });
  if (auth instanceof NextResponse) return auth;
  const { user, businessId, service } = auth;

  const customerPhone = body.customer_phone as string | undefined;
  if (!customerPhone || typeof customerPhone !== 'string') {
    return NextResponse.json({ error: 'customer_phone is required' }, { status: 400 });
  }

  // Hash the phone so we can prevent re-creation but can't reverse to PII
  const phoneHash = crypto.createHash('sha256').update(customerPhone).digest('hex').slice(0, 16);
  const anonymizedPhone = `deleted_${phoneHash}`;

  const counts: Record<string, number> = {};

  try {
    // 1. Anonymize customer_profiles
    const { data: profileData } = await service
      .from('customer_profiles')
      .update({
        name: null,
        email: null,
        phone: anonymizedPhone,
        notes: null,
        tags: null,
      })
      .eq('business_id', businessId)
      .eq('phone', customerPhone)
      .select('id');
    counts.customer_profiles = profileData?.length ?? 0;

    // 2. Anonymize bookings — keep financial data (deposit_amount, status)
    const { data: bookingData } = await service
      .from('bookings')
      .update({
        guest_name: null,
        guest_email: null,
        guest_phone: null,
      })
      .eq('business_id', businessId)
      .eq('guest_phone', customerPhone)
      .select('id');
    counts.bookings = bookingData?.length ?? 0;

    // 3. Anonymize orders — keep total, status
    const { data: orderData } = await service
      .from('orders')
      .update({
        customer_name: null,
        customer_email: null,
        customer_phone: null,
      })
      .eq('business_id', businessId)
      .eq('customer_phone', customerPhone)
      .select('id');
    counts.orders = orderData?.length ?? 0;

    // 4. Clean chat_conversations — delete messages, anonymize name
    const { data: convData } = await service
      .from('chat_conversations')
      .select('id')
      .eq('business_id', businessId)
      .eq('customer_phone', customerPhone);

    if (convData && convData.length > 0) {
      const convIds = convData.map((c: { id: string }) => c.id);
      await service
        .from('chat_messages')
        .delete()
        .in('conversation_id', convIds);

      await service
        .from('chat_conversations')
        .update({ customer_name: null })
        .in('id', convIds);

      counts.chat_conversations = convData.length;
    } else {
      counts.chat_conversations = 0;
    }

    // 5. Deactivate bot sessions
    const { data: sessionData } = await service
      .from('bot_sessions')
      .update({ is_active: false })
      .eq('business_id', businessId)
      .eq('phone', customerPhone)
      .eq('is_active', true)
      .select('id');
    counts.bot_sessions = sessionData?.length ?? 0;

    // Audit log
    await logAudit(service, {
      businessId: businessId!,
      userId: user.id,
      action: 'delete',
      entityType: 'customer',
      changes: {
        customer_phone_hash: phoneHash,
        anonymized_records: counts,
      },
    });

    const totalAnonymized = Object.values(counts).reduce((s, n) => s + n, 0);
    logger.info(`[CUSTOMER-DELETE] Anonymized ${totalAnonymized} records for phone hash ${phoneHash} in business ${businessId}`);

    return NextResponse.json({
      success: true,
      anonymized: counts,
      total: totalAnonymized,
    });
  } catch (error) {
    logger.error('[CUSTOMER-DELETE] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

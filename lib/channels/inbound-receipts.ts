import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

const CUSTOMER_TYPES = new Set(['text', 'interactive', 'button', 'audio', 'image', 'video', 'document', 'location', 'contacts', 'sticker', 'reaction', 'order']);
/** Called only by the signature-verified Meta webhook, with its resolved transport. */
export async function recordInboundReceipt(db: SupabaseClient, channel: { id: string; phone_number: string }, message: { id?: string; from?: string; timestamp?: string; type?: string }) {
  const phone = (message.from || '').replace(/^\+/, '');
  const milliseconds = Number(message.timestamp) * 1000;
  if (!CUSTOMER_TYPES.has(message.type || '') || !message.id || message.id.length > 512 ||
      !/^[1-9]\d{6,14}$/.test(phone) || phone === channel.phone_number.replace(/\D/g, '') ||
      !Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > Date.now()) return;
  try {
    // Never update: a redelivery cannot extend the original provider window.
    const { error } = await db.from('whatsapp_inbound_receipts').insert({
      channel_id: channel.id, message_id: message.id, sender_phone: phone,
      provider_timestamp: new Date(milliseconds).toISOString(),
    });
    if (error && error.code !== '23505') logger.warn('[INBOUND-RECEIPT] Evidence unavailable');
  } catch { logger.warn('[INBOUND-RECEIPT] Evidence unavailable'); }
}

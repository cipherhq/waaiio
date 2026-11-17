// Photo/PDF answers for Custom Flow questions (#1085). Called by the Meta
// webhook only for image and document messages, before its existing
// "I can't process images or files yet" reply. Returns false — leaving that
// reply unchanged — unless the customer's latest active custom-flow step is a
// Photo or PDF question of an entitled business.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { CustomFlowEngine } from './engine';

export interface InboundMedia { id: string; mimeType?: string }
export type MediaDownloader = (mediaId: string, maxBytes: number) => Promise<{ ok: true; buffer: Buffer } | { ok: false; reason: string }>;

/** The image or document of a Meta message, if it has one. */
export function inboundMedia(msg: { image?: { id?: string; mime_type?: string }; document?: { id?: string; mime_type?: string } }): InboundMedia | null {
  const media = msg.image ?? msg.document;
  return media?.id ? { id: media.id, mimeType: media.mime_type } : null;
}

export async function handleCustomFlowFile(args: {
  supabase: SupabaseClient;
  sender: MessageSender;
  /** Raw inbound transport key (DB-005). */
  from: string;
  /** The business this number belongs to, when the channel is dedicated. */
  businessId: string | null;
  media: InboundMedia;
  download: MediaDownloader;
}): Promise<boolean> {
  // The customer's most recent active custom-flow chat; on a dedicated
  // number only that business's. The engine re-checks everything else.
  let query = args.supabase.from('custom_flow_sessions').select('business_id')
    .eq('whatsapp_number', args.from).eq('is_active', true);
  if (args.businessId) query = query.eq('business_id', args.businessId);
  const { data, error } = await query.order('updated_at', { ascending: false }).limit(1).maybeSingle();
  if (error || !data?.business_id) return false;
  const engine = new CustomFlowEngine({ supabase: args.supabase, sender: args.sender });
  return engine.handleFileMessage({ businessId: data.business_id as string, from: args.from, media: args.media, download: args.download });
}

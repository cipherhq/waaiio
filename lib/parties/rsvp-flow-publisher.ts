/**
 * #1005 PR 3c: publish the reusable party RSVP form (M540) on one WhatsApp Business Account.
 *
 * Mirrors the merchant native-form publisher: a unique (waba_id, revision) row claims the attempt,
 * provider mutations are never retried automatically, and any unclear outcome is left as
 * needs_review. An admin may resume a needs_review row only when its Meta asset is known, so a
 * retry never creates a second asset.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { partyRsvpFlowJson, partyRsvpFlowRevision } from './rsvp-flow';
import { partyRsvpFormsEnabled } from '@/lib/whatsapp-forms/release-gate';
import type { FlowAssetResult, FlowPublishResult, FlowStatusResult, FlowUploadResult } from '@/lib/whatsapp-forms/meta-flow-asset';

export interface PartyRsvpFlowAssets {
  create(name: string): Promise<FlowAssetResult>;
  upload(id: string, json: Record<string, unknown>): Promise<FlowUploadResult>;
  publish(id: string): Promise<FlowPublishResult>;
  status(id: string): Promise<FlowStatusResult>;
}

export type PartyRsvpPublishOutcome =
  | { status: 'not_enabled' }
  | { status: 'unavailable'; reason: string }
  | { status: 'published'; publicationId: string; metaFlowId: string; alreadyPublished: boolean }
  | { status: 'needs_review'; publicationId: string; reason: string; validationErrors?: { type: string; message: string }[] };

interface Row { id: string; status: string; meta_flow_id: string | null }
const TABLE = 'party_rsvp_flow_publications';

/** Meta's validation messages describe the Flow JSON only; keep a short, bounded copy for the admin. */
function validationSummary(errors: FlowUploadResult['validationErrors']) {
  return (errors || []).slice(0, 20).map(e => ({
    type: String(e?.error_type || e?.error || 'error').slice(0, 80), message: String(e?.message || '').slice(0, 300),
  }));
}

export async function publishPartyRsvpFlow(
  db: SupabaseClient, wabaId: string, assets: PartyRsvpFlowAssets, options: { resume?: boolean } = {},
): Promise<PartyRsvpPublishOutcome> {
  if (!partyRsvpFormsEnabled()) return { status: 'not_enabled' };
  if (!/^[0-9]{1,64}$/.test(wabaId)) return { status: 'unavailable', reason: 'WhatsApp account is not configured.' };
  const flowJson = partyRsvpFlowJson();
  const revision = partyRsvpFlowRevision();

  const lookup = async () => {
    const { data, error } = await db.from(TABLE).select('id,status,meta_flow_id').eq('waba_id', wabaId).eq('revision', revision).maybeSingle();
    if (error) throw new Error('lookup');
    return data as Row | null;
  };

  let row: Row | null;
  try { row = await lookup(); } catch { return { status: 'unavailable', reason: 'Publication lookup unavailable.' }; }
  if (row?.status === 'published' && row.meta_flow_id) {
    return { status: 'published', publicationId: row.id, metaFlowId: row.meta_flow_id, alreadyPublished: true };
  }

  let flowId: string;
  if (!row) {
    const { data, error } = await db.from(TABLE).insert({ waba_id: wabaId, revision, flow_json: flowJson })
      .select('id,status,meta_flow_id').single();
    if (error) {
      if (error.code !== '23505') return { status: 'unavailable', reason: 'Publication could not be reserved.' };
      return { status: 'unavailable', reason: 'Another publication of this form is in progress. Check again shortly.' };
    }
    row = data as Row;
    try {
      const asset = await assets.create(`Waaiio party RSVP ${revision.slice(0, 12)}`);
      flowId = asset.flowId;
      const { data: bound, error: bindError } = await db.from(TABLE).update({ meta_flow_id: flowId, status: 'draft' })
        .eq('id', row.id).eq('status', 'creating').select('id');
      if (bindError || !bound?.length) throw new Error('bind');
    } catch {
      // The provider may or may not have created an asset. Never guess; an admin checks Meta first.
      await markNeedsReview(db, row.id);
      return { status: 'needs_review', publicationId: row.id, reason: 'The Meta form asset could not be confirmed. Check Meta before retrying.' };
    }
  } else {
    // An unfinished attempt is never repeated automatically.
    if (!options.resume || row.status !== 'needs_review' || !row.meta_flow_id) {
      return { status: 'needs_review', publicationId: row.id,
        reason: row.meta_flow_id ? 'A previous attempt did not finish. Resume it after checking Meta.' : 'A previous attempt did not finish and its Meta asset is unknown. Check Meta before retrying.' };
    }
    // Claim the resume so two admins cannot run it at once.
    const { data: claimed, error: claimError } = await db.from(TABLE).update({ status: 'draft' })
      .eq('id', row.id).eq('status', 'needs_review').select('id');
    if (claimError || !claimed?.length) return { status: 'unavailable', reason: 'Another resume is in progress.' };
    flowId = row.meta_flow_id;
  }

  try {
    const current = await assets.status(flowId);
    if (current.wabaId !== wabaId) throw new Error('account');
    if (current.status !== 'PUBLISHED') {
      if (current.status !== 'DRAFT') throw new Error('state');
      const upload = await assets.upload(flowId, flowJson);
      if (!upload.success) {
        await markNeedsReview(db, row.id);
        return { status: 'needs_review', publicationId: row.id, reason: 'Meta rejected the RSVP form layout.',
          validationErrors: validationSummary(upload.validationErrors) };
      }
      const published = await assets.publish(flowId);
      if (!published.success) throw new Error('publish');
      const after = await assets.status(flowId);
      if (after.status !== 'PUBLISHED' || after.wabaId !== wabaId) throw new Error('verify');
    }
    const { data: done, error: doneError } = await db.from(TABLE)
      .update({ status: 'published', published_at: new Date().toISOString() })
      .eq('id', row.id).eq('status', 'draft').eq('meta_flow_id', flowId).select('id');
    if (doneError || !done?.length) throw new Error('save');
    return { status: 'published', publicationId: row.id, metaFlowId: flowId, alreadyPublished: false };
  } catch {
    await markNeedsReview(db, row.id);
    return { status: 'needs_review', publicationId: row.id, reason: 'Publication was not completed. Check Meta, then resume.' };
  }
}

async function markNeedsReview(db: SupabaseClient, id: string) {
  await db.from(TABLE).update({ status: 'needs_review' }).eq('id', id).neq('status', 'published');
}

/** Read-only: the current form version's publication on this account, for the admin check-in. */
export async function partyRsvpFlowPublicationStatus(db: SupabaseClient, wabaId: string) {
  const revision = partyRsvpFlowRevision();
  const { data, error } = await db.from(TABLE).select('id,status,meta_flow_id,created_at,published_at')
    .eq('waba_id', wabaId).eq('revision', revision).maybeSingle();
  if (error) throw new Error('Publication lookup unavailable.');
  return { enabled: partyRsvpFormsEnabled(), revision, publication: data };
}

import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { nativeFormsEnabled } from '@/lib/whatsapp-forms/release-gate';
import { compilePublication } from '@/lib/whatsapp-forms/publication';
import { ownedNativeForm, nativeError } from '@/lib/whatsapp-forms/owner-access';
import { rateLimitResponseAsync } from '@/lib/rate-limit';

export async function POST(request: NextRequest) {
  let body;
  try { body = await request.json(); } catch { return nativeError('Invalid request.', 400); }
  if (!body || typeof body !== 'object') return nativeError('Invalid request.', 400);
  const access = await ownedNativeForm(body.businessId, body.formId);
  if (access.response) return access.response;
  if (!nativeFormsEnabled()) return nativeError('Native WhatsApp forms are not enabled yet.', 503);
  const { form, businessId, formId } = access;
  if (!form.is_active) return nativeError('Activate this form before publishing.');
  const limited = await rateLimitResponseAsync(`native-publish:${businessId}`, 5, 60_000);
  if (limited) return limited;
  let compiled;
  try { compiled = compilePublication(form); } catch (error) { return nativeError(error instanceof Error ? error.message : 'Invalid native form.'); }
  const db = createServiceClient({ noStore: true });
  const eventId = compiled.config.settings?.registration_event_id;
  if (eventId) {
    const { data: event, error: eventError } = await db.from('events').select('id').eq('id', eventId)
      .eq('business_id', businessId).eq('status', 'published').gte('date', new Date().toISOString().slice(0, 10)).maybeSingle();
    if (eventError) return nativeError('Event lookup unavailable.', 503);
    if (!event) return nativeError('Choose an upcoming published event belonging to this business.');
  }
  const resolved = await new ChannelResolver(db).resolveByBusinessId(businessId);
  const channel = resolved?.channel;
  if (!resolved?.cloud || !channel?.phone_number_id || !channel.waba_id) return nativeError('Connect an active WhatsApp number first.');
  // A unique database row claims this exact revision. An ambiguous provider attempt
  // cannot be automatically repeated by concurrent requests or a browser retry.
  const { data: publication, error } = await db.from('native_form_publications').insert({
    form_id: formId, business_id: businessId, channel_id: channel.id,
    phone_number_id: channel.phone_number_id, waba_id: channel.waba_id,
    config: compiled.config, flow_json: compiled.flowJson, revision: compiled.revision,
  }).select('id').single();
  if (error) {
    if (error.code !== '23505') return nativeError('Publication could not be reserved.', 503);
    const { data: existing, error: lookupError } = await db.from('native_form_publications').select('id,status')
      .eq('form_id', formId).eq('business_id', businessId).eq('revision', compiled.revision)
      .eq('channel_id', channel.id).eq('phone_number_id', channel.phone_number_id).eq('waba_id', channel.waba_id).maybeSingle();
    if (lookupError) return nativeError('Publication lookup unavailable.', 503);
    if (existing?.status === 'published') return NextResponse.json({ published: true, publicationId: existing.id });
    return nativeError('Publication is pending or needs provider review. No duplicate asset was created.', 409);
  }
  try {
    const assets = resolved.cloud.nativeFlowAssets(channel.waba_id);
    const asset = await assets.create(`Waaiio ${form.title} ${compiled.revision.slice(0, 12)}`);
    const { error: saveError } = await db.from('native_form_publications').update({ meta_flow_id: asset.flowId, status: 'draft' }).eq('id', publication.id).eq('status', 'creating');
    if (saveError) throw new Error('Asset binding could not be saved.');
    const upload = await assets.upload(asset.flowId, compiled.flowJson);
    if (!upload.success) throw new Error('Meta rejected the form definition.');
    const published = await assets.publish(asset.flowId);
    if (!published.success) throw new Error('Meta did not confirm publication.');
    const status = await assets.status(asset.flowId);
    if (status.status !== 'PUBLISHED' || status.wabaId !== channel.waba_id) throw new Error('Publication account could not be verified.');
    // Resolve again after provider IO, so a channel switch never publishes into a
    // different business connection. Database authority checks config under lock.
    const current = await new ChannelResolver(db).resolveByBusinessId(businessId);
    if (current?.channel.id !== channel.id || current.channel.phone_number_id !== channel.phone_number_id || current.channel.waba_id !== channel.waba_id) throw new Error('Connection changed.');
    const { data: saved, error: finishError } = await db.rpc('complete_native_form_publication_591', { p_id: publication.id });
    if (finishError || saved !== true) throw new Error('Form changed during publication.');
    return NextResponse.json({ published: true, publicationId: publication.id }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    await db.from('native_form_publications').update({ status: 'needs_review' }).eq('id', publication.id).neq('status', 'published');
    return nativeError('Publication was not completed. Provider state needs review before retrying.', 502);
  }
}

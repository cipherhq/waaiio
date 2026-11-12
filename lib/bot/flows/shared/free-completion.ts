import type { FlowContext } from '../types';

/**
 * Attach only to a successful transaction/enrollment confirmation. The executor
 * persists the marker with that prompt and invokes the callback after sending it.
 * This does not change session ownership or infer success from a flow exit.
 */
export async function prepareFreeCompletion(
  ctx: FlowContext,
  options: { completionKey: string; kind: string; afterSend?: () => Promise<unknown> },
): Promise<(() => Promise<void>) | undefined> {
  const channelId = ctx.session.session_data._inbound_channel_id;
  if (!ctx.business || typeof channelId !== 'string' || !channelId) return undefined;
  const { releaseTransactionFollowupAfterConfirmation, startTransactionFollowup } = await import('@/lib/bot/transaction-followups');
  const input = {
    completionKey: options.completionKey,
    businessId: ctx.business.id,
    phone: ctx.from,
    channelId,
    kind: options.kind,
    lang: ctx.copyLang,
    awaitingConfirmation: true,
  };
  // Persist ownership before the confirmation is emitted. A failed enrollment
  // cannot leave a session marker that suppresses the menu without a durable row.
  await startTransactionFollowup(ctx.supabase, input);
  ctx.session.session_data._transaction_followup_key = options.completionKey;
  return async () => {
    await options.afterSend?.();
    await releaseTransactionFollowupAfterConfirmation(ctx.supabase, input.businessId, input.completionKey);
  };
}

import type { CustomFlowHandoffCapability } from './types';

/** Plain-English names for handoff steps (#1086). No server imports: the builder uses this too. */
export const HANDOFF_FEATURE_NAME: Record<CustomFlowHandoffCapability, string> = {
  ticketing: 'Event tickets',
  giving: 'Giving',
  payment: 'Take a payment',
  chat: 'Talk to a person',
};

/** Sent when the feature is off or the chosen record is gone, past, sold out or inactive. */
export const HANDOFF_UNAVAILABLE_TEXT: Record<CustomFlowHandoffCapability, string> = {
  ticketing: 'Sorry, tickets for this aren’t available right now.',
  giving: 'Sorry, giving isn’t available right now.',
  payment: 'Sorry, payments aren’t available right now.',
  chat: 'Sorry, no one from the team is available to chat right now.',
};

/** The builder's line for where a handoff step passes people on (preview and step settings). */
export function handoffPreviewNote(request: { capability: CustomFlowHandoffCapability; recordName: string | null }): string {
  const feature = HANDOFF_FEATURE_NAME[request.capability] ?? 'your feature';
  const target = request.recordName ? `${feature}: ${request.recordName}` : feature;
  return request.capability === 'chat'
    ? `Next, people continue in ${target}. Their messages appear on your Chat page.`
    : `Next, people continue in ${target}. They see your usual steps and pay the usual way.`;
}

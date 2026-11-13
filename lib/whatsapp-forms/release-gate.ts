/** Server-only rollout switch. Deployment does not authorize provider operations. */
export function nativeFormsEnabled(): boolean {
  return process.env.WHATSAPP_NATIVE_FORMS_ENABLED === 'true';
}

/** #1005: server-only switch for the party RSVP WhatsApp form, separate from merchant native forms. */
export function partyRsvpFormsEnabled(): boolean {
  return process.env.WHATSAPP_PARTY_RSVP_FORMS_ENABLED === 'true';
}

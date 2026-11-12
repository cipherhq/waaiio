/** Server-only rollout switch. Deployment does not authorize provider operations. */
export function nativeFormsEnabled(): boolean {
  return process.env.WHATSAPP_NATIVE_FORMS_ENABLED === 'true';
}

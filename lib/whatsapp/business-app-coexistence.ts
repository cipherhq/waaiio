/**
 * #592 Business App Connect — fail-closed readiness contract.
 * Meta determines per-number / market eligibility during its dedicated
 * coexistence onboarding. Environment variables never prove eligibility.
 */
export type CoexistenceGate =
  | { configured: false; reason: 'disabled' | 'missing_configuration' | 'reused_transfer_configuration'; message: string }
  | { configured: true; reason: 'provider_verification_required'; message: string };

export function evaluateBusinessAppCoexistenceConfig(input: {
  enabled?: string;
  coexistConfigId?: string;
  transferConfigId?: string;
}): CoexistenceGate {
  if (input.enabled !== 'true') {
    return { configured: false, reason: 'disabled',
      message: 'Business App Connect is not enabled for this Waaiio environment.' };
  }
  const coex = input.coexistConfigId?.trim();
  if (!coex || !/^[0-9]{6,32}$/.test(coex)) {
    return { configured: false, reason: 'missing_configuration',
      message: 'A dedicated, Meta-approved Business App coexistence signup configuration is required.' };
  }
  if (coex === input.transferConfigId?.trim()) {
    return { configured: false, reason: 'reused_transfer_configuration',
      message: 'Coexistence cannot use the standard phone-transfer signup configuration.' };
  }
  return {
    configured: true,
    reason: 'provider_verification_required',
    message: 'Meta must verify partner entitlement, the phone number, existing Business app, and country before coexistence can be activated.',
  };
}

/**
 * For deliberate future use after Meta entitlement is established.
 * Reuses the safe v4 code-only contract, but NEVER the standard transfer config.
 * Launching this on a real account remains a separately authorized provider gate.
 */
export function buildCoexistenceSignupOptions(input: {
  enabled?: string; coexistConfigId?: string; transferConfigId?: string;
}): {
  config_id: string; response_type: 'code'; override_default_response_type: true;
  extras: Record<string, never>;
} {
  const gate = evaluateBusinessAppCoexistenceConfig(input);
  if (!gate.configured) throw new Error(gate.message);
  return {
    config_id: input.coexistConfigId!.trim(),
    response_type: 'code',
    override_default_response_type: true,
    extras: {},
  };
}

import posthog from 'posthog-js';
import { PostHog } from 'posthog-node';

// ── Client-side feature flags ────────────────────────────

/**
 * Check a feature flag on the client side (browser).
 * Returns false if PostHog isn't initialized.
 */
export function isFeatureEnabled(flagKey: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return posthog.isFeatureEnabled(flagKey) === true;
  } catch {
    return false;
  }
}

/**
 * Get a feature flag payload on the client side.
 */
export function getFeatureFlagPayload(flagKey: string): unknown {
  if (typeof window === 'undefined') return undefined;
  try {
    return posthog.getFeatureFlagPayload(flagKey);
  } catch {
    return undefined;
  }
}

// ── Server-side feature flags ────────────────────────────

let serverClient: PostHog | null = null;

function getServerClient(): PostHog | null {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return null;
  if (!serverClient) {
    serverClient = new PostHog(key, {
      host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
    });
  }
  return serverClient;
}

/**
 * Check a feature flag on the server side.
 * distinctId is typically the business ID or user ID.
 */
export async function isFeatureEnabledServer(
  flagKey: string,
  distinctId: string,
): Promise<boolean> {
  const client = getServerClient();
  if (!client) return false;
  try {
    return await client.isFeatureEnabled(flagKey, distinctId) === true;
  } catch {
    return false;
  }
}

/**
 * Get all feature flags for a user on the server side.
 */
export async function getAllFlags(
  distinctId: string,
): Promise<Record<string, boolean | string>> {
  const client = getServerClient();
  if (!client) return {};
  try {
    return await client.getAllFlags(distinctId) as Record<string, boolean | string>;
  } catch {
    return {};
  }
}

// ── Flag keys ────────────────────────────────────────────
// Centralize flag names to avoid typos

export const FLAGS = {
  /** Enable LLM intent detection (vs regex-only). Percentage rollout. */
  LLM_INTENT_ENABLED: 'llm-intent-enabled',
  /** Enable multi-language bot translation. */
  BOT_TRANSLATION_ENABLED: 'bot-translation-enabled',
} as const;

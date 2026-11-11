import type { SupabaseClient } from '@supabase/supabase-js';
import { MetaCloudService } from '@/lib/channels/meta-cloud';
import { getLaunchCandidates, resolveChannelCredentials, LaunchConfigError,
  type ChannelCredentials, type LaunchDeliveryConfig, type LaunchDeliveryScope } from './delivery';

/** Read-only provider check. Never substitutes a template or sends a message. */
export async function assertLaunchTemplate(credentials: ChannelCredentials, config: LaunchDeliveryConfig) {
  const accessToken = credentials.meta_access_token || process.env.META_CLOUD_ACCESS_TOKEN;
  const accountId = credentials.waba_id || process.env.META_CLOUD_WABA_ID;
  if (!accessToken || !accountId) throw new LaunchConfigError('Launch sender configuration is incomplete.');
  const cloud = new MetaCloudService({ accessToken, phoneNumberId: credentials.phone_number_id, wabaId: accountId });
  const seen = new Set<string>();
  let after: string | undefined;
  try {
    for (let page = 0; page < 20; page++) {
      const result = await cloud.getTemplates({ limit: 100, fields: 'name,language,status', ...(after ? { after } : {}) });
      if (!Array.isArray(result.data)) throw new Error('Invalid catalog');
      if (result.data.some(t => t.name === config.templateName && t.language === config.templateLanguage && t.status === 'APPROVED')) return;
      if (!result.paging?.next) {
        throw new LaunchConfigError(`Launch template ${config.templateName} (${config.templateLanguage}) is missing or not approved for a selected sender. Check the template before retrying.`);
      }
      after = result.paging.cursors?.after;
      if (!after || seen.has(after)) throw new Error('Invalid pagination');
      seen.add(after);
    }
  } catch (error) {
    if (error instanceof LaunchConfigError) throw error;
    // Provider payloads can contain credentials or account details; do not expose them.
    throw new LaunchConfigError('Unable to verify the launch template with Meta. Try Preview again.');
  }
  throw new LaunchConfigError('Launch template verification exceeded its page limit.');
}

export async function assertLaunchReadiness(supabase: SupabaseClient, config: LaunchDeliveryConfig, scope: LaunchDeliveryScope) {
  const candidates = await getLaunchCandidates(supabase, config.campaignVersion, scope);
  for (const sender of new Set(candidates.map(c => c.receiving_number))) {
    const credentials = await resolveChannelCredentials(supabase, sender);
    if (!credentials) throw new LaunchConfigError('An eligible recipient has no active shared launch sender.');
    await assertLaunchTemplate(credentials, config);
  }
}

export const STAGING_APP_PROJECT_ID = 'prj_h7YmC4fvpxhn429znCy34OjLZ6se';
export const STAGING_SUPABASE_URL = 'https://tqjvrzopvtczxfxiwmnz.supabase.co';

export interface StagingIdentity {
  projectId?: string | null;
  supabaseUrl?: string | null;
}

function normalizeUrl(value: string | null | undefined): string {
  return String(value || '').trim().replace(/\/$/, '');
}

export function isStagingTestMode(
  identity: StagingIdentity = {
    projectId: process.env.VERCEL_PROJECT_ID,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  },
): boolean {
  return identity.projectId === STAGING_APP_PROJECT_ID
    && normalizeUrl(identity.supabaseUrl) === STAGING_SUPABASE_URL;
}

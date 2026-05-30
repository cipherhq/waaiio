import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

/**
 * Consent Tracking API
 * GDPR Article 7 — Conditions for consent
 * CCPA — Right to opt-out
 *
 * GET: return current consent status
 * POST: update consent preferences
 *
 * Stored in profiles.metadata.consent_preferences
 */

interface ConsentPreferences {
  marketing_emails: boolean;
  analytics: boolean;
  ai_processing: boolean;
  updated_at: string;
  policy_version?: string;
  consented_at?: string;
}

const DEFAULT_CONSENT: ConsentPreferences = {
  marketing_emails: false,
  analytics: false,
  ai_processing: true, // needed for core bot functionality
  updated_at: new Date().toISOString(),
};

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const serviceClient = createServiceClient();
    const { data: profile } = await serviceClient
      .from('profiles')
      .select('metadata')
      .eq('id', user.id)
      .maybeSingle();

    const metadata = (profile?.metadata || {}) as Record<string, unknown>;
    const consent = (metadata.consent_preferences || DEFAULT_CONSENT) as ConsentPreferences;

    return NextResponse.json({ consent });
  } catch (error) {
    logger.error('[CONSENT] GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { marketing_emails, analytics, ai_processing } = body;

    // Validate inputs are booleans
    if (
      typeof marketing_emails !== 'boolean' ||
      typeof analytics !== 'boolean' ||
      typeof ai_processing !== 'boolean'
    ) {
      return NextResponse.json(
        { error: 'All consent fields must be boolean values' },
        { status: 400 },
      );
    }

    const serviceClient = createServiceClient();

    // Fetch current profile metadata
    const { data: profile } = await serviceClient
      .from('profiles')
      .select('metadata')
      .eq('id', user.id)
      .maybeSingle();

    const existingMetadata = (profile?.metadata || {}) as Record<string, unknown>;

    // Fetch current privacy policy version from platform_settings
    let policyVersion = '2026-05-23'; // fallback
    const { data: versionRow } = await serviceClient
      .from('platform_settings')
      .select('value')
      .eq('key', 'privacy_version')
      .maybeSingle();

    if (versionRow?.value) {
      // value is stored as JSON string e.g. '"1.0"'
      try {
        policyVersion = JSON.parse(versionRow.value);
      } catch {
        policyVersion = versionRow.value;
      }
    }

    const consentPreferences: ConsentPreferences = {
      marketing_emails,
      analytics,
      ai_processing,
      updated_at: new Date().toISOString(),
      policy_version: policyVersion,
      consented_at: new Date().toISOString(),
    };

    // Merge with existing metadata
    const updatedMetadata = {
      ...existingMetadata,
      consent_preferences: consentPreferences,
    };

    const { error: updateError } = await serviceClient
      .from('profiles')
      .update({ metadata: updatedMetadata })
      .eq('id', user.id);

    if (updateError) {
      logger.error('[CONSENT] Update error:', updateError);
      return NextResponse.json({ error: 'Failed to update consent' }, { status: 500 });
    }

    logger.info(`[CONSENT] User ${user.id} updated consent: marketing=${marketing_emails}, analytics=${analytics}, ai=${ai_processing}`);

    return NextResponse.json({ success: true, consent: consentPreferences });
  } catch (error) {
    logger.error('[CONSENT] POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

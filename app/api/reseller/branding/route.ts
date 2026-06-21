import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

const HEX_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/;
const URL_REGEX = /^https?:\/\/.+/;

interface BrandingConfig {
  logo_url: string | null;
  favicon_url: string | null;
  primary_color: string | null;
  accent_color: string | null;
}

/**
 * GET /api/reseller/branding
 * Returns the current reseller's branding config + company_name + custom_domain.
 */
export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: reseller } = await supabase
      .from('resellers')
      .select('branding, company_name, custom_domain')
      .eq('user_id', user.id)
      .maybeSingle();

    if (!reseller) {
      return NextResponse.json({ error: 'Reseller profile not found' }, { status: 404 });
    }

    const branding: BrandingConfig = {
      logo_url: reseller.branding?.logo_url ?? null,
      favicon_url: reseller.branding?.favicon_url ?? null,
      primary_color: reseller.branding?.primary_color ?? null,
      accent_color: reseller.branding?.accent_color ?? null,
    };

    return NextResponse.json({
      branding,
      company_name: reseller.company_name ?? '',
      custom_domain: reseller.custom_domain ?? null,
    });
  } catch (err) {
    logger.error('[RESELLER_BRANDING] GET error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * PUT /api/reseller/branding
 * Updates branding config + company_name on the resellers table.
 */
export async function PUT(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: reseller } = await supabase
      .from('resellers')
      .select('id, branding')
      .eq('user_id', user.id)
      .maybeSingle();

    if (!reseller) {
      return NextResponse.json({ error: 'Reseller profile not found' }, { status: 404 });
    }

    const body = await request.json();
    const errors: string[] = [];

    // Validate logo_url
    let logo_url: string | null | undefined;
    if (body.logo_url !== undefined) {
      if (body.logo_url === null || body.logo_url === '') {
        logo_url = null;
      } else if (typeof body.logo_url !== 'string' || body.logo_url.length > 500) {
        errors.push('logo_url must be a valid URL (max 500 characters) or null');
      } else if (!URL_REGEX.test(body.logo_url)) {
        errors.push('logo_url must be a valid HTTP/HTTPS URL');
      } else {
        logo_url = body.logo_url;
      }
    }

    // Validate favicon_url
    let favicon_url: string | null | undefined;
    if (body.favicon_url !== undefined) {
      if (body.favicon_url === null || body.favicon_url === '') {
        favicon_url = null;
      } else if (typeof body.favicon_url !== 'string' || body.favicon_url.length > 500) {
        errors.push('favicon_url must be a valid URL (max 500 characters) or null');
      } else if (!URL_REGEX.test(body.favicon_url)) {
        errors.push('favicon_url must be a valid HTTP/HTTPS URL');
      } else {
        favicon_url = body.favicon_url;
      }
    }

    // Validate primary_color
    let primary_color: string | null | undefined;
    if (body.primary_color !== undefined) {
      if (body.primary_color === null || body.primary_color === '') {
        primary_color = null;
      } else if (typeof body.primary_color !== 'string' || !HEX_COLOR_REGEX.test(body.primary_color)) {
        errors.push('primary_color must be a hex color (#XXXXXX) or null');
      } else {
        primary_color = body.primary_color;
      }
    }

    // Validate accent_color
    let accent_color: string | null | undefined;
    if (body.accent_color !== undefined) {
      if (body.accent_color === null || body.accent_color === '') {
        accent_color = null;
      } else if (typeof body.accent_color !== 'string' || !HEX_COLOR_REGEX.test(body.accent_color)) {
        errors.push('accent_color must be a hex color (#XXXXXX) or null');
      } else {
        accent_color = body.accent_color;
      }
    }

    // Validate company_name
    let company_name: string | undefined;
    if (body.company_name !== undefined) {
      if (typeof body.company_name !== 'string' || body.company_name.trim().length === 0) {
        errors.push('company_name must be a non-empty string');
      } else if (body.company_name.length > 200) {
        errors.push('company_name must be 200 characters or fewer');
      } else {
        company_name = body.company_name.trim();
      }
    }

    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join('; ') }, { status: 400 });
    }

    // Merge branding updates with existing branding JSONB
    const existingBranding = (reseller.branding as BrandingConfig) || {};
    const updatedBranding: BrandingConfig = {
      logo_url: logo_url !== undefined ? logo_url : (existingBranding.logo_url ?? null),
      favicon_url: favicon_url !== undefined ? favicon_url : (existingBranding.favicon_url ?? null),
      primary_color: primary_color !== undefined ? primary_color : (existingBranding.primary_color ?? null),
      accent_color: accent_color !== undefined ? accent_color : (existingBranding.accent_color ?? null),
    };

    const updatePayload: Record<string, unknown> = { branding: updatedBranding };
    if (company_name !== undefined) {
      updatePayload.company_name = company_name;
    }

    const { error: updateError } = await supabase
      .from('resellers')
      .update(updatePayload)
      .eq('id', reseller.id);

    if (updateError) {
      logger.error('[RESELLER_BRANDING] Update error:', updateError.message);
      return NextResponse.json({ error: 'Failed to update branding' }, { status: 500 });
    }

    return NextResponse.json({
      branding: updatedBranding,
      ...(company_name !== undefined ? { company_name } : {}),
    });
  } catch (err) {
    logger.error('[RESELLER_BRANDING] PUT error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

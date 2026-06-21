import type { SupabaseClient } from '@supabase/supabase-js';
import { esc } from './templates';

// ─── Types ───────────────────────────────────────────────────────

export interface ResellerBranding {
  logo_url?: string;
  primary_color?: string;
  accent_color?: string;
  company_name: string;
}

// ─── Defaults ────────────────────────────────────────────────────

const DEFAULT_PRIMARY = '#7c3aed';
const DEFAULT_ACCENT = '#F59E0B';

// ─── Partner email wrapper ───────────────────────────────────────

export function wrapPartnerEmail(body: string, branding: ResellerBranding): string {
  const primary = branding.primary_color || DEFAULT_PRIMARY;
  const name = esc(branding.company_name);

  const headerContent = branding.logo_url
    ? `<table cellpadding="0" cellspacing="0" width="100%"><tr>
        <td style="width:40px;padding-right:12px"><img src="${branding.logo_url}" width="36" height="36" style="border-radius:8px;display:block" alt="${name}" /></td>
        <td style="font-size:16px;font-weight:700;color:#ffffff">${name}</td>
      </tr></table>`
    : `<table cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:18px;font-weight:700;color:#ffffff">${name}</td>
      </tr></table>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">
  <!-- Header -->
  <tr>
    <td style="background:${primary};padding:24px 32px">
      ${headerContent}
    </td>
  </tr>
  <!-- Body -->
  <tr>
    <td style="padding:32px">
      ${body}
    </td>
  </tr>
  <!-- Footer -->
  <tr>
    <td style="padding:24px 32px;border-top:1px solid #e4e4e7;text-align:center">
      <p style="margin:0;font-size:12px;color:#a1a1aa">
        &copy; ${new Date().getFullYear()} ${name}. All rights reserved.
      </p>
      <p style="margin:4px 0 0;font-size:11px;color:#d4d4d8">
        Powered by Waaiio
      </p>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ─── Partner CTA button ──────────────────────────────────────────

export function partnerBtn(text: string, url: string, color?: string): string {
  const bg = color || DEFAULT_PRIMARY;
  return `<table cellpadding="0" cellspacing="0" style="margin:24px 0"><tr>
    <td style="background:${bg};border-radius:8px;padding:12px 24px">
      <a href="${url}" style="color:#ffffff;text-decoration:none;font-size:14px;font-weight:600">${text}</a>
    </td>
  </tr></table>`;
}

// ─── Resolve reseller branding from business ─────────────────────

export async function getResellerBranding(
  supabase: SupabaseClient,
  businessId: string,
): Promise<ResellerBranding | null> {
  const { data: business, error: bizError } = await supabase
    .from('businesses')
    .select('reseller_id')
    .eq('id', businessId)
    .limit(1)
    .single();

  if (bizError || !business?.reseller_id) return null;

  const { data: reseller, error: resellerError } = await supabase
    .from('resellers')
    .select('company_name, branding')
    .eq('id', business.reseller_id)
    .limit(1)
    .single();

  if (resellerError || !reseller) return null;

  const branding = reseller.branding as Record<string, string> | null;
  if (!branding || !reseller.company_name) return null;

  return {
    logo_url: branding.logo_url || undefined,
    primary_color: branding.primary_color || undefined,
    accent_color: branding.accent_color || undefined,
    company_name: reseller.company_name,
  };
}

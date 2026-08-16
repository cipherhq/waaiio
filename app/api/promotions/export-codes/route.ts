import { logger } from '@/lib/logger';
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { decryptPromoCode } from '@/lib/promotions/crypto';
import { formatPromoCode } from '@/lib/promotions/normalize';

const PAGE_SIZE = 1000;
// Full export uses 'code' (decrypted, formatted plaintext) — never expose ciphertext
const CSV_HEADER = 'display_suffix,outcome,prize_id,status,claimed_at,claimed_by_phone\n';
const CSV_HEADER_FULL = 'code,display_suffix,outcome,prize_id,status,claimed_at,claimed_by_phone\n';

function escapeCsvField(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const businessId = searchParams.get('businessId');
  const campaignId = searchParams.get('campaignId');
  const exportMode = searchParams.get('export'); // 'full' for plaintext codes
  const format = searchParams.get('format'); // 'json' for paginated dashboard use
  const jsonPage = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const jsonLimit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20', 10)));
  const statusFilter = searchParams.get('status');
  const batchFilter = searchParams.get('batchId');
  const searchQuery = searchParams.get('search')?.trim();

  if (!businessId) {
    return NextResponse.json({ error: 'businessId is required' }, { status: 400 });
  }
  if (!campaignId) {
    return NextResponse.json({ error: 'campaignId is required' }, { status: 400 });
  }

  const service = createServiceClient();

  // Full export requires manage_existing; all other access requires read_history
  const isFull = exportMode === 'full';
  const guard = await requireCapability(supabase, service, {
    businessId,
    userId: user.id,
    capability: 'promo_verification',
    action: isFull ? 'manage_existing' : 'read_history',
  });
  if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

  // Verify campaign belongs to this business
  const { data: campaign } = await service
    .from('promo_campaigns')
    .select('id, name')
    .eq('id', campaignId)
    .eq('business_id', businessId)
    .maybeSingle();

  if (!campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  }

  // JSON mode: paginated listing for the dashboard Codes tab
  if (format === 'json') {
    const offset = (jsonPage - 1) * jsonLimit;
    let q = service
      .from('promo_campaign_codes')
      .select('id, display_suffix, outcome, status, claimed_at, batch_id, prize_id', { count: 'exact' })
      .eq('campaign_id', campaignId)
      .eq('business_id', businessId)
      .order('created_at', { ascending: false });

    if (statusFilter && ['unused', 'claimed', 'void', 'winner', 'try_again'].includes(statusFilter)) {
      if (['winner', 'try_again'].includes(statusFilter)) {
        q = q.eq('outcome', statusFilter);
      } else {
        q = q.eq('status', statusFilter);
      }
    }
    if (batchFilter) {
      q = q.eq('batch_id', batchFilter);
    }
    if (searchQuery) {
      // Search by last 4 chars of normalized code (display_suffix)
      const suffix = searchQuery.toUpperCase().replace(/[\s\-._]/g, '').slice(-4);
      if (suffix.length > 0) {
        q = q.ilike('display_suffix', `%${suffix}%`);
      }
    }

    const { data: codes, count, error: qError } = await q.range(offset, offset + jsonLimit - 1);

    if (qError) {
      logger.error('[PROMOTIONS] export-codes json error:', qError);
      return NextResponse.json({ error: 'Failed to fetch codes' }, { status: 500 });
    }

    const maskedCodes = (codes || []).map((c) => ({
      id: c.id,
      // display_suffix is the last 4 chars of the normalized code — mask the rest
      displayCode: `••••••••${c.display_suffix}`,
      displaySuffix: c.display_suffix,
      outcome: c.outcome,
      status: c.status,
      claimed_at: c.claimed_at,
      batch_id: c.batch_id,
      prize_id: c.prize_id,
    }));

    return NextResponse.json({
      codes: maskedCodes,
      pagination: {
        page: jsonPage,
        limit: jsonLimit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / jsonLimit),
      },
    });
  }

  // CSV export — always select encrypted_code for full export (decrypted server-side)
  const selectColumns = isFull
    ? 'encrypted_code,display_suffix,outcome,prize_id,status,claimed_at,claimed_by_phone'
    : 'display_suffix,outcome,prize_id,status,claimed_at,claimed_by_phone';

  // Paginate through codes and build CSV
  const csvChunks: string[] = [isFull ? CSV_HEADER_FULL : CSV_HEADER];
  let offset = 0;
  let hasMore = true;
  let totalExported = 0;

  // Dynamic select columns — type assertion needed
  type CodeRow = {
    encrypted_code?: string;
    display_suffix: string;
    outcome: string;
    prize_id: string | null;
    status: string;
    claimed_at: string | null;
    claimed_by_phone: string | null;
  };

  while (hasMore) {
    const { data, error } = await service
      .from('promo_campaign_codes')
      .select(selectColumns)
      .eq('campaign_id', campaignId)
      .range(offset, offset + PAGE_SIZE - 1)
      .order('created_at', { ascending: true });

    const codes = data as CodeRow[] | null;

    if (error) {
      logger.error('[PROMOTIONS] export error:', error);
      return NextResponse.json({ error: 'Failed to export codes' }, { status: 500 });
    }

    if (!codes || codes.length === 0) {
      hasMore = false;
      break;
    }

    for (const code of codes) {
      if (isFull) {
        // Decrypt server-side and format for human readability.
        // Never write ciphertext (encrypted_code) or normalized_code_hash to the output.
        const decrypted = code.encrypted_code
          ? formatPromoCode(decryptPromoCode(code.encrypted_code))
          : '';
        csvChunks.push(
          [
            escapeCsvField(decrypted),
            escapeCsvField(code.display_suffix),
            escapeCsvField(code.outcome),
            escapeCsvField(code.prize_id),
            escapeCsvField(code.status),
            escapeCsvField(code.claimed_at),
            escapeCsvField(code.claimed_by_phone),
          ].join(',') + '\n',
        );
      } else {
        csvChunks.push(
          [
            escapeCsvField(code.display_suffix),
            escapeCsvField(code.outcome),
            escapeCsvField(code.prize_id),
            escapeCsvField(code.status),
            escapeCsvField(code.claimed_at),
            escapeCsvField(code.claimed_by_phone),
          ].join(',') + '\n',
        );
      }
    }

    totalExported += codes.length;
    offset += codes.length;
    hasMore = codes.length === PAGE_SIZE;
  }

  // Audit log for full exports — fail-closed: if audit fails, do NOT release plaintext codes
  if (isFull) {
    const { error: auditError } = await service.from('audit_log').insert({
      business_id: businessId,
      user_id: user.id,
      action: 'export',
      entity_type: 'promo_code',
      entity_id: campaignId,
      changes: { export_type: 'full', code_count: totalExported },
    });
    if (auditError) {
      logger.error('[PROMOTIONS] export audit insert failed:', auditError);
      return NextResponse.json(
        { error: 'Export audit recording failed — cannot proceed with sensitive export' },
        { status: 500 },
      );
    }
  }

  const csvContent = csvChunks.join('');
  const safeCampaignName = campaign.name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
  const timestamp = new Date().toISOString().slice(0, 10);
  const filename = `promo_campaign_codes_${safeCampaignName}_${timestamp}.csv`;

  return new NextResponse(csvContent, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}

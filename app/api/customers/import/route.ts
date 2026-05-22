import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest } from '@/lib/api-auth';
import { ensurePlus } from '@/lib/utils/phone';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ContactInput {
  name: string;
  phone: string;
  email?: string;
  tags?: string[];
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const auth = await authenticateRequest(request, {
    requireBusinessOwnership: true,
    businessIdKey: 'businessId',
    body,
  });
  if (auth instanceof NextResponse) return auth;
  const { businessId, service } = auth;

  const contacts = body.contacts as ContactInput[] | undefined;
  if (!Array.isArray(contacts) || contacts.length === 0) {
    return NextResponse.json({ error: 'contacts array is required' }, { status: 400 });
  }

  // Cap at 500 per request to prevent abuse
  if (contacts.length > 500) {
    return NextResponse.json({ error: 'Maximum 500 contacts per import' }, { status: 400 });
  }

  let imported = 0;
  let skipped = 0;
  const errors: Array<{ row: number; reason: string }> = [];

  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i];
    const row = i + 1;

    // Validate phone — required
    const rawPhone = (c.phone || '').replace(/[\s\-()]/g, '');
    if (!rawPhone) {
      errors.push({ row, reason: 'Missing phone number' });
      skipped++;
      continue;
    }
    const phone = ensurePlus(rawPhone);

    // Validate email if provided
    const email = c.email?.trim() || null;
    if (email && !EMAIL_RE.test(email)) {
      errors.push({ row, reason: `Invalid email: ${email}` });
      skipped++;
      continue;
    }

    const name = (c.name || '').trim() || null;
    const tags = Array.isArray(c.tags) ? c.tags.filter(Boolean) : [];

    try {
      // Upsert into customer_profiles — phone + business_id is the natural key
      const { error: upsertError } = await service
        .from('customer_profiles')
        .upsert(
          {
            business_id: businessId,
            phone,
            name: name || undefined,
            email: email || undefined,
            tags: tags.length > 0 ? tags : undefined,
          },
          { onConflict: 'business_id,phone' },
        );

      if (upsertError) {
        logger.error(`[CUSTOMER-IMPORT] Row ${row} upsert error:`, upsertError.message);
        errors.push({ row, reason: 'Database error' });
        skipped++;
      } else {
        imported++;
      }
    } catch (err) {
      logger.error(`[CUSTOMER-IMPORT] Row ${row} exception:`, err);
      errors.push({ row, reason: 'Unexpected error' });
      skipped++;
    }
  }

  return NextResponse.json({ imported, skipped, errors: errors.length > 0 ? errors : undefined });
}

import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { generateSlug, generateBotCode } from '@/lib/constants';

export async function GET(request: NextRequest) {
  const name = request.nextUrl.searchParams.get('name');
  const customCode = request.nextUrl.searchParams.get('bot_code');
  const businessId = request.nextUrl.searchParams.get('business_id');

  if (!name || name.trim().length < 2) {
    return NextResponse.json(
      { available: true, slug: '', bot_code: '', code_available: true },
      { status: 200 },
    );
  }

  try {
    const service = createServiceClient();
    const slug = generateSlug(name);
    const suggestedCode = generateBotCode(name);

    // The code to check — custom if provided, otherwise auto-generated from name
    const codeToCheck = customCode?.trim().toUpperCase().replace(/\s+/g, '-').replace(/[^A-Z0-9-]/g, '').replace(/-+/g, '-').slice(0, 30) || suggestedCode;

    // If a business_id is provided, verify it belongs to the authenticated user
    // and has status='pending'. If valid, exclude it from collision checks so
    // a user resuming onboarding doesn't collide with their own pending business.
    let excludeBusinessId: string | null = null;

    if (businessId) {
      try {
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();

        if (user) {
          const { data: pendingBusiness } = await service
            .from('businesses')
            .select('id')
            .eq('id', businessId)
            .eq('owner_id', user.id)
            .eq('status', 'pending')
            .maybeSingle();

          if (pendingBusiness) {
            excludeBusinessId = pendingBusiness.id;
          }
        }
      } catch {
        // If auth fails, ignore business_id — fall through to normal check
      }
    }

    // Check slug collision
    let slugQuery = service
      .from('businesses')
      .select('slug')
      .eq('slug', slug);
    if (excludeBusinessId) {
      slugQuery = slugQuery.neq('id', excludeBusinessId);
    }
    const { data: slugExists } = await slugQuery.maybeSingle();

    // Check bot_code collision
    let codeQuery = service
      .from('businesses')
      .select('bot_code')
      .eq('bot_code', codeToCheck);
    if (excludeBusinessId) {
      codeQuery = codeQuery.neq('id', excludeBusinessId);
    }
    const { data: codeExists } = await codeQuery.maybeSingle();

    const slugAvailable = !slugExists;
    const codeAvailable = !codeExists;
    const available = slugAvailable && codeAvailable;

    return NextResponse.json({
      available,
      slug,
      bot_code: codeToCheck,
      suggested_code: suggestedCode,
      code_available: codeAvailable,
      slug_available: slugAvailable,
    });
  } catch {
    return NextResponse.json(
      { available: true, slug: '', bot_code: '', code_available: true },
      { status: 200 },
    );
  }
}

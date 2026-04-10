import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { generateSlug, generateBotCode } from '@/lib/constants';

export async function GET(request: NextRequest) {
  const name = request.nextUrl.searchParams.get('name');
  const customCode = request.nextUrl.searchParams.get('bot_code');

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

    // Check slug collision
    const { data: slugExists } = await service
      .from('businesses')
      .select('slug')
      .eq('slug', slug)
      .maybeSingle();

    // Check bot_code collision
    const { data: codeExists } = await service
      .from('businesses')
      .select('bot_code')
      .eq('bot_code', codeToCheck)
      .maybeSingle();

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

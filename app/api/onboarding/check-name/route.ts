import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { generateSlug, generateBotCode } from '@/lib/constants';

export async function GET(request: NextRequest) {
  const name = request.nextUrl.searchParams.get('name');

  if (!name || name.trim().length < 2) {
    return NextResponse.json(
      { available: true, slug: '', bot_code: '' },
      { status: 200 },
    );
  }

  try {
    const service = createServiceClient();
    const slug = generateSlug(name);
    const botCode = generateBotCode(name);

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
      .eq('bot_code', botCode)
      .maybeSingle();

    const available = !slugExists && !codeExists;

    return NextResponse.json({ available, slug, bot_code: botCode });
  } catch {
    return NextResponse.json(
      { available: true, slug: '', bot_code: '' },
      { status: 200 },
    );
  }
}

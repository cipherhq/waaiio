import { NextResponse, type NextRequest } from 'next/server';
import { verifyCronAuth } from '@/lib/cron-auth';

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) {
    const token = request.nextUrl.searchParams.get('token');
    const valid = process.env.INTERNAL_API_TOKEN;
    if (!token || !valid || token !== valid) return authError;
  }

  const wabaId = process.env.META_CLOUD_WABA_ID;
  const accessToken = process.env.META_CLOUD_ACCESS_TOKEN;
  if (!wabaId || !accessToken) {
    return NextResponse.json({ error: 'META vars not set' }, { status: 500 });
  }

  const res = await fetch(
    `https://graph.facebook.com/v22.0/${wabaId}/message_templates?fields=name,status,language&limit=20`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();

  return NextResponse.json({
    templates: (data.data || []).map((t: any) => ({
      name: t.name,
      status: t.status,
      language: t.language,
    })),
  });
}

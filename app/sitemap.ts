import type { MetadataRoute } from 'next';

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';

// Force dynamic so sitemap is generated at request time (needs DB access)
export const dynamic = 'force-dynamic';
export const revalidate = 3600; // Cache for 1 hour

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticPages: MetadataRoute.Sitemap = [
    { url: `${BASE_URL}/`, changeFrequency: 'weekly', priority: 1.0, lastModified: new Date() },
    { url: `${BASE_URL}/features`, changeFrequency: 'weekly', priority: 0.9, lastModified: new Date() },
    { url: `${BASE_URL}/pricing`, changeFrequency: 'weekly', priority: 0.9, lastModified: new Date() },
    { url: `${BASE_URL}/directory`, changeFrequency: 'daily', priority: 0.8, lastModified: new Date() },
    { url: `${BASE_URL}/about`, changeFrequency: 'monthly', priority: 0.8, lastModified: new Date() },
    { url: `${BASE_URL}/contact`, changeFrequency: 'monthly', priority: 0.6, lastModified: new Date() },
    { url: `${BASE_URL}/help`, changeFrequency: 'monthly', priority: 0.5, lastModified: new Date() },
    { url: `${BASE_URL}/terms`, changeFrequency: 'yearly', priority: 0.3, lastModified: new Date() },
    { url: `${BASE_URL}/privacy`, changeFrequency: 'yearly', priority: 0.3, lastModified: new Date() },
    { url: `${BASE_URL}/cookies`, changeFrequency: 'yearly', priority: 0.2, lastModified: new Date() },
    { url: `${BASE_URL}/acceptable-use`, changeFrequency: 'yearly', priority: 0.2, lastModified: new Date() },
    { url: `${BASE_URL}/dpa`, changeFrequency: 'yearly', priority: 0.2, lastModified: new Date() },
  ];

  // Dynamic pages: published events and active businesses with slugs
  let eventPages: MetadataRoute.Sitemap = [];
  let businessPages: MetadataRoute.Sitemap = [];

  try {
    const { createServiceClient } = await import('@/lib/supabase/service');
    const supabase = createServiceClient();

    const [{ data: events }, { data: businesses }] = await Promise.all([
      supabase
        .from('events')
        .select('slug, updated_at')
        .eq('status', 'published')
        .not('slug', 'is', null)
        .order('updated_at', { ascending: false })
        .limit(500),
      supabase
        .from('businesses')
        .select('slug, updated_at')
        .eq('is_active', true)
        .not('slug', 'is', null)
        .order('updated_at', { ascending: false })
        .limit(500),
    ]);

    eventPages = (events || []).map((e) => ({
      url: `${BASE_URL}/e/${e.slug}`,
      changeFrequency: 'daily' as const,
      priority: 0.7,
      lastModified: e.updated_at ? new Date(e.updated_at) : new Date(),
    }));

    businessPages = (businesses || []).map((b) => ({
      url: `${BASE_URL}/b/${b.slug}`,
      changeFrequency: 'weekly' as const,
      priority: 0.6,
      lastModified: b.updated_at ? new Date(b.updated_at) : new Date(),
    }));
  } catch {
    // Graceful fallback — return static pages only if DB unavailable
  }

  return [...staticPages, ...eventPages, ...businessPages];
}

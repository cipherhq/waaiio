import { createServiceClient } from '@/lib/supabase/service';
import DirectoryClient from './DirectoryClient';

/**
 * Server component wrapper for directory page.
 * Pre-renders business names/categories for SEO — search engines see real content.
 * Client component handles interactive filtering.
 */
export default async function DirectoryPage() {
  // Pre-fetch business list for SEO (server-rendered HTML)
  let businessNames: Array<{ name: string; category: string; city: string }> = [];
  try {
    const supabase = createServiceClient();
    const { data } = await supabase
      .from('businesses')
      .select('name, category, city')
      .eq('status', 'active')
      .not('bot_code', 'is', null)
      .order('name')
      .limit(100);
    businessNames = data || [];
  } catch {}

  return (
    <>
      {/* SEO: server-rendered business list visible to crawlers */}
      <noscript>
        <div className="mx-auto max-w-4xl px-4 py-12">
          <h1 className="text-2xl font-bold">Waaiio Business Directory</h1>
          <p className="mt-2 text-gray-600">Discover businesses powered by Waaiio</p>
          <ul className="mt-6 space-y-2">
            {businessNames.map(b => (
              <li key={b.name} className="text-gray-700">
                <strong>{b.name}</strong> — {b.category}{b.city ? `, ${b.city}` : ''}
              </li>
            ))}
          </ul>
        </div>
      </noscript>

      {/* Hidden from visual users but visible to search engines */}
      <div className="sr-only">
        <h2>Businesses on Waaiio</h2>
        {businessNames.map(b => (
          <span key={b.name}>{b.name} {b.category} {b.city} </span>
        ))}
      </div>

      <DirectoryClient />
    </>
  );
}

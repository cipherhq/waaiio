import type { MetadataRoute } from 'next';

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${BASE_URL}/`, changeFrequency: 'weekly', priority: 1.0 },
    { url: `${BASE_URL}/features`, changeFrequency: 'weekly', priority: 0.9 },
    { url: `${BASE_URL}/pricing`, changeFrequency: 'weekly', priority: 0.9 },
    { url: `${BASE_URL}/directory`, changeFrequency: 'daily', priority: 0.8 },
    { url: `${BASE_URL}/about`, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${BASE_URL}/contact`, changeFrequency: 'monthly', priority: 0.6 },
    { url: `${BASE_URL}/terms`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${BASE_URL}/privacy`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${BASE_URL}/cookies`, changeFrequency: 'yearly', priority: 0.2 },
    { url: `${BASE_URL}/acceptable-use`, changeFrequency: 'yearly', priority: 0.2 },
    { url: `${BASE_URL}/dpa`, changeFrequency: 'yearly', priority: 0.2 },
  ];
}

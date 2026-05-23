import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: false,
  },
  poweredBy: false,
  experimental: {
    outputFileTracingIncludes: {
      '/api/webhook/meta-cloud': ['./node_modules/pdfkit/js/data/**/*'],
      '/api/webhook/whatsapp': ['./node_modules/pdfkit/js/data/**/*'],
      '/api/receipts/generate': ['./node_modules/pdfkit/js/data/**/*'],
      '/api/webhooks/route': ['./node_modules/pdfkit/js/data/**/*'],
    },
  },
  async headers() {
    return [
      {
        source: '/dashboard/chat',
        headers: [
          {
            key: 'Permissions-Policy',
            value: 'microphone=(self)',
          },
        ],
      },
      // Cache static marketing pages at CDN edge (revalidate every 60s)
      {
        source: '/(about|pricing|contact|features|help|directory|privacy|terms|dpa|cookies|acceptable-use)',
        headers: [
          { key: 'Cache-Control', value: 'public, s-maxage=60, stale-while-revalidate=300' },
        ],
      },
      // Cache static assets aggressively (1 year, immutable — hashed filenames)
      {
        source: '/_next/static/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
      // Cache public API responses briefly at edge
      {
        source: '/api/directory',
        headers: [
          { key: 'Cache-Control', value: 'public, s-maxage=30, stale-while-revalidate=120' },
        ],
      },
      {
        source: '/api/faq',
        headers: [
          { key: 'Cache-Control', value: 'public, s-maxage=60, stale-while-revalidate=300' },
        ],
      },
      {
        source: '/api/health',
        headers: [
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate' },
        ],
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
});

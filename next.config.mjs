import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: false,
  },
  poweredBy: false,
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.supabase.co',
        pathname: '/storage/v1/object/public/**',
      },
    ],
  },
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
      // Cache OG image generation (expensive PNG, immutable content)
      {
        source: '/api/tickets/image',
        headers: [
          { key: 'Cache-Control', value: 'public, s-maxage=3600, stale-while-revalidate=86400' },
        ],
      },
      {
        source: '/api/receipts/image',
        headers: [
          { key: 'Cache-Control', value: 'public, s-maxage=3600, stale-while-revalidate=86400' },
        ],
      },
      // Cache public event/booking APIs
      {
        source: '/api/events/public/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, s-maxage=10, stale-while-revalidate=30' },
        ],
      },
      {
        source: '/api/bookings/public/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, s-maxage=10, stale-while-revalidate=30' },
        ],
      },
      // New legal pages
      {
        source: '/(dmca|refund-policy|aml-kyc|do-not-sell)',
        headers: [
          { key: 'Cache-Control', value: 'public, s-maxage=60, stale-while-revalidate=300' },
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

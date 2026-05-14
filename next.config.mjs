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
    ];
  },
};

export default withSentryConfig(nextConfig, {
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
});

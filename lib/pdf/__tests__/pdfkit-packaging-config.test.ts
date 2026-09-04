import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const config = readFileSync(resolve(process.cwd(), 'next.config.mjs'), 'utf8');

const pdfkitReachableRoutes = [
  '/api/receipts/generate',
  '/api/invoices/pdf/[id]',
  '/api/invoices/send',
  '/api/contracts/submit',
  '/api/webhook/meta-cloud',
  '/api/bookings/[id]/status',
  '/api/queue/call-next',
  '/api/queue/update',
  '/api/integrations/external-booking',
  '/api/payments/webhook',
  '/api/payments/stripe-webhook',
  '/api/payments/square-webhook',
  '/api/payments/paypal-webhook',
  '/api/webhooks/flutterwave',
  '/api/cron/payment-reconciliation',
  '/api/cron/retry-failed-charges',
] as const;

describe('PDFKit serverless packaging config', () => {
  it('externalizes PDFKit using the Next.js 14 config surface', () => {
    expect(config).toContain("serverComponentsExternalPackages: ['pdfkit']");
  });

  it.each(pdfkitReachableRoutes)('traces PDFKit AFM data for %s', (route) => {
    expect(config).toContain(`'${route}': ['./node_modules/pdfkit/js/data/**/*']`);
  });

  it('does not retain stale tracing entries', () => {
    expect(config).not.toContain("'/api/webhook/whatsapp': ['./node_modules/pdfkit/js/data/**/*']");
    expect(config).not.toContain("'/api/webhooks/route': ['./node_modules/pdfkit/js/data/**/*']");
  });
});

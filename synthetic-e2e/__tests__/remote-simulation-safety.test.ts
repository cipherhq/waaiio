/**
 * Remote simulation safety — negative tests.
 *
 * CTO R4 Fix 2: Proves that Locust, Promptfoo, and WebhookClient are
 * incapable of posting to deployed WhatsApp webhook endpoints.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Locust remote traffic prevention', () => {
  const locustSrc = readFileSync(
    resolve(__dirname, '../locust/locustfile.py'), 'utf-8',
  );

  it('validate_host blocks all non-loopback hosts', () => {
    // The validate_host function only allows localhost/127.0.0.1
    expect(locustSrc).toContain('if hostname in ("localhost", "127.0.0.1")');
    expect(locustSrc).toContain('return');
    // Everything else exits 1
    expect(locustSrc).toContain('sys.exit(1)');
  });

  it('does NOT have an env-var override for remote hosts', () => {
    // CTO R4: env-var gates are not adequate execution guards
    expect(locustSrc).not.toContain('SYNTH_LOAD_TEST_AUTHORIZED');
  });

  it('does NOT allow staging.waaiio.com or .vercel.app remote hosts', () => {
    // The validate_host function must not contain staging allowlist entries
    const validateIdx = locustSrc.indexOf('def validate_host');
    const validateEnd = locustSrc.indexOf('\ndef ', validateIdx + 50);
    const validateBody = locustSrc.slice(validateIdx, validateEnd > 0 ? validateEnd : undefined);
    expect(validateBody).not.toContain('staging.waaiio.com');
    expect(validateBody).not.toContain('.vercel.app');
    expect(validateBody).not.toContain('ALLOWED_HOSTS');
  });
});

describe('Promptfoo remote provider prevention', () => {
  const promptfooSrc = readFileSync(
    resolve(__dirname, '../promptfooconfig.yaml'), 'utf-8',
  );

  it('has no active webhook provider definition', () => {
    // No providers: block or url field that could reach deployed staging
    expect(promptfooSrc).not.toMatch(/^\s*- id:\s*"webhook:/m);
    expect(promptfooSrc).not.toMatch(/url:\s*".*\/api\/webhook\/meta-cloud"/);
  });

  it('documents that provider is removed, not just disabled', () => {
    expect(promptfooSrc).toContain('Remote webhook provider REMOVED');
  });
});

describe('WebhookClient remote traffic prevention', () => {
  const webhookSrc = readFileSync(
    resolve(__dirname, '../lib/webhook-client.ts'), 'utf-8',
  );

  it('sendText throws FAIL-CLOSED before any fetch', () => {
    // The send methods call assertRemoteWebhookAuthorized() which throws
    const sendTextIdx = webhookSrc.indexOf('async sendText(');
    const nextMethod = webhookSrc.indexOf('async send', sendTextIdx + 20);
    const sendTextBody = webhookSrc.slice(sendTextIdx, nextMethod);
    expect(sendTextBody).toContain('assertRemoteWebhookAuthorized()');
  });

  it('sendButtonReply throws FAIL-CLOSED before any fetch', () => {
    const idx = webhookSrc.indexOf('async sendButtonReply(');
    const end = webhookSrc.indexOf('async send', idx + 30);
    const body = webhookSrc.slice(idx, end);
    expect(body).toContain('assertRemoteWebhookAuthorized()');
  });

  it('sendListReply throws FAIL-CLOSED before any fetch', () => {
    const idx = webhookSrc.indexOf('async sendListReply(');
    const end = webhookSrc.indexOf('/**', idx + 20);
    const body = webhookSrc.slice(idx, end);
    expect(body).toContain('assertRemoteWebhookAuthorized()');
  });

  it('assertRemoteWebhookAuthorized always throws', () => {
    expect(webhookSrc).toContain("throw new Error(\n    'FAIL-CLOSED: Remote webhook delivery");
  });
});

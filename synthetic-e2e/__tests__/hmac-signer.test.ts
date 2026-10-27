/**
 * Tests for the HMAC webhook signer.
 *
 * Verifies that synthetic webhook payloads are correctly signed
 * and match the format expected by app/api/webhook/meta-cloud/route.ts.
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import {
  signWebhookPayload,
  buildTextMessagePayload,
  buildButtonReplyPayload,
  buildListReplyPayload,
  createSignedWebhookRequest,
} from '../lib/hmac-signer';

const TEST_SECRET = 'test_meta_app_secret_for_staging';

describe('signWebhookPayload', () => {
  it('produces sha256=<hex> format matching Meta convention', () => {
    const payload = '{"test": true}';
    const signature = signWebhookPayload(payload, TEST_SECRET);

    expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('produces correct HMAC for known input', () => {
    const payload = 'hello world';
    const expected = createHmac('sha256', TEST_SECRET)
      .update(payload, 'utf-8')
      .digest('hex');

    expect(signWebhookPayload(payload, TEST_SECRET)).toBe(`sha256=${expected}`);
  });

  it('different payloads produce different signatures', () => {
    const sig1 = signWebhookPayload('payload1', TEST_SECRET);
    const sig2 = signWebhookPayload('payload2', TEST_SECRET);
    expect(sig1).not.toBe(sig2);
  });

  it('different secrets produce different signatures', () => {
    const payload = 'same payload';
    const sig1 = signWebhookPayload(payload, 'secret1');
    const sig2 = signWebhookPayload(payload, 'secret2');
    expect(sig1).not.toBe(sig2);
  });
});

describe('buildTextMessagePayload', () => {
  it('produces valid Meta webhook JSON', () => {
    const payload = buildTextMessagePayload({
      from: '15550001234',
      to: '15551234567',
      text: 'Hello',
    });

    const parsed = JSON.parse(payload);
    expect(parsed.object).toBe('whatsapp_business_account');
    expect(parsed.entry).toHaveLength(1);
    expect(parsed.entry[0].changes).toHaveLength(1);

    const msg = parsed.entry[0].changes[0].value.messages[0];
    expect(msg.from).toBe('15550001234');
    expect(msg.text.body).toBe('Hello');
    expect(msg.type).toBe('text');
  });

  it('generates synthetic message IDs', () => {
    const payload = JSON.parse(buildTextMessagePayload({
      from: '15550001234',
      to: '15551234567',
      text: 'Test',
    }));

    const msgId = payload.entry[0].changes[0].value.messages[0].id;
    expect(msgId).toMatch(/^wamid\.synth_/);
  });

  it('uses provided message ID when given', () => {
    const payload = JSON.parse(buildTextMessagePayload({
      from: '15550001234',
      to: '15551234567',
      text: 'Test',
      messageId: 'wamid.custom123',
    }));

    const msgId = payload.entry[0].changes[0].value.messages[0].id;
    expect(msgId).toBe('wamid.custom123');
  });
});

describe('buildButtonReplyPayload', () => {
  it('produces valid button reply format', () => {
    const payload = JSON.parse(buildButtonReplyPayload({
      from: '15550001234',
      to: '15551234567',
      buttonId: 'btn_confirm',
      buttonTitle: 'Confirm',
    }));

    const msg = payload.entry[0].changes[0].value.messages[0];
    expect(msg.type).toBe('interactive');
    expect(msg.interactive.type).toBe('button_reply');
    expect(msg.interactive.button_reply.id).toBe('btn_confirm');
    expect(msg.interactive.button_reply.title).toBe('Confirm');
  });
});

describe('buildListReplyPayload', () => {
  it('produces valid list reply format', () => {
    const payload = JSON.parse(buildListReplyPayload({
      from: '15550001234',
      to: '15551234567',
      listId: 'list_booking',
      listTitle: 'Book Appointment',
      listDescription: 'Schedule a visit',
    }));

    const msg = payload.entry[0].changes[0].value.messages[0];
    expect(msg.type).toBe('interactive');
    expect(msg.interactive.type).toBe('list_reply');
    expect(msg.interactive.list_reply.id).toBe('list_booking');
    expect(msg.interactive.list_reply.title).toBe('Book Appointment');
  });
});

describe('createSignedWebhookRequest', () => {
  it('returns body and properly signed headers', () => {
    const payload = buildTextMessagePayload({
      from: '15550001234',
      to: '15551234567',
      text: 'Hi',
    });

    const { body, headers } = createSignedWebhookRequest(payload, TEST_SECRET);

    expect(body).toBe(payload);
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Hub-Signature-256']).toMatch(/^sha256=[a-f0-9]{64}$/);

    // Verify the signature is correct
    const expectedSig = signWebhookPayload(payload, TEST_SECRET);
    expect(headers['X-Hub-Signature-256']).toBe(expectedSig);
  });
});

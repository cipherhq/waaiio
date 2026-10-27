/**
 * Tests for the capture-only WhatsApp transport.
 *
 * Proves that the transport intercepts all outbound sends
 * and blocks real Meta API calls.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CaptureTransport, getGlobalCapture, resetGlobalCapture } from '../lib/capture-transport';

describe('CaptureTransport', () => {
  let transport: CaptureTransport;

  beforeEach(() => {
    transport = new CaptureTransport();
  });

  it('captures messages with ID and timestamp', () => {
    const captured = transport.capture({
      to: '15551234567',
      type: 'text',
      content: { body: 'Hello!' },
      journeyId: 'journey-1',
      stepIndex: 0,
    });

    expect(captured.id).toMatch(/^cap_/);
    expect(captured.timestamp).toBeTruthy();
    expect(captured.to).toBe('15551234567');
    expect(captured.type).toBe('text');
  });

  it('stores messages retrievable by journey', () => {
    transport.capture({ to: '1', type: 'text', content: 'msg1', journeyId: 'j1' });
    transport.capture({ to: '2', type: 'text', content: 'msg2', journeyId: 'j2' });
    transport.capture({ to: '3', type: 'text', content: 'msg3', journeyId: 'j1' });

    const j1Messages = transport.getMessages('j1');
    expect(j1Messages).toHaveLength(2);

    const allMessages = transport.getMessages();
    expect(allMessages).toHaveLength(3);
  });

  it('returns the last captured message', () => {
    transport.capture({ to: '1', type: 'text', content: 'first' });
    transport.capture({ to: '2', type: 'buttons', content: 'second' });

    const last = transport.getLastMessage();
    expect(last?.type).toBe('buttons');
    expect(last?.to).toBe('2');
  });

  it('tracks statistics by type', () => {
    transport.capture({ to: '1', type: 'text', content: 'a' });
    transport.capture({ to: '2', type: 'text', content: 'b' });
    transport.capture({ to: '3', type: 'buttons', content: 'c' });
    transport.capture({ to: '4', type: 'list', content: 'd' });

    const stats = transport.getStats();
    expect(stats.totalCaptured).toBe(4);
    expect(stats.byType.text).toBe(2);
    expect(stats.byType.buttons).toBe(1);
    expect(stats.byType.list).toBe(1);
  });

  it('BLOCKS Meta Graph API calls', () => {
    expect(() => {
      transport.blockMetaApiCall('https://graph.facebook.com/v21.0/123/messages');
    }).toThrow('FAIL-CLOSED');

    const stats = transport.getStats();
    expect(stats.metaApiCallsBlocked).toBe(1);
  });

  it('assertZeroMetaCalls passes when no Meta calls attempted', () => {
    transport.capture({ to: '1', type: 'text', content: 'safe' });
    expect(() => transport.assertZeroMetaCalls()).not.toThrow();
  });

  it('assertZeroMetaCalls fails when Meta calls were blocked', () => {
    try {
      transport.blockMetaApiCall('https://graph.facebook.com/v21.0/123/messages');
    } catch { /* expected */ }

    expect(() => transport.assertZeroMetaCalls()).toThrow('SAFETY VIOLATION');
  });

  it('resets all state', () => {
    transport.capture({ to: '1', type: 'text', content: 'msg' });
    try {
      transport.blockMetaApiCall('https://graph.facebook.com/v21.0/test');
    } catch { /* expected */ }

    transport.reset();

    expect(transport.getMessages()).toHaveLength(0);
    expect(transport.getStats().totalCaptured).toBe(0);
    expect(transport.getStats().metaApiCallsBlocked).toBe(0);
    expect(() => transport.assertZeroMetaCalls()).not.toThrow();
  });
});

describe('Global capture singleton', () => {
  beforeEach(() => {
    resetGlobalCapture();
  });

  it('returns same instance on repeated calls', () => {
    const a = getGlobalCapture();
    const b = getGlobalCapture();
    expect(a).toBe(b);
  });

  it('resets create a new instance', () => {
    const before = getGlobalCapture();
    before.capture({ to: '1', type: 'text', content: 'test' });

    resetGlobalCapture();

    const after = getGlobalCapture();
    expect(after).not.toBe(before);
    expect(after.getMessages()).toHaveLength(0);
  });
});

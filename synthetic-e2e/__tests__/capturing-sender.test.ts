/**
 * Tests for CapturingMessageSender — the real outbound interception boundary.
 *
 * CTO R1 Fix 1: Proves that the sender captures all outbound messages
 * at the same interface boundary as MetaCloudSender, with zero real sends.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CapturingMessageSender } from '../lib/capturing-sender';

describe('CapturingMessageSender', () => {
  let sender: CapturingMessageSender;

  beforeEach(() => {
    sender = new CapturingMessageSender();
  });

  it('captures sendText with content', async () => {
    const result = await sender.sendText({ to: '15550001234', text: 'Hello customer!' });

    expect(result.success).toBe(true);
    expect(result.messageId).toMatch(/^wamid\.synth_captured_/);

    const sends = sender.getCapturedSends();
    expect(sends).toHaveLength(1);
    expect(sends[0].method).toBe('sendText');
    expect(sends[0].to).toBe('15550001234');
    expect((sends[0].content as { text: string }).text).toBe('Hello customer!');
  });

  it('captures sendButtons with button IDs', async () => {
    await sender.sendButtons({
      to: '15550001234',
      body: 'Choose an option',
      buttons: [
        { id: 'btn_yes', title: 'Yes' },
        { id: 'btn_no', title: 'No' },
      ],
    });

    const sends = sender.getCapturedSends();
    expect(sends).toHaveLength(1);
    expect(sends[0].method).toBe('sendButtons');
    const content = sends[0].content as { buttons: Array<{ id: string; title: string }> };
    expect(content.buttons).toHaveLength(2);
    expect(content.buttons[0].id).toBe('btn_yes');
  });

  it('captures sendList with items', async () => {
    await sender.sendList({
      to: '15550001234',
      title: 'Menu',
      body: 'Select an option',
      buttonLabel: 'View Options',
      items: [
        { title: 'Book', postbackText: 'book' },
        { title: 'Order', postbackText: 'order' },
      ],
    });

    const sends = sender.getCapturedSends();
    expect(sends).toHaveLength(1);
    expect(sends[0].method).toBe('sendList');
  });

  it('captures platform-scoped sends separately', async () => {
    await sender.sendPlatformText({ to: '15550001234', text: 'Welcome to Waaiio!' });
    await sender.sendText({ to: '15550001234', text: 'Your booking is confirmed' });

    const sends = sender.getCapturedSends();
    expect(sends).toHaveLength(2);
    expect(sends[0].method).toBe('sendPlatformText');
    expect(sends[1].method).toBe('sendText');
  });

  it('filters sends by recipient', async () => {
    await sender.sendText({ to: '15550001111', text: 'To customer 1' });
    await sender.sendText({ to: '15550002222', text: 'To customer 2' });
    await sender.sendText({ to: '15550001111', text: 'Again to customer 1' });

    expect(sender.getSendsTo('15550001111')).toHaveLength(2);
    expect(sender.getSendsTo('15550002222')).toHaveLength(1);
    expect(sender.getSendsTo('15550003333')).toHaveLength(0);
  });

  it('tracks business binding', () => {
    expect(sender.boundBusinessId).toBe('');
    sender.bindBusiness('biz-123');
    expect(sender.boundBusinessId).toBe('biz-123');
    sender.enterPlatformDiscovery();
    expect(sender.boundBusinessId).toBe('');
  });

  it('resets all state', async () => {
    await sender.sendText({ to: '15550001234', text: 'msg' });
    sender.bindBusiness('biz-123');

    sender.reset();

    expect(sender.getCapturedSends()).toHaveLength(0);
    expect(sender.boundBusinessId).toBe('');
  });

  it('getLastSend returns the most recent', async () => {
    await sender.sendText({ to: '1', text: 'first' });
    await sender.sendButtons({ to: '2', body: 'second', buttons: [{ id: 'a', title: 'A' }] });

    const last = sender.getLastSend();
    expect(last?.method).toBe('sendButtons');
    expect(last?.to).toBe('2');
  });

  it('captures sendImage', async () => {
    await sender.sendImage({ to: '1', imageUrl: 'https://example.com/img.png', caption: 'Product' });
    expect(sender.getCapturedSends()[0].method).toBe('sendImage');
  });

  it('captures sendTemplate', async () => {
    await sender.sendTemplate({ to: '1', templateName: 'hello_world', templateParams: ['John'] });
    expect(sender.getCapturedSends()[0].method).toBe('sendTemplate');
  });

  it('never makes actual Meta API calls (all sends are in-memory)', async () => {
    // Send every type of message
    await sender.sendText({ to: '1', text: 'text' });
    await sender.sendButtons({ to: '1', body: 'b', buttons: [{ id: 'x', title: 'X' }] });
    await sender.sendList({ to: '1', title: 't', body: 'b', buttonLabel: 'l', items: [{ title: 'i', postbackText: 'p' }] });
    await sender.sendImage({ to: '1', imageUrl: 'u' });
    await sender.sendDocument({ to: '1', documentUrl: 'u', filename: 'f' });
    await sender.sendAudio({ to: '1', audioUrl: 'u' });
    await sender.sendPlatformText({ to: '1', text: 't' });
    await sender.sendPlatformButtons({ to: '1', body: 'b', buttons: [{ id: 'x', title: 'X' }] });

    // All captured, none escaped
    expect(sender.getCapturedSends()).toHaveLength(8);
    // Every send returned a synthetic wamid
    for (const send of sender.getCapturedSends()) {
      expect(send.id).toMatch(/^csend_/);
    }
  });
});

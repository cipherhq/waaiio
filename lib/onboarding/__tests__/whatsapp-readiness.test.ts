import { describe, expect, it } from 'vitest';
import { isAssignedWhatsAppChannelReady as ready } from '../whatsapp-readiness';

const biz = { id: 'biz-a', country_code: 'NG' };
const shared = { channel_type: 'shared', is_active: true, connection_status: 'active', country_code: 'NG', business_id: null };

describe('admin WhatsApp channel readiness (tenant & country)', () => {
  it('accepts a verified active shared channel in the same country', () => {
    expect(ready(biz, shared)).toBe(true);
  });
  it('rejects country mismatch even when shared channel is active', () => {
    expect(ready(biz, { ...shared, country_code: 'US' })).toBe(false);
  });
  it('rejects inactive, unverified, or unknown channel types', () => {
    expect(ready(biz, { ...shared, is_active: false })).toBe(false);
    expect(ready(biz, { ...shared, connection_status: 'verifying' })).toBe(false);
    expect(ready(biz, { ...shared, channel_type: 'unexpected' })).toBe(false);
  });
  it('requires exact tenant binding for dedicated channels', () => {
    const owned = { ...shared, channel_type: 'dedicated', business_id: 'biz-a' };
    expect(ready(biz, owned)).toBe(true);
    expect(ready(biz, { ...owned, business_id: 'biz-b' })).toBe(false);
    expect(ready(biz, { ...owned, business_id: null })).toBe(false);
  });
  it('never treats missing assignment as ready', () => {
    expect(ready(null, shared)).toBe(false);
    expect(ready(biz, null)).toBe(false);
  });
  it('does not treat a shared channel assigned to a business as platform shared', () => {
    expect(ready(biz, { ...shared, business_id: 'biz-b' })).toBe(false);
  });
});

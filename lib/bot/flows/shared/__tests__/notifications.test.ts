import { describe, it, expect } from 'vitest';
import { shouldNotify } from '../notifications';

describe('notifications — shouldNotify', () => {
  it('returns true when no metadata (backward compatible)', () => {
    expect(shouldNotify(null, 'new_booking', 'whatsapp')).toBe(true);
    expect(shouldNotify(undefined, 'new_booking', 'email')).toBe(true);
  });

  it('returns true when metadata has no notification_preferences', () => {
    expect(shouldNotify({}, 'new_booking', 'whatsapp')).toBe(true);
    expect(shouldNotify({ some_other_key: 'value' }, 'payment_received', 'email')).toBe(true);
  });

  it('returns true when notification type not in preferences', () => {
    const metadata = {
      notification_preferences: {
        new_booking: { whatsapp: true, email: true },
      },
    };
    // payment_received not set at all — should default to true
    expect(shouldNotify(metadata, 'payment_received', 'whatsapp')).toBe(true);
  });

  it('returns false when preference explicitly set to false', () => {
    const metadata = {
      notification_preferences: {
        new_booking: { whatsapp: false, email: true },
        payment_received: { whatsapp: true, email: false },
      },
    };
    expect(shouldNotify(metadata, 'new_booking', 'whatsapp')).toBe(false);
    expect(shouldNotify(metadata, 'payment_received', 'email')).toBe(false);
  });

  it('returns true when preference explicitly set to true', () => {
    const metadata = {
      notification_preferences: {
        new_booking: { whatsapp: true, email: true },
      },
    };
    expect(shouldNotify(metadata, 'new_booking', 'whatsapp')).toBe(true);
    expect(shouldNotify(metadata, 'new_booking', 'email')).toBe(true);
  });
});

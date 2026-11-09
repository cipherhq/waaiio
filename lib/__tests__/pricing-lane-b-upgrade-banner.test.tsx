// @vitest-environment jsdom
/**
 * Lane B (Owner 2026-11-08): during the feature trial Premium limits apply, so
 * the dashboard passes the limit tier to UpgradeBanner and the Starter
 * booking-limit warning does not show. After the trial it shows again.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { UpgradeBanner } from '@/components/dashboard/UpgradeBanner';
import { getLimitTier } from '@/lib/capabilities/policy';

const DAY = 24 * 60 * 60 * 1000;

afterEach(cleanup);

describe('UpgradeBanner with the limit tier', () => {
  it('stays hidden for a Starter business in its trial, even far over the Starter limit', () => {
    const tier = getLimitTier('free', new Date(Date.now() + 5 * DAY).toISOString());
    const { container } = render(<UpgradeBanner currentBookings={500} tier={tier} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows for a Starter business after the trial at its limit', () => {
    const tier = getLimitTier('free', new Date(Date.now() - DAY).toISOString());
    const { container } = render(<UpgradeBanner currentBookings={500} tier={tier} />);
    expect(container.innerHTML).not.toBe('');
  });
});

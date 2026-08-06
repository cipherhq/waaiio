import { describe, it, expect } from 'vitest';
import { getOccupancyStatus, OCCUPIED_STATUSES } from '../occupancy';

describe('getOccupancyStatus', () => {
  it('returns occupied for checked_in reservation', () => {
    expect(getOccupancyStatus({
      reservations: [{ status: 'checked_in' }],
      isDateBlocked: false,
    })).toBe('occupied');
  });

  it('returns occupied for legacy in_progress reservation', () => {
    expect(getOccupancyStatus({
      reservations: [{ status: 'in_progress' }],
      isDateBlocked: false,
    })).toBe('occupied');
  });

  it('returns vacant for confirmed reservation (not yet checked in)', () => {
    expect(getOccupancyStatus({
      reservations: [{ status: 'confirmed' }],
      isDateBlocked: false,
    })).toBe('vacant');
  });

  it('returns vacant for pending reservation', () => {
    expect(getOccupancyStatus({
      reservations: [{ status: 'pending' }],
      isDateBlocked: false,
    })).toBe('vacant');
  });

  it('returns vacant for checked_out reservation', () => {
    expect(getOccupancyStatus({
      reservations: [{ status: 'checked_out' }],
      isDateBlocked: false,
    })).toBe('vacant');
  });

  it('returns vacant for cancelled reservation', () => {
    expect(getOccupancyStatus({
      reservations: [{ status: 'cancelled' }],
      isDateBlocked: false,
    })).toBe('vacant');
  });

  it('returns vacant when no reservations', () => {
    expect(getOccupancyStatus({
      reservations: [],
      isDateBlocked: false,
    })).toBe('vacant');
  });

  it('returns blocked when date is blocked and no occupied guest', () => {
    expect(getOccupancyStatus({
      reservations: [{ status: 'confirmed' }],
      isDateBlocked: true,
    })).toBe('blocked');
  });

  it('returns blocked with no reservations but date blocked', () => {
    expect(getOccupancyStatus({
      reservations: [],
      isDateBlocked: true,
    })).toBe('blocked');
  });

  it('occupied takes priority over blocked', () => {
    expect(getOccupancyStatus({
      reservations: [{ status: 'checked_in' }],
      isDateBlocked: true,
    })).toBe('occupied');
  });

  it('returns occupied when one of many reservations is checked_in', () => {
    expect(getOccupancyStatus({
      reservations: [
        { status: 'completed' },
        { status: 'checked_in' },
        { status: 'pending' },
      ],
      isDateBlocked: false,
    })).toBe('occupied');
  });

  it('returns vacant for completed reservation', () => {
    expect(getOccupancyStatus({
      reservations: [{ status: 'completed' }],
      isDateBlocked: false,
    })).toBe('vacant');
  });

  it('returns vacant for no_show reservation', () => {
    expect(getOccupancyStatus({
      reservations: [{ status: 'no_show' }],
      isDateBlocked: false,
    })).toBe('vacant');
  });
});

describe('OCCUPIED_STATUSES', () => {
  it('contains checked_in', () => {
    expect(OCCUPIED_STATUSES.has('checked_in')).toBe(true);
  });

  it('contains in_progress for legacy support', () => {
    expect(OCCUPIED_STATUSES.has('in_progress')).toBe(true);
  });

  it('does not contain confirmed', () => {
    expect(OCCUPIED_STATUSES.has('confirmed')).toBe(false);
  });

  it('does not contain checked_out', () => {
    expect(OCCUPIED_STATUSES.has('checked_out')).toBe(false);
  });
});

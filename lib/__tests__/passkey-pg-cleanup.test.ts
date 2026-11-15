import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { cleanupPasskeyDatabase, PASSKEY_PG_CLEANUP_TIMEOUT } from './helpers/passkey-pg-cleanup';

const database = `m538_${'a'.repeat(32)}`;
function connection() {
  const end = vi.fn().mockResolvedValue(undefined);
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const destroy = vi.fn();
  return { end, query, connection: { stream: { destroy } } };
}
const asClient = (value: ReturnType<typeof connection>) => value as unknown as pg.Client;

beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('bounded passkey fixture cleanup', () => {
  it('closes the fixture, applies the SQL deadline, drops only its database and closes control', async () => {
    const fixture = connection(), control = connection();
    await cleanupPasskeyDatabase(database, asClient(fixture), asClient(control));
    expect(fixture.end).toHaveBeenCalledOnce();
    expect(control.query.mock.calls).toEqual([
      [{ text: "SET statement_timeout = '20s'", query_timeout: 2_000 }],
      [{ text: `DROP DATABASE IF EXISTS ${database}`, query_timeout: 22_000 }],
    ]);
    expect(fixture.end.mock.invocationCallOrder[0]).toBeLessThan(control.query.mock.invocationCallOrder[0]);
    expect(control.query.mock.invocationCallOrder[1]).toBeLessThan(control.end.mock.invocationCallOrder[0]);
    expect(control.end).toHaveBeenCalledOnce();
    expect(fixture.connection.stream.destroy).not.toHaveBeenCalled();
    expect(PASSKEY_PG_CLEANUP_TIMEOUT).toBe(35_000);
  });

  it.each(['drop error', 'SQL timeout', 'client timeout', 'configuration timeout'])('preserves %s and always closes control', async (kind) => {
    const fixture = connection(), control = connection();
    const original = Object.assign(new Error(kind), { code: kind === 'SQL timeout' ? '57014' : undefined });
    if (kind === 'configuration timeout') control.query.mockRejectedValueOnce(original);
    else control.query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(original);
    await expect(cleanupPasskeyDatabase(database, asClient(fixture), asClient(control))).rejects.toBe(original);
    expect(control.end).toHaveBeenCalledOnce();
    expect(control.query).toHaveBeenCalledTimes(kind === 'configuration timeout' ? 1 : 2);
  });

  it.each(['fixture', 'control'])('destroys only the owned %s socket on close deadline and still fails', async (which) => {
    vi.useFakeTimers();
    const fixture = connection(), control = connection();
    const stuck = which === 'fixture' ? fixture : control;
    stuck.end.mockImplementation(() => new Promise(() => {}));
    const result = cleanupPasskeyDatabase(database, asClient(fixture), asClient(control));
    const assertion = expect(result).rejects.toThrow(`${which} close exceeded 3000ms`);
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
    expect(stuck.connection.stream.destroy).toHaveBeenCalledOnce();
    expect((which === 'fixture' ? control : fixture).connection.stream.destroy).not.toHaveBeenCalled();
    expect(control.end).toHaveBeenCalledOnce();
  });

  it('preserves both DROP failure and final close failure', async () => {
    const fixture = connection(), control = connection();
    const drop = new Error('drop'), close = new Error('close');
    control.query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(drop);
    control.end.mockRejectedValueOnce(close);
    await expect(cleanupPasskeyDatabase(database, asClient(fixture), asClient(control))).rejects.toMatchObject({ errors: [drop, close] });
  });

  it('preserves fixture close failure while still attempting DROP and final close', async () => {
    const fixture = connection(), control = connection();
    const original = new Error('fixture close');
    fixture.end.mockRejectedValueOnce(original);
    await expect(cleanupPasskeyDatabase(database, asClient(fixture), asClient(control))).rejects.toBe(original);
    expect(control.query).toHaveBeenCalledTimes(2);
    expect(control.end).toHaveBeenCalledOnce();
  });

  it('never drops a database outside the two fixture prefixes', async () => {
    const control = connection();
    await expect(cleanupPasskeyDatabase('postgres', undefined, asClient(control))).rejects.toThrow('Invalid passkey fixture database');
    expect(control.query).not.toHaveBeenCalled();
    expect(control.end).toHaveBeenCalledOnce();
  });

  it('handles setup failing before either client exists', async () => {
    await cleanupPasskeyDatabase(database);
  });
});

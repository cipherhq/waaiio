import type pg from 'pg';

// DROP DATABASE waits for a shared checkpoint. CI observed a 15.980s
// checkpoint, longer than Vitest's default 10s teardown hook.
export const PASSKEY_PG_CLEANUP_TIMEOUT = 35_000;

async function closeOwnedClient(client: pg.Client, phase: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // These clients belong exclusively to the disposable test fixture.
      // A close timeout remains a test failure, even after socket destruction.
      const owned = client as pg.Client & { connection: { stream: { destroy(): void } } };
      owned.connection.stream.destroy();
      reject(new Error(`${phase} exceeded 3000ms`));
    }, 3_000);
  });
  try {
    await Promise.race([client.end(), deadline]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function cleanupPasskeyDatabase(
  database: string,
  client?: pg.Client,
  control?: pg.Client,
): Promise<void> {
  const errors: unknown[] = [];
  const started = Date.now();
  const report = (phase: string) => console.info(`[PG cleanup] ${database} ${phase} ${Date.now() - started}ms`);
  try {
    if (client) {
      report('fixture close start');
      try { await closeOwnedClient(client, 'fixture close'); } catch (error) { errors.push(error); }
      report('fixture close finished');
    }
    if (control) {
      // Only the UUID-named database created by these two suites is eligible.
      if (!/^m53[89]_[0-9a-f]{32}$/.test(database)) throw new Error('Invalid passkey fixture database');
      await control.query({ text: "SET statement_timeout = '20s'", query_timeout: 2_000 });
      report('drop start');
      // Server timeout cancels SQL; the longer client timeout bounds a lost
      // response. finally closes the non-pipelined connection on either error.
      await control.query({ text: `DROP DATABASE IF EXISTS ${database}`, query_timeout: 22_000 });
      report('drop finished');
    }
  } catch (error) {
    errors.push(error);
  } finally {
    if (control) {
      report('control close start');
      try { await closeOwnedClient(control, 'control close'); } catch (error) { errors.push(error); }
      report('control close finished');
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Passkey database cleanup failed');
}

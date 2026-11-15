/** Test-only boundary: allow a loopback transport, including a Docker port-forward. */
export function assertGuidedLocalPg(input: {
  socketDirectory: string | null;
  peerAddress: string | undefined;
  serverAddress: string | null;
  initialDatabase: string;
  expectedDatabase: string;
}) {
  if (input.initialDatabase !== input.expectedDatabase) throw Error('Unexpected initial database');
  if (input.socketDirectory !== null) {
    if (!/^\/(private\/)?tmp\/waaiio-guided-/.test(input.socketDirectory) || input.serverAddress !== null) throw Error('Unexpected Unix socket');
  } else if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(input.peerAddress ?? '')) {
    throw Error('Local disposable PostgreSQL transport required');
  }
}

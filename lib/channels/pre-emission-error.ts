/** Proven transient failure before provider emission and before financial reservation commit. */
export class PreEmissionRecoveryError extends Error {
  constructor(cause: unknown) {
    super('Transient pre-emission failure', {cause});
    this.name = 'PreEmissionRecoveryError';
  }
}

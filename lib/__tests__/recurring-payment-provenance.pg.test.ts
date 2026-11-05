import { beforeAll, afterAll, describe, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { register } = require('./fixtures/recurring-payment-provenance-harness.cjs');

// No skip: this mandatory local PostgreSQL proof fails if its connection is absent/non-local.
describe('recurring payment provenance under accounting guard', () => {
  register({ beforeAll, afterAll, it });
});

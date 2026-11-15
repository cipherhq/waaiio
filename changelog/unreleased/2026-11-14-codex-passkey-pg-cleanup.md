## 2026-11-14 — Bound passkey PostgreSQL test cleanup

- Give M538/M539 disposable database teardown a scoped 35-second budget because database removal waits for shared checkpoints; CI observed a checkpoint longer than the default 10-second hook.
- Bound DROP with a 20-second server cancellation and 22-second client timeout, configuration with 2 seconds, and each owned-client close with 3 seconds. Preserve cleanup failures and always close the control connection.
- Add phase timing and focused cleanup lifecycle regression tests. Preserve the existing nine PostgreSQL assertions, isolated databases, CI concurrency and zero-skip gates.
- No runtime, migration, authorization or global test-timeout change. Could fail these two test suites if cleanup exceeds its explicit budget; failures remain visible rather than skipped or retried.

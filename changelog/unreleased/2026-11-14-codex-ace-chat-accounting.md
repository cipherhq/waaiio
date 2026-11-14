## 2026-11-14 — Record ACE chat usage with server authority

- Correct the ACE chat route to use the existing service client for usage accounting after authentication, ownership, allowance checks and a successful model response.
- Return the existing service-unavailable error when accounting fails, without returning the unrecorded suggestion.
- Preserve allowance limits and post-model accounting timing; no schema, grants, provider or quota redesign.
- Actual handler regressions exercise the existing helper with mocked database/provider boundaries, including ownership denials, allowance checks, write failures and model failures.
- Could affect ACE text setup availability when accounting is unavailable. The model call already incurred cost before accounting; a retry can call the model again. This change does not provide exactly-once provider execution.

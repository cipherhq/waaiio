---
name: admin-route-security
description: "Map and verify every admin action's protection. Run when adding or changing any admin route, or auditing the admin surface before release."
---

# Admin Route Security

> MANDATORY when adding or changing admin routes; run as a full sweep before release.

For every admin action, record:
1. Behind admin auth (requirePlatformAdmin verifying session, role, and AAL2)?
2. Sensitive action (money, account control, impersonation, provider settings, team changes) behind an action-bound single-use step-up?
3. Does the UI actually send the step-up id for that action?
4. Does the DB query run with an identity RLS accepts (see cross-origin-auth-check)?
5. Risk rating: money > account control > everything else.

Fix by risk order. Output a table of every admin route with the five columns above.

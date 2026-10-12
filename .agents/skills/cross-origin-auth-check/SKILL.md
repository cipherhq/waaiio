---
name: cross-origin-auth-check
description: "Verify admin API routes authenticate and query the database with the SAME identity. Run after any change to admin routes, requirePlatformAdmin, or Supabase client usage."
---

# Cross-Origin Auth Check

> MANDATORY after touching any route that calls requirePlatformAdmin.

Context: the admin panel calls the API cross-origin with a Bearer token and NO cookies. A route that authenticates via Bearer but then queries with the cookie-based client (lib/supabase/server) runs as anonymous. RLS returns nothing, and the action silently fails or falsely reports success.

For each admin route, confirm:
1. No file importing requirePlatformAdmin also imports the cookie-based server client for its data calls.
2. After auth passes, database calls use the service client (server-only) or a Bearer-scoped client, not cookies.
3. On a bad or missing token, the route fails closed. It must never fall back to cookie identity.
4. A Bearer-only, no-cookie test exists and exercises the real database with RLS, no mocked DB client.

Output: route, auth method, DB client used, match? (yes/no), test present?

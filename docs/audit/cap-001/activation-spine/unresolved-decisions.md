# Unresolved Product Decisions

These questions cannot be answered from repository evidence alone. They require explicit product decisions before implementation.

## 1. Trial expiry behavior (affects CAS-007)

**Question:** When a 30-day trial expires without the business upgrading to a paid plan, what should happen to capabilities that require growth or business tier?

**Options:**
- **A. Immediate downgrade:** Disable all capabilities above the free tier when trial_ends_at passes. Simple but abrupt.
- **B. Grace period:** Give 7 days after trial expiry before disabling. Sends warning notifications.
- **C. Runtime filtering:** Don't modify business_capabilities rows. Instead, filter at query time — both bot and dashboard check tier+trial before including a capability.
- **D. Do nothing (current behavior):** Capabilities remain enabled indefinitely. Rely on honor system and dashboard upgrade prompts.

**Recommendation:** Option C is safest — no data loss, no cron job needed, consistent enforcement. But it requires changes to getEnabledCapabilities(), layout.tsx, and the capabilities page.

## 2. API capability enforcement (affects CAS-003)

**Question:** Should API routes independently verify that the business has the relevant capability enabled before allowing resource creation?

**Current state:** Zero API routes check capabilities. A client that bypasses the dashboard UI can create bookings, orders, tickets, etc. for disabled capabilities.

**Options:**
- **A. Full enforcement:** Add capability middleware to all capability-specific API routes.
- **B. Selective enforcement:** Only enforce on write operations (POST/PUT/DELETE), not reads.
- **C. Accept current design:** UI and bot gating are sufficient. API callers are trusted.

**Recommendation:** Option B — enforce on writes only. This prevents data creation for disabled capabilities while allowing read access for dashboard display.

## 3. Capability write mechanism (affects CAS-006)

**Question:** Should the capability toggle on the dashboard use a Next.js API route instead of direct browser-to-Supabase writes?

**Current state:** The capabilities page writes directly to business_capabilities via the browser Supabase client. RLS checks only owner_id, not tier.

**Options:**
- **A. API route:** Create POST /api/capabilities/toggle that validates tier server-side.
- **B. RLS function:** Add a PostgreSQL function called from RLS that checks tier.
- **C. Keep direct writes:** Rely on client-side canEnableCapability() and accept the bypass risk.

**Recommendation:** Option A — a thin API route is the simplest way to add server-side tier validation without complex RLS functions.

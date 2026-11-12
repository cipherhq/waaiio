## 2026-11-11 — Preserve channel routing during card setup

- Preserve the verified originating WhatsApp channel when establishing Paystack save/replacement and Stripe activation PIN sessions, including activation recovery. This shared path serves every capability using post-payment card saving.
- Fixes the staging case where accepting Save replaced session data and the next reply entered business discovery instead of PIN handling.
- No migration, payment authority, shared-session selection, or consent-policy change. Risk: card-session continuation; tests cover the real PostgreSQL session-establishment/resolver boundary and wrong-channel rejection. Full CI and handset acceptance are tracked in the PR.

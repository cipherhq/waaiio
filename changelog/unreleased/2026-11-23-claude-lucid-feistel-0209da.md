## 2026-11-23 — Harden party invite RSVP lookup on the public join page

- **Change:** `POST /api/invite-optin` (`app/api/invite-optin/route.ts`, the public join-event page's sign-up) now returns an RSVP link and code only for an invite it creates in that same request.
  - When the phone is already on the guest list, the response is `{ success, already_invited, whatsapp_sent }`. The invite's RSVP link is re-sent only to the phone on the list over WhatsApp, for every RSVP status. Guests who already replied now get it too, so they can change their answer (Owner decision 2026-11-23).
  - Invite messages are capped at 3 per recipient (phone or email) per event/party per 24 hours, using the shared limiter.
  - The route's per-address limit is now 5 requests per 10 minutes (was 10 per minute).
- **Page:** `app/join-event/[id]/page.tsx`. A guest already on the list sees "You're on the list!" and "We've sent your RSVP link to your WhatsApp. Open it there to reply or change your answer.", without RSVP buttons. If the message could not be sent, the page shows "Check your WhatsApp for your RSVP link." instead. New guests see the same screen as before.
- **Unchanged:** the new-guest path (invite created, WhatsApp/email sent, own RSVP link and WhatsApp button returned), international phone storage and legacy-phone adoption, the host dashboard invite route, and bot RSVP handling.
- **Tests:**
  - `lib/__tests__/invite-optin-rsvp-lookup.test.ts` (route: new guest, existing guest for every status, send caps, per-address limit)
  - `lib/__tests__/join-event-optin-ui.test.tsx` (rendered success screen)
  - `lib/__tests__/rsvp-whatsapp-delivery.test.ts` (limiter mock updated)
- **Could break:**
  - A guest already on the list no longer gets RSVP buttons on the page. After 3 sends in 24 hours they must use the message already in WhatsApp or ask the host.
  - A shared office or venue network signing up more than 5 guests in 10 minutes from one address gets "Too many requests" for a few minutes.
  - When the shared limiter (Upstash) is not configured, the send cap is per server instance.

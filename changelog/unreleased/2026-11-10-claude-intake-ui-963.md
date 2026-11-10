## 2026-11-10 — Client intake forms: services setting, client page and booking status (#963 lane 2)

**Why:** Owner decisions (2026-11-10, #963) let a Pro, Premium or trial business link one of its forms to a service. The client answers on a private page, and the business sees the answers on the booking. This lane uses the M526 database objects (PR #966). Sending the link is lane 3.

**What changed**
- **Services page** (`app/dashboard/services/page.tsx` and the new `components/dashboard/ServiceIntakeSettings.tsx`):
  - New "Client intake form" setting: pick the form, when (before or after the booking is confirmed) and how often (first booking only or every booking).
  - It is shown only to businesses on Pro or Premium or in their trial (`getLimitTier`).
  - A business that is no longer entitled sees its link marked paused and can remove it.
  - Forms with a file question can't be chosen (Owner decision 2026-11-10: not for now).
  - A failed save now shows a message and keeps the form open. It used to fail silently.
- **Service payload** (`lib/services/payload-builders.ts`): `buildServicePayload` accepts an optional `intake`. If the caller leaves it out, no intake columns are sent, so other callers are unchanged.
- **Client intake page** (`app/intake/[token]/page.tsx` and `components/intake/IntakeFormView.tsx`): a private page for one client's link. Search engines don't index it and browsers don't pass its address to other sites (no-referrer).
- **Intake API** (`app/api/intake/[token]/route.ts`):
  - `GET` and `POST`, rate limited. The record is looked up by the sha256 of the link token.
  - The response never includes the client's phone or their saved answers.
  - Answers are checked on the server first (`lib/intake/answers.ts`: field ids, types, options, lengths), then saved through `submit_booking_intake_526`.
- **Bookings page** (`app/dashboard/reservations/page.tsx` and the new `components/dashboard/BookingIntakePanel.tsx`): the booking detail shows "Done" with the answers, "Intake not done" or "Not sent". "Not sent" appears only on upcoming bookings that are not cancelled (Owner decision 2026-11-10). It reads only through the owner's RLS.
- **Analytics never runs on intake links** (`components/PostHogProvider.tsx`): PostHog doesn't start on `/intake/` pages, and a `before_send` hook drops any event that names an intake URL. The intake page also carries `ph-no-capture`, so no click, answer or link token can reach analytics (review finding P1).
- **Sentry never receives intake link tokens** (`lib/sentry-redact.ts`, `sentry.client.config.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`): errors, transactions, spans and breadcrumbs are scrubbed. `/intake/{token}` and `/api/intake/{token}` become `[token]`. Nothing else in Sentry changes (Codex review P1).
- **Tests:**
  - `lib/__tests__/intake-answers-963.test.ts`: answer checks and payload.
  - `lib/__tests__/intake-route-963.test.ts`: route handlers.
  - `lib/__tests__/intake-ui-963.test.tsx`: the three screens, rendered.
  - A one-line type fix in `lib/__tests__/booking-intakes-526.pg.test.ts`.

**Could break:**
- A save that the database used to reject without anyone noticing now shows an alert.
- If a form's questions change after a link is sent, the client is asked to reload the page.
- Nothing sends intake links yet, so no client sees the page until lane 3 ships.

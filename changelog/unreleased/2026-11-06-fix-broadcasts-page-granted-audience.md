## 2026-11-06 — Broadcasts page shows only people who opted in (#591 Part B)

**Problem:** the Broadcasts page built its audience and "Sending to N" count from `customer_profiles.notification_opt_in`, which defaults to true (migration 021). The send routes (`/api/broadcasts/send`, `/api/broadcasts/schedule`, the scheduled-broadcasts cron) only message people whose latest WhatsApp **marketing** consent for the business is granted, unexpired and not opted out (`hasRecipientPermission(..., 'marketing')`). So the page promised N people while the server sent to the granted subset, often none. People who opted in without a profile never appeared.

**What changed**
- New `app/api/broadcasts/recipients/route.ts` (GET, owner only, no-store): the opted-in list from `listOptedInContacts(..., 'marketing')`, with this business's profile name, tags, spend and last-seen attached for the page filters. Fails closed (503) if consent, opt-out or profile reads fail.
- `lib/forms/opted-in-contacts.ts`: `listOptedInContacts` takes the consent purpose (default stays the forms purpose, `marketing`, so the Forms picker is unchanged). Consent rows stored in a spelling other than `digits` / `+digits` are ignored, because `hasRecipientPermission` never reads them.
- New `lib/broadcasts/audience-filter.ts` (client-safe): the page's existing presets, last-visit, minimum-spend, tag and high-spender filters, applied to the opted-in list only (a missing profile value never matches a filter on it); tags offered are only those opted-in people have; imported numbers kept only if they opted in.
- `app/dashboard/broadcasts/page.tsx`: audience, count, tag list and filters come from the new route; no client query on `customer_profiles` for the audience. Pasted/CSV numbers and keyword-campaign respondents are kept only if they opted in ("Skipped N numbers that have not opted in."). Empty state: "No one has opted in yet. Customers can opt in from your forms or by tapping 'Get updates' in WhatsApp." If the list cannot load, nobody is offered and the page says so.
- Broadcasts have no "messaged you in the last 24 hours" route (that is forms only, #944), so the page does not add recent chatters.

**Unchanged:** the send/schedule routes and cron, `hasRecipientPermission`, `RECIPIENT_POLICY`, consent rules, `notification_opt_in` everywhere else, payments, the bot.

**Tests:** `lib/__tests__/broadcasts-recipients-591b.test.ts` (route on an in-memory store; cross-check that the real `/api/broadcasts/send` messages exactly the listed people), `lib/__tests__/broadcast-audience-filter.test.ts`, `app/dashboard/broadcasts/__tests__/broadcasts-page.test.tsx` (rendered page).

**Could break:** merchants will see a smaller (often zero) audience until customers opt in. That is what the server already sent to. Imported numbers that have not opted in are no longer added to the audience.

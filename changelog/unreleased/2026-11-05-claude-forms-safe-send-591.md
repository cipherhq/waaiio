## 2026-11-05 — Forms: send to opted-in groups, honest results, optional "send me updates" box (#591, PR A)

**What changed** (Owner chose "Build into Forms", 2026-11-05)

- **Send on WhatsApp from the Forms page** (`components/dashboard/forms/FormSendPanel.tsx`, `app/dashboard/forms/page.tsx`). The merchant picks recipients in one of three ways:
  - opted-in contacts;
  - a saved Audience (resolved by `lib/engage`);
  - typed numbers.

  An approved template can be chosen. The panel shows Sent / Failed / Skipped, with a reason for each recipient who was not sent.
- **`/api/forms/send` rewritten** (`app/api/forms/send/route.ts`, new `lib/forms/form-send.ts`):
  - every recipient is checked with `hasRecipientPermission(…, 'marketing')`, and opt-outs are honoured; a failed check means skip;
  - inside a verified 24-hour window (inbound receipts on the sending channel) the invite goes as text; outside it, only an approved two-parameter `en_US` template from the sending WABA is used;
  - each recipient gets an honest result; one provider attempt per recipient; every attempt is logged in `notifications`;
  - sending no longer writes an empty `status: 'sent'` row to `form_responses`.
- **Opted-in contacts list** (new `app/api/forms/recipients/route.ts`, `lib/forms/opted-in-contacts.ts`). Owner only. It lists people whose latest WhatsApp marketing consent for this business is granted and who have not opted out.
- **Optional "Yes, send me updates" box**:
  - the merchant turns it on per form (`forms.settings.marketing_opt_in`); it needs a Phone field;
  - it is shown unticked on the public form (`app/form/[token]/page.tsx`, `app/api/forms/public/[token]/route.ts`);
  - when ticked, `/api/forms/submit` records consent with the existing `grantConsent` (whatsapp / marketing / source `website`) and sets `form_responses.consent_given`.
- **View Responses** hides the old empty "sent" rows and shows "Opted in to updates" on responses that opted in.

**What it affects**
- The Forms page and public forms.
- `/api/forms/send` request shape: `phones[]`, `segmentId` and `templateName` are added; the old single `phone` still works.
- The response is now `{ success, sent, failed, skipped, results }`. `success` is true only if at least one message was accepted.

**What could break**
- People without recorded marketing consent no longer receive forms. This is intended (`RECIPIENT_POLICY`).
- Recipients outside the 24-hour window fail unless the merchant chooses a compatible template.
- Interim limit of 100 recipients per send and 5 sends per minute per business (Owner decision pending).

**Not in this PR:** scheduled sends (PR B adds migration 517, PR C adds the app). Schema drift was found but not fixed: production has `form_responses.status`, `channel` and `business_notes`, but no migration creates them.

## 2026-11-11 — Complete the native WhatsApp form lifecycle

- Add owner-controlled publication, current-revision status and guarded sending in `app/api/forms/native-flow`, with a customer WhatsApp form link and signature-verified submission handling in `app/api/webhook/meta-cloud/route.ts` and `lib/whatsapp-forms`.
- Add native form controls and response history in the merchant Forms dashboard. Optional event registrations continue through existing ticket checkout; payment custody, tax, fees and refunds keep their existing authorities.
- Keep WhatsApp Yes/No confirmation separate from optional address-specific, unverified email marketing consent. Add explicit email updates for selected form respondents and address-specific unsubscribe, preserving existing broadcast limits and existing email grants.
- Add M535 for publication, atomic response/registration persistence, email batch history and unsubscribe. Add local HTTP, runtime, rendered UI and PostgreSQL tests and the CI database-file guard.
- Affects Forms, native webhook dispatch, event association, consent and email eligibility. Regression risks include channel changes, duplicate delivery, changed form revisions and existing checkout navigation. The strict channel-read option is opt-in and does not change country routing.
- Use consent-based recipients in poll/survey selectors and the native form panel, including numbers without profiles or bot sessions; align pending marketing requests with existing effective-permission rules. Send-time consent, tenant and chat-window checks remain authoritative. Picker regressions include stale business selections, failed loads and truncated lists.
- Record allowlisted native-webhook failure classes and numeric Meta codes for pilot diagnosis, without logging customer data or changing retries, sends or billing authority.
- Omit absent or empty optional screen data in `lib/channels/meta-cloud.ts` to match Meta's Flow message contract. Preserve populated data and all other message fields; HTTP-body regressions cover native forms and legacy onboarding. This corrects a documented request mismatch; live delivery still requires pilot verification.
- M535 must precede application deployment, including when the native feature switch is off. Both project configs disable automatic deployment for this branch. The Owner-authorized staging M535 application was independently verified; deployment and provider acceptance remain separate. Post-consent rollback must preserve address-bound email checks or pause email sends. See `docs/contracts/591-native-forms-lifecycle.md`.
- 2026-11-12, Owner decision after the #988 review: native form messages now get #536's per-customer protections. In `lib/whatsapp-forms/webhook.ts`:
  - The `waaiio_form:` entry text goes through the shared pause/repeat check, and its form send counts toward the daily reply limit.
  - A submission receipt counts toward the daily limit and is not sent to a paused customer. The response is still saved.
  - Over the limit, the send is refused and today's free notice is sent. Every guard fails open on a database error, as in #536.
  - Affects native form entry and receipt sends only.
  - Could break: a legitimate customer who is paused or over the limit no longer receives the form or the receipt.
  - Tests: `lib/__tests__/native-form-message-guard-536.test.ts`.

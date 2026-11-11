## 2026-11-11 — Complete the native WhatsApp form lifecycle

- Add owner-controlled publication, current-revision status and guarded sending in `app/api/forms/native-flow`, with a customer WhatsApp form link and signature-verified submission handling in `app/api/webhook/meta-cloud/route.ts` and `lib/whatsapp-forms`.
- Add native form controls and response history in the merchant Forms dashboard. Optional event registrations continue through existing ticket checkout; payment custody, tax, fees and refunds keep their existing authorities.
- Keep WhatsApp Yes/No confirmation separate from optional address-specific, unverified email marketing consent. Add explicit email updates for selected form respondents and address-specific unsubscribe, preserving existing broadcast limits and existing email grants.
- Add M535 for publication, atomic response/registration persistence, email batch history and unsubscribe. Add local HTTP, runtime, rendered UI and PostgreSQL tests and the CI database-file guard.
- Affects Forms, native webhook dispatch, event association, consent and email eligibility. Regression risks include channel changes, duplicate delivery, changed form revisions and existing checkout navigation. The strict channel-read option is opt-in and does not change country routing.
- M535 must precede application deployment, including when the native feature switch is off. Both project configs disable automatic deployment for this branch. No hosted migration, provider pilot or release is included; see `docs/contracts/591-native-forms-lifecycle.md`.

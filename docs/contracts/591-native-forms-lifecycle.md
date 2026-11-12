# Native WhatsApp forms — issue #591

## Merchant and customer journey

A merchant saves a form in Dashboard → Forms, optionally offers separate WhatsApp updates and email news, and can select one of that business's upcoming published events. Native forms support the compiler's existing field types and limits; unsupported fields receive a validation error rather than being silently omitted.

The merchant publishes the saved revision, then shares its WhatsApp form link. The customer opens the business's resolved WhatsApp number, sends the prefilled request, opens the native form and submits. Responses appear in the merchant's Forms view, including answers retained from earlier revisions. Editing a published form requires publishing the new revision.

A form associated with an event offers Continue registration after capture. This resumes the existing ticketing flow for that event. Ticket quantity, terms, availability, checkout, confirmation and refunds continue to use existing authorities. Paid checkout may open a secure payment page; this is not native WhatsApp payment. A form response is not itself a paid or confirmed booking. This version captures the purchaser's form response, not a separate form for every ticket holder. Existing tax-related refusals are preserved.

## Consent and email

- WhatsApp updates require the existing separate Yes/No confirmation. A form checkbox alone is not a WhatsApp grant.
- Email news is optional and independent of WhatsApp. The checkbox records permission for the submitted address and business; it does not verify the email address or send a verification email. A blank optional email does not prevent an otherwise valid signup.
- Email form respondents lets merchants explicitly select responses and write a marketing message. It uses existing broadcast entitlement and limits. Native email delivery requires an address-specific grant and respects unsubscribe and phone-based suppression. Existing email grant behavior is retained for existing broadcast callers without letting a native grant authorize a different address.
- Email acceptance is distinct from delivery. A batch request keeps its identity when checking an uncertain result; checking that request does not send it again.
- Confirmed WhatsApp opt-ins are selectable by number even without a customer profile or bot session. Forms, broadcasts, polls and surveys use the existing business-scoped marketing audience; payment requests retain their separate utility permission. A pending request does not replace an existing marketing grant, and revocation, expiry and STOP still suppress selection and sending. Native forms also require an open business chat window; selecting a contact does not open that window.

## Release prerequisites and limits

This branch is source implementation and local verification only. Do not treat issue #591 as provider-certified or close it solely because unit tests pass.

1. Review and approve M535 (`535_native_form_lifecycle.sql`) separately. It must be applied and verified **before this application revision** because shared email authorization reads its additive schema even when native forms are disabled. There is no automatic migration application in this feature.
2. Keep `WHATSAPP_NATIVE_FORMS_ENABLED` unset or `false` until the separately authorized staging pilot. Both Vercel project configs disable Git deployment for `codex/native-forms-591`.
3. Publication and delivery require valid server-side Meta account credentials, Flow support and permissions on the resolved account, and the supported Graph API version. `FLOW_TOKEN_SECRET` must be a strong server-only secret. Email uses the existing configured Resend sender and HTTPS `NEXT_PUBLIC_APP_URL`.
4. Staging continues to use the designated shared US number for every business country. Production continues its existing country/channel resolution. This feature does not allocate or register numbers.
5. Perform a separately authorized provider pilot: publish/open/submit a free registration, follow the existing paid checkout, verify receipt/booking behavior, confirm Yes and No, opt into email, and unsubscribe. Verify real customer and merchant views. Test both merchant-connected and Waaiio-collected payment routes without changing custody or settlement rules.
6. Roll back application code if required while retaining the additive schema and consent/response history. Once native email grants exist, the rollback must preserve address-bound email authorization or pause email sends: the pre-feature application does not understand that address scope. Do not drop collected data as part of rollback.

### Staging migration checkpoint — 2026-11-11

The Owner authorized staging-only migration and a test-account pilot. The complete M535 was applied through Supabase MCP as ledger version `20261111231208` and independently verified: one 21,727-byte statement with SHA-256 `5c6638db628c6700f0861fa7322ef48c2d1243f1338ae16c4c4a5456146c1952`; four RLS tables, four service-only invoker RPCs, three nullable columns and the narrow receipt-claim grant are present. No tax migrations were needed or applied. Production remains untouched.

This schema checkpoint does not certify deployment or Meta behavior. The existing staging workflow requires merged-on-main ancestry; an unmerged candidate needs a separate explicit Owner exception. Test recipient details and provider acceptance remain pending. See the live evidence on PR #988 before attempting the next step.

## Verification map

- `native-form-provider-591.test.ts`: actual HTTP adapter with mocked external responses; no real Meta asset operations.
- `native-form-http-591.test.ts`: actual owner/public routes, signed Meta webhook entry and email branch with provider egress mocked.
- `native-form-runtime-591.test.ts`, `native-form-consent-591.test.ts`, `native-form-registration-591.test.ts`, `native-form-channel-591.test.ts`: runtime boundaries, consent history and existing event/channel behavior.
- `native-form-controls-591.test.tsx`, `native-form-responses-ui-591.test.tsx`: rendered merchant controls and responses.
- `native-form-lifecycle-591.pg.test.ts`: disposable PostgreSQL authority, concurrency and association tests. These are database tests, not HTTP or provider certification.

The non-database files run under the Main App test step. The PostgreSQL file is excluded there and discovered by the disposable database job, with a required-file check and the job's zero-skip guard. A CI execution claim still requires the exact PR head, its job output and per-file counts.

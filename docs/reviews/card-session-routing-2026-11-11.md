# Card session routing correction

Base: `f15d56d9c26b11b733b8e4673e084591332131f8` (#981).
Owner authorized a surgical cross-capability fix, independent reviews, CI, and staging deployment.

Independent Evidence Verification Agent `codex-release_review_one` confirmed one active staging continuity defect. Payment and ticket artifacts completed before the card offer, but card-session establishment replaced routing provenance. The actual M493 shared resolver rejected the otherwise correctly bound PIN session; no credential commitment occurred. This is not evidence of financial loss or a production failure. Private customer identifiers and input contents are excluded here.

## Preflight

| Change | Affected files / callers | Risk | Boundaries |
|---|---|---|---|
| Preserve inbound channel during Paystack save/replacement and Stripe activation | `saved-card-offer.ts`; BotService saved-card action/manual command; paid completion | High: shared session state | Reuse verified offer/payment provenance; retain payment/phone/business checks |
| Preserve same channel in activation recovery | `saved-card-activation-retry/route.ts` | High: continuation | Existing claimed offer's exact channel; delivery fence unchanged |
| Regression at SQL integration boundary | Real M398 establishment and M493 resolver | Test only | Correct-channel allow; wrong-channel, absent binding and pending-picker behavior retained |

Graphify index at the exact base and current source locate all four establishment calls. M398 replaces session data; M493 requires `_inbound_channel_id`. The separate `_saved_card_channel_id` is used by card delivery and does not satisfy that routing check.

No new migration or resolver fallback. Preserve explicit business binding and picker precedence. Money amounts, provider routing, merchant splits/manual settlement, credential authority, opt-in policy and final-menu sequencing remain outside the correction. Existing affected regression suites must continue to pass.

Acceptance: production session writers retain verified channel provenance; actual PostgreSQL resolver returns the PIN session on the bound channel, and the next inbound dispatch reaches the card handler. Final staging handset test must verify save confirmation, explicit eligible opt-in and business options after the PIN step. Do not infer handset success from unit/SQL results.

Rollback: revert this application-only correction through normal release gates; no schema rollback required.

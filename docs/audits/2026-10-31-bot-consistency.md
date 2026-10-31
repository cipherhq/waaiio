# Bot consistency corrections — 2026-10-31

Base: da9020670b856fda73dd05477d82859fdd460cf7. Branch: codex/bot-onboarding-consistency.

## Implemented

- Account-menu history lookup tries canonical +phone first, then legacy digits-only phone. Staging TestBiz evidence: latest session's canonical lookup missing, legacy profile exists with booking/order history. No customer identity data is included here.
- One renderable action no longer skips the account menu for returning customers. New-customer auto-selection, forced menus, promo-only contextual entry and pagination remain intact.
- Ordering and scheduling referral prompts use the current capability guard, including plan/trial rules, without session-recovery side effects. Existing reward accounting is unchanged.
- English product menu label is Browse Products; route IDs and merchant custom labels remain unchanged. Services retain Our Services.

## Evidence and limits

Independent evidence and diff review completed; its dual-phone ambiguity concern was addressed with canonical-first fallback. Targeted executable tests cover menu navigation and referral allow/deny. No CI or deployment certification is claimed. A full suite and typecheck attempt were stopped after failing to produce completion; release validation remains outstanding.

TestBiz has referral enabled and loyalty disabled in persisted settings. These corrections do not silently disable referral or claim to resolve why the merchant did not see its dashboard control. Loyalty-only account discovery and other pre-existing account-history limitations are not fixed here.

## Route traces

- Returning customer, sole action: select_capability.skipIf -> shared history predicate -> false -> prompt includes cap_my_account -> validate sets active_capability=my_account -> next=my_account_menu.
- New customer, sole action: no history -> existing automatic flow entry retained.
- Referral denied: ask_referral_code.skipIf -> current capability guard denies -> existing next-step skip behavior, no referral lookup or financial write.
- Referral allowed: current guard allows -> prior-conversion lookup -> existing referral prompt/skip behavior.
- Browse Products retains cap_ordering postback and ordering flow routing.

## Outstanding owner-requested scope

Shared-number recovery UI and number guidance; invitations/password setup/roles; product image browsing; seating/Pro/VIP blocking; dashboard referral visibility; live dedicated-number registration acceptance and staging redeploy. These are not represented as completed by this patch.

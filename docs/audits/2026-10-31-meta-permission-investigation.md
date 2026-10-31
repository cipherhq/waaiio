# Staging Meta add-number permission investigation

Read-only investigation, 2026-10-31. Application revision cbaf520ff6005e6a20da6bdbeb9f7e3b4261798a; observed failing requests ran a47e926696d217c4c6be4ad896bf9d6a625c431a, with unchanged provider request logic.

## Verified evidence

- Three staging add-number requests at 14:29:52, 14:30:02, and 14:30:28 UTC failed at Meta POST phone_numbers, before OTP, with code 200, OAuthException, no subcode. Latest provider trace APnyHu9q4CayOEgUktnfHdJ.
- Fresh Graph debug_token: staging and production credentials are valid SYSTEM_USER tokens with no expiry. They belong to separate staging/production apps and target separate approved, business-verified Messaging accounts owned by the same portfolio.
- Staging scopes: whatsapp_business_management, whatsapp_business_messaging, public_profile. Production additionally has business_management, manage_app_solution, whatsapp_business_manage_events.
- Graph assigned_users confirms staging system user MANAGE on staging Messaging account.
- Authenticated Meta Business Settings: Waaiio Staging has Employee role and full access to the staging app, waaiiogeneral WhatsApp account, and waaiio-staging Messaging account. The WhatsApp permission dialog explicitly enables phone-number view/manage (including adding and deleting numbers), Messages, and Everything. No evidence supports promoting this system user to Admin.
- Staging token-generation wizard offers manage_app_solution, whatsapp_business_manage_events, and the two required WhatsApp scopes; business_management is absent. No token was generated.
- Staging app Permissions and features lists business_management with Add to App Review. Production lists it with App Review rejected, despite the deployed production token containing that scope. Therefore production is not proof of advanced-access approval or successful new-number onboarding.
- Official Meta get-started step 5 lists business_management plus both WhatsApp scopes, and full control of app and WhatsApp account. Read in authenticated browser: https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started/
- Official account-model documentation says existing IDs/endpoints continue working, with the legacy account ID now identifying the Messaging account. https://developers.facebook.com/documentation/business-messaging/whatsapp/account-model-evolution/

## Conclusion and bounded next step

Confirmed configuration gap: staging lacks business_management in the deployed token and cannot currently select it in the staging token wizard. Generic Meta code 200 does not conclusively prove this is the sole cause. Full asset access is verified; invalid-token and missing assigned-phone-access hypotheses are not supported.

Enable/request business_management for the existing staging app as allowed by Meta, issue a replacement token for the same staging system user retaining both WhatsApp scopes, verify its scopes/app identity, install only in staging and redeploy, then run one user-authorized fresh-number attempt. If it still fails, preserve the new provider trace and investigate endpoint/account eligibility without switching to production credentials or broadening the user role. App Review requirements must be determined from Meta rather than assumed from the production token.

Independent evidence checkpoint agreed that the scope gap is verified but causation requires the scope-only correction and a fresh attempt. No app settings, assignments, tokens, phone numbers, or production resources were changed. The owner-only temporary token file was deleted in finally immediately after Graph reads.

## Authorized staging token correction

Owner authorized adding business_management and generated the replacement token in Meta. On resuming the browser, the staging app already showed business_management Ready for testing; the refreshed token wizard offered it. The agent selected it alongside the existing two WhatsApp scopes and handed generation to the Owner.

Fresh debug_token on the generated credential confirmed valid SYSTEM_USER, app 1722212455524293, unchanged system user 122103723873472736, no expiry, and business_management + whatsapp_business_management + whatsapp_business_messaging + public_profile. Updated only staging META_CLOUD_ACCESS_TOKEN (existing environment ID t0WKwF0brRgrrUjj, live target within waaiiostaging). Temporary credential file deleted immediately after installation.

Staging redeployment dpl_DnDajjdb2PXDB9s65Bd5GvH3Mq4R uses unchanged application SHA cbaf520ff6005e6a20da6bdbeb9f7e3b4261798a. No production token, account assignment, user role, or app setting was changed. Actual fresh-number acceptance remains to be verified by the Owner’s number test.

Deployment verification at approximately 14:54 UTC: READY, staging.waaiio.com alias points to dpl_DnDajjdb2PXDB9s65Bd5GvH3Mq4R at cbaf520ff6005e6a20da6bdbeb9f7e3b4261798a. Read-back from Vercel revalidated against Meta: correct staging app/system user and all three scopes. Read-back temporary file deleted. GET health 200/ok; connect redirects unauthenticated visitors to login; unauthenticated add-number POST 401. New-deployment error query returned no matching logs. CI run 41210246306 has all 12 jobs successful, including both migration shards and Playwright smoke; this job status is not a claim of individual-test execution counts. Agent did not send OTP or certify fresh-number registration.

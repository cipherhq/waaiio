## 2026-11-15 — Keep Default Reply from intercepting menu selections (#1055)

- Exclude existing deterministic button/list selections and menu tokens from the Default Reply fallback at greeting/capability selection. Let the existing executor validate selections and enforce current capability access.
- Preserve configured fallback for unknown free text, existing keyword handling, session concurrency controls and configuration caching. No new customer copy, payment changes or hosted settings updates.
- Real BotService/executor regressions cover scheduling and appointment buttons/lists/typed tokens, numeric selection, invalid and unavailable choices, capability denial, unknown free text and absent fallback. Valid selections are validated once; invalid selections cannot advance merely because fallback is skipped.

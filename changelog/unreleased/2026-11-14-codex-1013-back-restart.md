## 2026-11-14 — Close Custom Flow on a Back-button restart

- Changed `lib/bot/handlers/escape-hatches.ts` to pass the existing internal restart flag when Back at a free-text step has no previous step.
- Affects normal-bot restarts with a concurrent Custom Flow session: the custom session closes so the next typed answer reaches the normal bot.
- Preserves existing provenance, customer wording, and navigation with history. No migration or payment changes.
- Regression coverage exercises the real escape handler and subsequent bot routing. Risk: routing of the next answer after a no-history Back restart.

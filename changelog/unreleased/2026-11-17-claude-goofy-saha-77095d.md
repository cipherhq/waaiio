## 2026-11-17 — Custom flow builder: start screen, inline list entries, edit everything in place (#1107)

**What changed**
- **Start screen.** A new flow begins with "What should people be able to do?". The ticks are: See the schedule, Find an artist, Find a vendor, Badge pickup, FAQs, Getting here, Buy tickets, plus the merchant's own. They build the buttons, steps and empty lists through the existing requests: setup, data `create_table`, flow `save`. A template's own ticks, left as they are, send exactly today's requests. Unticking a festival section turns it off with the existing `toggleSection`. Files: `lib/custom-flow-builder/abilities.ts`, `components/custom-flows/FlowSetup.tsx`.
- **Inline entries.** Every "Search my list" step shows its entries, with:
  - "+ Add <item>", "Save and add another", Edit, and Delete after an inline confirmation;
  - "Rename fields", which changes labels only and keeps column names;
  - a "Not shown yet: add …" hint on incomplete entries.

  Writes use only the existing `/api/custom-flows/data` actions. Files: `components/custom-flows/ListEntries.tsx`, `FlowBuilder.tsx`, `FlowMap.tsx`, and `TableEditor.tsx` (`reloadKey`).
- **Edit in place.** Every step has Edit, including in guided flows. Outside the advanced editor only words change: messages, button names, prompts and replies. Adding, removing, moving and reconnecting steps stay behind the advanced editor. In guided flows the "Add a step" column becomes a short note with an "Open advanced editor" button. Renaming a guided section's button also updates its section label (`renameButton` in `templates.ts`), so turning the section off and on still works. A list or message step reached by one button is titled by that button (`stepLabel` in `block-label.ts`). Stored list names never change.
- **Search, browse or both.** A list step has an optional `mode` (`types.ts`, `definition.ts`, the builder's `readDraft`, `engine.ts`, `LookupSettings.tsx`). Without `mode` the engine runs exactly as before. Browse sends the entries as a numbered list, and a number or code answers.
- **Engine fix.** After someone picked from "I found a few matches", the session write used a stale version. They got the reply, but the menu never followed, and the step stayed stuck. `clearLookupCandidates` now returns the session at its new version (`engine.ts`).
- **Live preview.** With a list step open, the phone shows its opening message (with the browse list) and the entry being typed as if someone searched for it. The composer tests a word against the saved entries in the browser, using the engine's matching rules (`live-preview.ts`, `WhatsAppPreview.tsx`).

**What it affects:** the Custom Flows builder (Premium add-on #1013) and the custom flow engine's list step.

**What could break**
- Step titles in the builder now follow button names, for example "3. Say goodbye" instead of "3. Send a message".
- A disambiguation pick now moves on to the next step, as the code always intended.
- Entries save straight away to the live flow, the same as the Lists editor.
- No stored definition, table, API action or migration changed.

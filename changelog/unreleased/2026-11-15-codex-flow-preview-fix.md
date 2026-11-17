## 2026-11-15 — Keep custom-flow preview on the current response

The preview scrolls its bounded transcript to the latest response without scrolling the editor or moving focus. Options from earlier input turns remain visible but disabled and guarded against submission; current-turn options remain usable even when followed by informational messages. Preview loading uses the existing heading with a spinner and local busy state, and failures retain the existing nearby explanation and retry controls.

Files: `components/custom-flows/FlowBuilder.tsx` and its rendered regression tests. Affects preview interaction only; draft edits, save/publish behavior, table data, server validation and the custom-flow engine stay unchanged.

Potential breakage: a turn boundary could disable a current menu or reactivate historical choices. Tests cover menu-to-lookup, lookup replies, return menus, restart, loading/error recovery, container-only scrolling and unchanged saved/publication data.

## 2026-11-15 — Descriptive Custom Flow block labels

- FlowBuilder now shares a display-only block label helper across destination options, block headings and reorder controls. Lookup labels use existing section labels or formatted table names, with generic labels for unconfigured blocks.
- Affects merchant editor navigation only; option values, node IDs, connections, saved definitions and bot runtime are unchanged.
- Regression risk: labels could misidentify a custom or unconfigured lookup. Rendered tests cover matching labels, fallback behavior and unchanged saved connections.

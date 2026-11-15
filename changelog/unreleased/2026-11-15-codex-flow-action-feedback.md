## 2026-11-15 — Custom flow action feedback beside its controls

Moves Save, Validate, Publish and Reset results beside the builder action buttons so they remain discoverable below long editors. Preview failures stay beside the preview controls, and initial loading failures stay near the flow chooser. Existing messages and status/alert semantics are retained without duplicate announcements.

Files: `components/custom-flows/FlowBuilder.tsx` and its rendered interaction tests. Affects feedback placement only; API readiness checks, publish confirmation, draft/publication state and table information remain unchanged.

Potential breakage: feedback could appear in the wrong region after switching actions; regression tests cover validation failure/success, publish cancellation/rejection, preview failure and initial load failure.

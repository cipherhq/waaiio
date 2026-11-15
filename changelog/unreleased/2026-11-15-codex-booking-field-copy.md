## 2026-11-15 — Clarify booking field units

- Label service and appointment duration and buffer inputs explicitly in minutes, and associate the visible labels with their inputs.
- Replace the appointment buffer's misleading “Enter amount” placeholder with “Enter minutes”; monetary deposit wording stays unchanged.
- Clarify appointment capacity as “Max bookings per time slot”, matching the Services editor, with an associated label in both editors.
- Duration means service length; buffer means time between appointments, without claiming a before-only or after-only gap. Slot spacing and advance-booking limits are separate settings and are unchanged.
- Copy and accessibility-label changes only: values, defaults, constraints, payloads and scheduling behavior are unchanged. Rendered tests cover units, label associations, existing numeric constraints and local edits without writes.

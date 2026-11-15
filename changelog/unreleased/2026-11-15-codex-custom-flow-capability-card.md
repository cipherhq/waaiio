## 2026-11-15 — Show Custom Flows in capability settings

Adds the existing Custom Flows catalog entry to the Operations group on the capabilities page. Its existing label, description, plan restriction, enable/disable behavior and Save Changes endpoint are reused.

Files: capability page group membership and rendered regression tests. No entitlement, default capability, server configuration, flow content or publication behavior changes.

Potential breakage: a catalog entry could be omitted or duplicated, or plan restrictions bypassed; tests cover complete rendered catalog coverage, enable/disable payloads and the existing upgrade restriction.

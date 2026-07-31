#!/usr/bin/env python3
"""Validates the CAP-001 inventory baseline for structural correctness."""
import json, os, sys, subprocess

DIR = os.path.dirname(os.path.abspath(__file__))
SHA = "2e659dcd131ad06eb0b8f39adc8735bf337056ea"
REQUIRED_KEYS = {"id", "name", "type", "domain", "paths", "source_commit", "structurally_present",
                 "registered_or_reachable", "gate_types", "related_capabilities", "related_roles",
                 "related_database_objects", "related_providers", "test_references",
                 "confidence", "evidence_method", "unresolved_questions"}

errors = []
list_count_validated = 0
structured_sha_validated = 0
structured_count_validated = 0

# ── 1. All JSON files parse ──
json_files = sorted(f for f in os.listdir(DIR) if f.endswith('.json'))
for fname in json_files:
    try:
        json.load(open(os.path.join(DIR, fname)))
    except Exception as e:
        errors.append(f"PARSE: {fname}: {e}")

# ── 2. List records have required common keys ──
LIST_FILES = ["applications.json", "pages.json", "api-routes.json", "capabilities.json",
              "services.json", "payment-providers.json", "webhooks.json", "scheduled-jobs.json",
              "edge-functions.json", "tests.json", "documentation-discrepancies.json"]

for fname in LIST_FILES:
    data = json.load(open(os.path.join(DIR, fname)))
    if not isinstance(data, list):
        errors.append(f"TYPE: {fname} is not a list")
        continue
    for i, rec in enumerate(data):
        missing = REQUIRED_KEYS - set(rec.keys())
        if missing:
            errors.append(f"KEYS: {fname}[{i}] ({rec.get('id','?')}) missing: {missing}")
        if rec.get("source_commit") != SHA:
            errors.append(f"SHA: {fname}[{i}] ({rec.get('id','?')}) has source_commit={rec.get('source_commit')}")

# ── 3. Structured summaries have source_commit ──
STRUCTURED_FILES = ["plans-and-pricing.json", "database-declarations.json", "roles-and-permissions.json",
                     "feature-controls.json", "notifications.json", "analytics-and-monitoring.json"]
for fname in STRUCTURED_FILES:
    data = json.load(open(os.path.join(DIR, fname)))
    if data.get("source_commit") != SHA:
        errors.append(f"SHA: {fname} has source_commit={data.get('source_commit')}")
    else:
        structured_sha_validated += 1

# ── 4. Manifest counts match ──
manifest = json.load(open(os.path.join(DIR, "manifest.json")))
if manifest.get("source_commit") != SHA:
    errors.append(f"SHA: manifest.json has source_commit={manifest.get('source_commit')}")

# 4a. Record-list counts: compare manifest record_count with len(data)
for fname, meta in manifest["inventory_files"].items():
    data = json.load(open(os.path.join(DIR, fname)))
    if meta["type"] == "record_list":
        actual = len(data)
        if actual != meta["record_count"]:
            errors.append(f"COUNT: {fname} manifest says {meta['record_count']} but list has {actual} records")
        else:
            list_count_validated += 1

# 4b. Structured-summary counts: derive from each file's own structure
STRUCTURED_COUNT_DERIVATIONS = {
    "analytics-and-monitoring.json": {
        "description": "number of top-level monitoring/analytics system keys (posthog, sentry)",
        "extract": lambda d: len([k for k in ("posthog", "sentry") if k in d]),
    },
    "database-declarations.json": {
        "description": "tables.unique_declared_table_names",
        "extract": lambda d: d["tables"]["unique_declared_table_names"],
    },
    "feature-controls.json": {
        "description": "len(control_types)",
        "extract": lambda d: len(d["control_types"]),
    },
    "notifications.json": {
        "description": "email.template_count (cross-checked with len(email.templates))",
        "extract": lambda d: d["email"]["template_count"],
        "cross_check": lambda d: len(d["email"]["templates"]),
    },
    "plans-and-pricing.json": {
        "description": "len(tier_type.values)",
        "extract": lambda d: len(d["tier_type"]["values"]),
    },
    "roles-and-permissions.json": {
        "description": "len(platform_admin_roles.values) + len(business_roles.values)",
        "extract": lambda d: len(d["platform_admin_roles"]["values"]) + len(d["business_roles"]["values"]),
    },
}

for fname, derivation in STRUCTURED_COUNT_DERIVATIONS.items():
    if fname not in manifest["inventory_files"]:
        errors.append(f"MANIFEST: {fname} missing from manifest")
        continue
    meta = manifest["inventory_files"][fname]
    data = json.load(open(os.path.join(DIR, fname)))
    try:
        computed = derivation["extract"](data)
    except (KeyError, TypeError) as e:
        errors.append(f"DERIVE: {fname} count extraction failed: {e} (derivation: {derivation['description']})")
        continue
    if computed != meta["record_count"]:
        errors.append(f"COUNT: {fname} manifest says {meta['record_count']} but derived {computed} from {derivation['description']}")
    else:
        structured_count_validated += 1
    # Optional cross-check
    if "cross_check" in derivation:
        cross = derivation["cross_check"](data)
        if cross != computed:
            errors.append(f"CROSS: {fname} primary count {computed} != cross-check {cross}")

# ── 5. Records are deterministically sorted (list files sorted by id) ──
for fname in LIST_FILES:
    data = json.load(open(os.path.join(DIR, fname)))
    ids = [r["id"] for r in data]
    if ids != sorted(ids):
        errors.append(f"SORT: {fname} records not sorted by id")

# ── 6. No credentials ──
result = subprocess.run(["grep", "-rli", "--exclude=validate-inventory.py",
                        "sk_live\\|sk_test\\|eyJhbG\\|PRIVATE KEY", DIR],
                       capture_output=True, text=True)
if result.stdout.strip():
    errors.append(f"CRED: Potential credentials found in {result.stdout.strip()}")

# ── Report ──
total_manifest_validated = list_count_validated + structured_count_validated
total_manifest_entries = len(manifest["inventory_files"])

if errors:
    print(f"VALIDATION FAILED: {len(errors)} error(s)")
    for e in errors:
        print(f"  {e}")
    sys.exit(1)
else:
    print("VALIDATION PASSED")
    print(f"  {len(json_files)} JSON files parsed")
    print(f"  {len(LIST_FILES)} list files schema-validated (common keys + source SHA)")
    print(f"  {list_count_validated}/{len(LIST_FILES)} list record counts validated against manifest")
    print(f"  {structured_sha_validated}/{len(STRUCTURED_FILES)} structured summaries source SHA validated")
    print(f"  {structured_count_validated}/{len(STRUCTURED_COUNT_DERIVATIONS)} structured summary counts derived and validated")
    print(f"  {total_manifest_validated}/{total_manifest_entries} total manifest entry counts validated")
    print(f"  All list records sorted by id")
    print(f"  No credentials detected")

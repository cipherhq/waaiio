#!/usr/bin/env python3
"""Validates the CAP-001 inventory baseline for structural correctness."""
import json, os, sys

DIR = os.path.dirname(os.path.abspath(__file__))
SHA = "2e659dcd131ad06eb0b8f39adc8735bf337056ea"
REQUIRED_KEYS = {"id", "name", "type", "domain", "paths", "source_commit", "structurally_present",
                 "registered_or_reachable", "gate_types", "related_capabilities", "related_roles",
                 "related_database_objects", "related_providers", "test_references",
                 "confidence", "evidence_method", "unresolved_questions"}

errors = []

# 1. All JSON files parse
json_files = sorted(f for f in os.listdir(DIR) if f.endswith('.json'))
for fname in json_files:
    try:
        json.load(open(os.path.join(DIR, fname)))
    except Exception as e:
        errors.append(f"PARSE: {fname}: {e}")

# 2. List records have required common keys
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

# 3. Structured summaries have source_commit
STRUCTURED_FILES = ["plans-and-pricing.json", "database-declarations.json", "roles-and-permissions.json",
                     "feature-controls.json", "notifications.json", "analytics-and-monitoring.json"]
for fname in STRUCTURED_FILES:
    data = json.load(open(os.path.join(DIR, fname)))
    if data.get("source_commit") != SHA:
        errors.append(f"SHA: {fname} has source_commit={data.get('source_commit')}")

# 4. Manifest counts match
manifest = json.load(open(os.path.join(DIR, "manifest.json")))
if manifest.get("source_commit") != SHA:
    errors.append(f"SHA: manifest.json has source_commit={manifest.get('source_commit')}")

for fname, meta in manifest["inventory_files"].items():
    data = json.load(open(os.path.join(DIR, fname)))
    if meta["type"] == "record_list":
        actual = len(data)
        if actual != meta["record_count"]:
            errors.append(f"COUNT: {fname} manifest says {meta['record_count']} but file has {actual}")

# 5. Records are deterministically sorted (list files sorted by id)
for fname in LIST_FILES:
    data = json.load(open(os.path.join(DIR, fname)))
    ids = [r["id"] for r in data]
    if ids != sorted(ids):
        errors.append(f"SORT: {fname} records not sorted by id")

# 6. No credentials
import subprocess
result = subprocess.run(["grep", "-rli", "--exclude=validate-inventory.py",
                        "sk_live\\|sk_test\\|eyJhbG\\|PRIVATE KEY", DIR],
                       capture_output=True, text=True)
if result.stdout.strip():
    errors.append(f"CRED: Potential credentials found in {result.stdout.strip()}")

# Report
if errors:
    print(f"VALIDATION FAILED: {len(errors)} error(s)")
    for e in errors:
        print(f"  {e}")
    sys.exit(1)
else:
    print(f"VALIDATION PASSED")
    print(f"  {len(json_files)} JSON files parsed")
    print(f"  {len(LIST_FILES)} list files checked for common keys")
    print(f"  {len(STRUCTURED_FILES)} structured files checked for source SHA")
    print(f"  {len(manifest['inventory_files'])} manifest entries verified")
    print(f"  All list records sorted by id")
    print(f"  No credentials detected")

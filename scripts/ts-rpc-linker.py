#!/usr/bin/env python3
"""
ts-rpc-linker.py — Map TypeScript .rpc() calls to SQL function definitions.

Closes the TS↔SQL cross-boundary gap that Graphify's AST extractor cannot
detect.  Produces a dependency map showing which TS files call which Supabase
RPCs and where those RPCs are defined in migrations.

Usage:
    python3 scripts/ts-rpc-linker.py                # human-readable report
    python3 scripts/ts-rpc-linker.py --json          # machine-readable JSON
    python3 scripts/ts-rpc-linker.py --check <rpc>   # check a specific RPC

No external dependencies.  Runs on Python 3.8+.
"""

import argparse
import json
import os
import re
import sys
from collections import defaultdict

RPC_CALL_RE = re.compile(r"\.rpc\(\s*['\"]([a-z_]+)['\"]")
# Multi-line pattern: .rpc(\n  'name' — common in formatted code
RPC_MULTILINE_RE = re.compile(r"\.rpc\(\s*$")
SQL_FUNC_RE = re.compile(
    r"CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z_]+)",
    re.IGNORECASE,
)
RELEASE_GATE_RPCS = {
    "initialize_terminal_effects": "DB-006, PAY-006",
    "finalize_payment_confirmation": "DB-006, PAY-006",
    "accept_saved_card_offer": "DB-004",
    "decline_saved_card_offer": "DB-004",
    "create_provider_consented_offer": "DB-004",
}

SKIP_DIRS = {"node_modules", ".next", ".git", "__pycache__", "graphify-out"}


def find_rpc_calls(root):
    """Scan TS/TSX files for .rpc('name') calls."""
    ts_to_rpcs = defaultdict(list)
    rpc_name_only = re.compile(r"^\s*['\"]([a-z_]+)['\"]")
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fname in filenames:
            if not (fname.endswith(".ts") or fname.endswith(".tsx")):
                continue
            filepath = os.path.join(dirpath, fname)
            rel = os.path.relpath(filepath, root)
            is_test = "__tests__" in rel or ".test." in rel
            try:
                with open(filepath) as f:
                    lines = f.readlines()
                for lineno, line in enumerate(lines, 1):
                    # Single-line match: .rpc('name'
                    for m in RPC_CALL_RE.finditer(line):
                        ts_to_rpcs[rel].append(
                            {"rpc": m.group(1), "line": lineno, "is_test": is_test}
                        )
                    # Multi-line match: .rpc(\n  'name'
                    if RPC_MULTILINE_RE.search(line) and lineno < len(lines):
                        next_line = lines[lineno]  # 0-indexed = lineno
                        nm = rpc_name_only.match(next_line)
                        if nm:
                            ts_to_rpcs[rel].append(
                                {"rpc": nm.group(1), "line": lineno, "is_test": is_test}
                            )
            except (OSError, UnicodeDecodeError):
                pass
    return ts_to_rpcs


def find_sql_definitions(migrations_dir):
    """Scan migration SQL files for CREATE FUNCTION definitions."""
    rpc_to_sql = defaultdict(list)
    if not os.path.isdir(migrations_dir):
        return rpc_to_sql
    for fname in sorted(os.listdir(migrations_dir)):
        if not fname.endswith(".sql"):
            continue
        filepath = os.path.join(migrations_dir, fname)
        try:
            content = open(filepath).read()
            lines = content.split("\n")
        except (OSError, UnicodeDecodeError):
            continue
        for lineno, line in enumerate(lines, 1):
            m = SQL_FUNC_RE.search(line)
            if m:
                func_name = m.group(1)
                rpc_to_sql[func_name].append(
                    {
                        "file": fname,
                        "line": lineno,
                    }
                )
    return rpc_to_sql


def build_map(root="."):
    ts_to_rpcs = find_rpc_calls(root)
    migrations_dir = os.path.join(root, "supabase", "migrations")
    rpc_to_sql = find_sql_definitions(migrations_dir)

    all_rpc_names = set()
    for calls in ts_to_rpcs.values():
        for c in calls:
            all_rpc_names.add(c["rpc"])

    orphan_rpcs = all_rpc_names - set(rpc_to_sql.keys())
    uncalled_sql = set(rpc_to_sql.keys()) - all_rpc_names

    return {
        "ts_to_rpcs": dict(ts_to_rpcs),
        "rpc_to_sql": {k: v for k, v in rpc_to_sql.items()},
        "orphan_rpcs": sorted(orphan_rpcs),
        "uncalled_sql_functions": len(uncalled_sql),
        "stats": {
            "ts_files_with_rpc_calls": len(ts_to_rpcs),
            "unique_rpc_names": len(all_rpc_names),
            "sql_function_definitions": len(rpc_to_sql),
            "matched": len(all_rpc_names - orphan_rpcs),
            "orphan_ts_calls": len(orphan_rpcs),
        },
    }


def check_rpc(dep_map, rpc_name):
    """Check a single RPC: who calls it, where is it defined."""
    callers = []
    for ts_file, calls in dep_map["ts_to_rpcs"].items():
        for c in calls:
            if c["rpc"] == rpc_name:
                callers.append({"file": ts_file, "line": c["line"], "is_test": c["is_test"]})
    sql_defs = dep_map["rpc_to_sql"].get(rpc_name, [])
    invariant = RELEASE_GATE_RPCS.get(rpc_name, None)
    return {
        "rpc": rpc_name,
        "invariant": invariant,
        "sql_definitions": sql_defs,
        "ts_callers": callers,
        "production_callers": [c for c in callers if not c["is_test"]],
    }


def print_report(dep_map):
    stats = dep_map["stats"]
    print("TS → Supabase RPC Dependency Map (discovery candidates, not deployed identity)")
    print(f"  TS files with RPC calls: {stats['ts_files_with_rpc_calls']}")
    print(f"  Unique RPC names called: {stats['unique_rpc_names']}")
    print(f"  SQL function definitions: {stats['sql_function_definitions']}")
    print(f"  Matched:                  {stats['matched']}")
    print(f"  Orphan TS calls:          {stats['orphan_ts_calls']}")
    if dep_map["orphan_rpcs"]:
        print(f"\n  Orphan RPCs (no SQL definition): {', '.join(dep_map['orphan_rpcs'])}")

    print(f"\nRelease Gate V2 high-risk RPCs:")
    for rpc_name, invariants in RELEASE_GATE_RPCS.items():
        info = check_rpc(dep_map, rpc_name)
        prod_callers = info["production_callers"]
        sql_defs = info["sql_definitions"]
        latest_sql = sql_defs[-1] if sql_defs else None
        print(f"  {rpc_name} [{invariants}]")
        print(f"    SQL: {latest_sql['file']}:{latest_sql['line']}" if latest_sql else "    SQL: NOT FOUND")
        if prod_callers:
            for c in prod_callers:
                print(f"    ← {c['file']}:{c['line']}")
        else:
            print("    ← (no direct production callers — may use dynamic RPC name)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="Output JSON")
    parser.add_argument("--check", metavar="RPC", help="Check a specific RPC name")
    parser.add_argument("--root", default=".", help="Repository root (default: .)")
    args = parser.parse_args()

    dep_map = build_map(args.root)

    if args.check:
        result = check_rpc(dep_map, args.check)
        if args.json:
            print(json.dumps(result, indent=2))
        else:
            print(f"RPC: {result['rpc']}")
            if result["invariant"]:
                print(f"Invariant: {result['invariant']}")
            print(f"SQL definitions (discovery candidates, not deployed identity):")
            for s in result["sql_definitions"]:
                print(f"  {s['file']}:{s['line']}")
            print(f"Production callers: {len(result['production_callers'])}")
            for c in result["production_callers"]:
                print(f"  {c['file']}:{c['line']}")
            print(f"Test callers: {len(result['ts_callers']) - len(result['production_callers'])}")
    elif args.json:
        print(json.dumps(dep_map, indent=2))
    else:
        print_report(dep_map)


if __name__ == "__main__":
    main()

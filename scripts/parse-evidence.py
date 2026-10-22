#!/usr/bin/env python3
"""
Allowlisted Playwright JSON evidence parser.

Reads Playwright JSON reporter output files (*-results.json) and produces
a strictly allowlisted evidence.json with only: test title, execution status,
duration, and retry count. No error messages, URLs, stack traces, or credentials.

Required reports:
  - auth-boundaries-results.json: ALWAYS required (≥1 parsed test)
  - authenticated-results.json: required when --require-auth-tests is passed
    (≥1 non-skipped executed test)

Exit codes:
  0 — evidence generated successfully, all statuses known, required reports present
  1 — evidence generation failed (parse errors, unknown/interrupted/timedOut statuses,
      missing required reports, or empty results)

Usage:
  python3 scripts/parse-evidence.py [--output-dir DIR] [--require-auth-tests]
"""

import json
import glob
import os
import sys

EXECUTION_STATUSES = {'passed', 'failed', 'timedOut', 'interrupted', 'skipped'}


def collect_specs(suite, is_auth, results, state):
    """Recursively collect specs from nested suites."""
    for spec in suite.get('specs', []):
        for test_entry in spec.get('tests', []):
            test_results = test_entry.get('results', [])
            if test_results:
                # Use LAST result (final retry), not first
                final_result = test_results[-1]
                exec_status = final_result.get('status', 'unknown')
            else:
                exec_status = 'skipped'

            if exec_status not in EXECUTION_STATUSES:
                state['parse_errors'].append(
                    f"Unknown status '{exec_status}' for '{spec.get('title', '?')}'")
                exec_status = 'unknown'

            entry = {
                'title': spec.get('title', 'unnamed')[:200],
                'status': exec_status,
                'duration_ms': int(test_results[-1].get('duration', 0)) if test_results else 0,
                'retries': len(test_results) - 1 if test_results else 0,
            }
            results.append(entry)

            if is_auth and exec_status != 'skipped':
                state['auth_tests_actually_ran'] = True

    for child in suite.get('suites', []):
        collect_specs(child, is_auth, results, state)


def parse_evidence(output_dir='staging-qa-summary', require_auth_tests=False):
    results = []
    state = {
        'auth_tests_actually_ran': False,
        'parse_errors': [],
        'files_found': 0,
        'auth_boundary_tests': 0,
        'authenticated_tests': 0,
        'authenticated_executed': 0,
    }

    for filepath in sorted(glob.glob('*-results.json')):
        is_auth_suite = 'authenticated' in filepath
        is_auth_boundary = 'auth-boundaries' in filepath
        state['files_found'] += 1
        suite_test_count = 0
        try:
            with open(filepath) as fh:
                data = json.load(fh)
            if not isinstance(data, dict) or 'suites' not in data:
                state['parse_errors'].append(f"Malformed report structure in {filepath}")
                continue
            before = len(results)
            for suite in data.get('suites', []):
                collect_specs(suite, is_auth_suite, results, state)
            suite_test_count = len(results) - before
        except (json.JSONDecodeError, KeyError, IndexError) as e:
            state['parse_errors'].append(f"Failed to parse {filepath}: {e}")

        if is_auth_boundary:
            state['auth_boundary_tests'] += suite_test_count
        if is_auth_suite:
            state['authenticated_tests'] += suite_test_count
            state['authenticated_executed'] += sum(
                1 for r in results[len(results) - suite_test_count:]
                if r['status'] != 'skipped'
            )

    # Count statuses
    passed = sum(1 for r in results if r['status'] == 'passed')
    failed = sum(1 for r in results if r['status'] == 'failed')
    skipped = sum(1 for r in results if r['status'] == 'skipped')
    timed_out = sum(1 for r in results if r['status'] == 'timedOut')
    interrupted = sum(1 for r in results if r['status'] == 'interrupted')
    unknown = sum(1 for r in results if r['status'] == 'unknown')

    # Determine evidence validity — fail closed on ANY problem
    evidence_valid = True

    # Required report: auth-boundaries-results.json (always)
    if not os.path.exists('auth-boundaries-results.json'):
        state['parse_errors'].append(
            "Required report auth-boundaries-results.json is missing")
        evidence_valid = False
    elif state['auth_boundary_tests'] == 0:
        state['parse_errors'].append(
            "auth-boundaries-results.json exists but contains zero tests")
        evidence_valid = False

    # Required report: authenticated-results.json (when auth tests requested)
    if require_auth_tests:
        if not os.path.exists('authenticated-results.json'):
            state['parse_errors'].append(
                "Required report authenticated-results.json is missing "
                "(auth tests were requested)")
            evidence_valid = False
        elif state['authenticated_executed'] == 0:
            state['parse_errors'].append(
                "authenticated-results.json has zero non-skipped executed tests "
                "(auth tests were requested but none actually ran)")
            evidence_valid = False

    if state['files_found'] == 0:
        state['parse_errors'].append("No result files found — tests may not have run")
        evidence_valid = False
    if len(results) == 0 and state['files_found'] > 0:
        state['parse_errors'].append("Result files exist but contain zero test entries")
        evidence_valid = False
    if state['parse_errors']:
        evidence_valid = False
    if unknown > 0:
        evidence_valid = False
    if interrupted > 0:
        evidence_valid = False
    if timed_out > 0:
        evidence_valid = False

    summary = {
        'source_sha': os.environ.get('GITHUB_SHA', 'unknown'),
        'deployment_sha': os.environ.get('E2E_DEPLOYMENT_SHA', 'not provided'),
        'total': len(results),
        'passed': passed,
        'failed': failed,
        'skipped': skipped,
        'timed_out': timed_out,
        'interrupted': interrupted,
        'unknown': unknown,
        'auth_tests_executed': state['auth_tests_actually_ran'],
        'evidence_valid': evidence_valid,
        'parse_errors': len(state['parse_errors']),
        'parse_error_details': state['parse_errors'][:10],
        'tests': results,
    }

    os.makedirs(output_dir, exist_ok=True)
    with open(os.path.join(output_dir, 'evidence.json'), 'w') as out:
        json.dump(summary, out, indent=2)

    if state['parse_errors']:
        print("EVIDENCE ERRORS:", file=sys.stderr)
        for err in state['parse_errors']:
            print(f"  - {err}", file=sys.stderr)

    return evidence_valid


if __name__ == '__main__':
    output_dir = 'staging-qa-summary'
    require_auth = False

    if '--output-dir' in sys.argv:
        idx = sys.argv.index('--output-dir')
        if idx + 1 < len(sys.argv):
            output_dir = sys.argv[idx + 1]

    if '--require-auth-tests' in sys.argv:
        require_auth = True

    # Also accept via env var (safe — not from user input interpolation)
    if os.environ.get('E2E_REQUIRE_AUTH_TESTS', '').lower() == 'true':
        require_auth = True

    valid = parse_evidence(output_dir, require_auth)
    if not valid:
        print("::error::Evidence generation failed — see errors above", file=sys.stderr)
        sys.exit(1)

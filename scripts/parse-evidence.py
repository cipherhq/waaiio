#!/usr/bin/env python3
"""
Allowlisted Playwright JSON evidence parser.

Reads Playwright JSON reporter output files (*-results.json) and produces
a strictly allowlisted evidence.json with only: test title, execution status,
duration, and retry count. No error messages, URLs, stack traces, or credentials.

Exit codes:
  0 — evidence generated successfully, all statuses known
  1 — evidence generation failed (parse errors, unknown/interrupted/timedOut statuses,
      missing required reports, or empty results)

Usage:
  python3 scripts/parse-evidence.py [--output-dir staging-qa-summary]
"""

import json
import glob
import os
import sys

EXECUTION_STATUSES = {'passed', 'failed', 'timedOut', 'interrupted', 'skipped'}
# Statuses that indicate execution failure (not just a test assertion failure)
BLOCKING_STATUSES = {'timedOut', 'interrupted', 'unknown'}


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


def parse_evidence(output_dir='staging-qa-summary'):
    results = []
    state = {
        'auth_tests_actually_ran': False,
        'parse_errors': [],
        'files_found': 0,
    }

    for filepath in sorted(glob.glob('*-results.json')):
        is_auth_suite = 'authenticated' in filepath
        state['files_found'] += 1
        try:
            with open(filepath) as fh:
                data = json.load(fh)
            if not isinstance(data, dict) or 'suites' not in data:
                state['parse_errors'].append(f"Malformed report structure in {filepath}")
                continue
            for suite in data.get('suites', []):
                collect_specs(suite, is_auth_suite, results, state)
        except (json.JSONDecodeError, KeyError, IndexError) as e:
            state['parse_errors'].append(f"Failed to parse {filepath}: {e}")

    # Count statuses
    passed = sum(1 for r in results if r['status'] == 'passed')
    failed = sum(1 for r in results if r['status'] == 'failed')
    skipped = sum(1 for r in results if r['status'] == 'skipped')
    timed_out = sum(1 for r in results if r['status'] == 'timedOut')
    interrupted = sum(1 for r in results if r['status'] == 'interrupted')
    unknown = sum(1 for r in results if r['status'] == 'unknown')

    # Determine evidence validity — fail closed on ANY problem
    evidence_valid = True
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
    if '--output-dir' in sys.argv:
        idx = sys.argv.index('--output-dir')
        if idx + 1 < len(sys.argv):
            output_dir = sys.argv[idx + 1]

    valid = parse_evidence(output_dir)
    if not valid:
        print("::error::Evidence generation failed — see errors above", file=sys.stderr)
        sys.exit(1)

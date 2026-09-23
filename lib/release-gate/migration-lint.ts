/**
 * Release Gate V2 — Migration Lint
 *
 * Scans migration files for patterns that silently break protected
 * function attributes. Runs in CI as a pre-merge check.
 *
 * Current checks:
 * 1. CREATE OR REPLACE FUNCTION bodies calling digest() must include
 *    'extensions' in their SET search_path clause.
 * 2. CREATE OR REPLACE FUNCTION that recreates a protected function
 *    must preserve all required attributes (search_path, security).
 *
 * Escaped defect origin: #365 (M394 dropped M390's search_path fix)
 *
 * Usage:
 *   npx tsx lib/release-gate/migration-lint.ts [migration-dir]
 *   Default migration-dir: supabase/migrations/
 *
 * Exit code: 0 = pass, 1 = violations found
 *
 * @see RELEASE_GATE_V2.md §2.3 (CI Migration Lint)
 */

import { readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

export interface LintViolation {
  file: string;
  line: number;
  rule: string;
  message: string;
  severity: 'error' | 'warning';
}

/** Names of functions whose search_path is protected */
const PROTECTED_FUNCTION_NAMES = [
  'initialize_terminal_effects',
  'finalize_payment_confirmation',
];

/** Extension functions that require 'extensions' in search_path */
const EXTENSION_FUNCTIONS = [
  'digest(',
  'gen_random_uuid(',
  'encode(digest(',
  'crypt(',
  'gen_salt(',
];

/**
 * Lint a single migration file.
 */
export function lintMigration(filePath: string, content: string): LintViolation[] {
  const violations: LintViolation[] = [];
  const lines = content.split('\n');
  const fileName = filePath.split('/').pop() || filePath;

  // Track CREATE OR REPLACE FUNCTION blocks
  let inCreateFunction = false;
  let functionStartLine = 0;
  let functionName = '';
  let functionBlock = '';
  let dollarQuoteDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const upperLine = line.toUpperCase().trim();

    // Detect CREATE OR REPLACE FUNCTION start
    if (upperLine.includes('CREATE OR REPLACE FUNCTION') || upperLine.includes('CREATE FUNCTION')) {
      inCreateFunction = true;
      functionStartLine = lineNum;
      functionBlock = '';

      // Extract function name
      const match = line.match(/(?:CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?)([\w]+)/i);
      functionName = match ? match[1] : 'unknown';
    }

    if (inCreateFunction) {
      functionBlock += line + '\n';

      // Track $$ delimiters to find end of function
      const dollarMatches = line.match(/\$\$/g);
      if (dollarMatches) {
        dollarQuoteDepth += dollarMatches.length;
      }

      // Function block ends at second $$ (closing) followed by ;
      if (dollarQuoteDepth >= 2 && (upperLine.endsWith(';') || upperLine.endsWith('$$;'))) {
        // Analyze the complete function block
        analyzeFunction(fileName, functionStartLine, functionName, functionBlock, violations);

        inCreateFunction = false;
        functionBlock = '';
        dollarQuoteDepth = 0;
        functionName = '';
      }
    }
  }

  return violations;
}

function analyzeFunction(
  file: string,
  startLine: number,
  name: string,
  block: string,
  violations: LintViolation[],
): void {
  const upperBlock = block.toUpperCase();

  // Rule 1: Functions calling extension functions need 'extensions' in search_path
  const usesExtensionFunc = EXTENSION_FUNCTIONS.some(ef =>
    upperBlock.includes(ef.toUpperCase())
  );

  if (usesExtensionFunc) {
    // Check for SET search_path that includes extensions
    const searchPathMatch = block.match(/SET\s+search_path\s*=\s*([^$;]+)/i);

    if (!searchPathMatch) {
      violations.push({
        file,
        line: startLine,
        rule: 'EXTENSION_SEARCH_PATH',
        message: `Function "${name}" calls extension function (digest/crypt/gen_random_uuid) but has no SET search_path clause. Must include 'extensions' schema.`,
        severity: 'error',
      });
    } else if (!searchPathMatch[1].includes('extensions')) {
      violations.push({
        file,
        line: startLine,
        rule: 'EXTENSION_SEARCH_PATH',
        message: `Function "${name}" calls extension function but search_path="${searchPathMatch[1].trim()}" does not include 'extensions'. Production pgcrypto is in schema 'extensions'.`,
        severity: 'error',
      });
    }
  }

  // Rule 2: Recreating a protected function must preserve required attributes
  if (PROTECTED_FUNCTION_NAMES.includes(name)) {
    // Must be SECURITY DEFINER
    if (!upperBlock.includes('SECURITY DEFINER')) {
      violations.push({
        file,
        line: startLine,
        rule: 'PROTECTED_FUNCTION_SECURITY',
        message: `Protected function "${name}" must be SECURITY DEFINER.`,
        severity: 'error',
      });
    }

    // Must have search_path = public, extensions
    const searchPathMatch = block.match(/SET\s+search_path\s*=\s*([^$;]+)/i);
    if (!searchPathMatch || !searchPathMatch[1].includes('extensions')) {
      violations.push({
        file,
        line: startLine,
        rule: 'PROTECTED_FUNCTION_SEARCH_PATH',
        message: `Protected function "${name}" must have SET search_path = public, extensions. See #365 / DB-001.`,
        severity: 'error',
      });
    }
  }
}

/**
 * Historical migrations that are known to have violations but are immutable.
 * These cannot be fixed because modifying historical migrations would break
 * the migration chain. The final-state catalog check (not the lint) is
 * authoritative after all migrations are composed.
 *
 * Each entry: migration filename → reason for exemption.
 */
export const HISTORICAL_EXCEPTIONS: Record<string, string> = {
  '394_direct_order_payment_authority.sql':
    'M394 recreated initialize_terminal_effects with search_path=public (missing extensions). ' +
    'This is the #365 escaped defect. The migration is immutable; the repair is M397 (ALTER). ' +
    'Final-state catalog check is authoritative.',
};

/**
 * Lint all migration files in a directory.
 * @param onlyCandidates If provided, only lint these specific filenames (for candidate-only linting)
 */
export function lintMigrationDirectory(
  dirPath: string,
  onlyCandidates?: string[],
): LintViolation[] {
  let files = readdirSync(dirPath)
    .filter(f => f.endsWith('.sql'))
    .sort();

  if (onlyCandidates) {
    const candidateSet = new Set(onlyCandidates);
    files = files.filter(f => candidateSet.has(f));
  }

  const allViolations: LintViolation[] = [];

  for (const file of files) {
    // Skip historical exceptions — immutable migrations can't be fixed
    if (HISTORICAL_EXCEPTIONS[file]) continue;

    const fullPath = join(dirPath, file);
    const content = readFileSync(fullPath, 'utf-8');
    allViolations.push(...lintMigration(file, content));
  }

  return allViolations;
}

// ═══════════════════════════════════════════════════════════════════
// CLI entry point
// ═══════════════════════════════════════════════════════════════════

if (process.argv[1]?.endsWith('migration-lint.ts') || process.argv[1]?.endsWith('migration-lint.mjs')) {
  const dir = process.argv[2] || resolve(process.cwd(), 'supabase/migrations');

  console.log(`\n🔍 Release Gate V2 — Migration Lint`);
  console.log(`   Scanning: ${dir}\n`);

  const violations = lintMigrationDirectory(dir);

  if (violations.length === 0) {
    console.log('✅ No violations found.\n');
    process.exit(0);
  }

  const errors = violations.filter(v => v.severity === 'error');
  const warnings = violations.filter(v => v.severity === 'warning');

  for (const v of violations) {
    const icon = v.severity === 'error' ? '❌' : '⚠️';
    console.log(`${icon} ${v.file}:${v.line} [${v.rule}]`);
    console.log(`   ${v.message}\n`);
  }

  console.log(`\nSummary: ${errors.length} error(s), ${warnings.length} warning(s)`);

  if (errors.length > 0) {
    console.log('\n❌ BLOCKED — Fix migration lint errors before merge.\n');
    process.exit(1);
  }

  process.exit(0);
}
